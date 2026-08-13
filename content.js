// ============================================================================
//  Smart LUFS Normalizer Pro — v4.1
//  - AGC feed-forward có hiệu chuẩn vòng kín (chainOffsetDb)
//  - Multiband auto-makeup: trung tính khi không nén, không còn EQ tilt cố định
//  - Phantom Bass tự hiệu chuẩn theo tỉ lệ dB so với siêu trầm gốc
//  - Brickwall limiter look-ahead thật (AudioWorklet), fallback DynamicsCompressor
// ============================================================================

// --- 1. HẰNG SỐ ĐIỀU KHIỂN ---
const TICK_MS = 200;
const FFT_SIZE = 16384;              // ~341ms @48kHz — phủ trọn khoảng cách 2 lần đo
const ABS_GATE_LUFS = -55;
const DEADBAND_OPEN_DB = 1.0;
const DEADBAND_CLOSE_DB = 0.15;
const SLEW_DB_PER_SEC = 1.5;
const MAX_GAIN_DB = 24;
const LIMIT_CEILING_DB = -1.0;
const LOOKAHEAD_MS = 5;
const FAST_LOCK_TICKS = 13;          // ~2.6s đầu mỗi track

// Auto-makeup: TC ~2.5s — đủ chậm để không pump, đủ nhanh để ổn định
// trước bộ hiệu chuẩn chainOffset (TC ~10s), tránh hai vòng đuổi nhau.
const MAKEUP_ALPHA = 0.08;
const MAKEUP_MAX_DB = 12;

// Phantom Bass: mức hài ảo giác TÍNH BẰNG dB SO VỚI siêu trầm gốc bị cắt.
// Đây là đại lượng vật lý có nghĩa, không phụ thuộc đường cong waveshaper,
// nên không cần chỉnh mò bằng tai như hệ số gain tuyến tính cũ.
const PHANTOM_MIX_DB = {
    movie: -8,
    music: -12,
    night: null,        // null = tắt hẳn
    podcast: null,
    custom: null
};
const PHANTOM_GATE_DB = -50;
// Mức RMS chuẩn nạp vào waveshaper. Hài sinh ra tỉ lệ với BÌNH PHƯƠNG biên độ,
// nên nếu để mức vào tự do thì tỉ lệ hài/nền tảng thay đổi ~2:1 theo mức tín hiệu
// và vòng hiệu chuẩn phải bù tới +40dB. Ghim mức nạp => tỉ lệ hài không đổi.
const PHANTOM_DRIVE_DB = -6;

let TARGET_MIN = -16.0;
let TARGET_MAX = -12.0;

// --- 2. TRẠNG THÁI ---
let audioCtx = null;
let isInitialized = false;
let isInitializing = false;
let currentUIMode = 'podcast';
let isBypassed = false;

let preInput, chainIn, dryGain, wetGain, outBus, agcGain, sumNode;
let compLow, compMid, compHigh, gainLow, gainMid, gainHigh;
let exciterBass, mudRemoval, exciterAir, widthBoost, phantomGain, phantomGate;
let phantomProbe, phantomProbeBuf, phantomOutProbe, phantomOutBuf, phantomDrive;
let inMeter, outMeter;

let limiterNode = null;              // AudioWorkletNode hoặc DynamicsCompressor
let usingWorkletLimiter = false;
let limiterReductionDb = 0;

let inLufsSmooth = null;
let outLufsSmooth = null;
let chainOffsetDb = 0;
let currentAppliedGainDb = 0;
let isCorrecting = false;
let tickCount = 0;

const makeupDb = { low: 0, mid: 0, high: 0 };
let phantomGainDb = -40;
let phantomDriveDb = 0;

const sourceCache = new WeakMap();
let currentSource = null;
let currentElement = null;
let currentVideoId = null;
let monitorInterval = null;
let watcherInterval = null;

// --- 3. CÀI ĐẶT NGƯỜI DÙNG ---
chrome.storage.sync.get(['userTargetMin', 'userTargetMax', 'userMode', 'userBypass'], (data) => {
    if (data.userTargetMin !== undefined) TARGET_MIN = parseFloat(data.userTargetMin);
    if (data.userTargetMax !== undefined) TARGET_MAX = parseFloat(data.userTargetMax);
    if (data.userMode) currentUIMode = data.userMode;
    if (data.userBypass !== undefined) isBypassed = !!data.userBypass;
    applyAudioProfile(currentUIMode);
    applyBypass(isBypassed);
});

chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace !== 'sync') return;
    if (changes.userTargetMin) TARGET_MIN = parseFloat(changes.userTargetMin.newValue);
    if (changes.userTargetMax) TARGET_MAX = parseFloat(changes.userTargetMax.newValue);
    if (changes.userMode) {
        currentUIMode = changes.userMode.newValue;
        applyAudioProfile(currentUIMode);
    }
    if (changes.userBypass) {
        isBypassed = !!changes.userBypass.newValue;
        applyBypass(isBypassed);
    }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.type === 'GET_STATUS') {
        sendResponse({
            active: isInitialized && currentElement !== null,
            bypassed: isBypassed,
            inLufs: inLufsSmooth,
            outLufs: outLufsSmooth,
            gainDb: currentAppliedGainDb,
            chainOffsetDb: chainOffsetDb,
            limiterDb: limiterReductionDb,
            trueLimiter: usingWorkletLimiter,
            mode: currentUIMode
        });
    }
    return false;
});

// --- 4. PROFILE DSP ---
function applyAudioProfile(mode) {
    if (!isInitialized) return;
    const t = audioCtx.currentTime;
    const tc = 0.5;

    switch (mode) {
        case 'movie':
            exciterBass.gain.setTargetAtTime(6.0, t, tc);
            mudRemoval.gain.setTargetAtTime(0.0, t, tc);
            exciterAir.gain.setTargetAtTime(2.0, t, tc);
            widthBoost.gain.setTargetAtTime(1.5, t, tc);
            break;
        case 'music':
            exciterBass.gain.setTargetAtTime(4.0, t, tc);
            mudRemoval.gain.setTargetAtTime(-2.0, t, tc);
            exciterAir.gain.setTargetAtTime(3.0, t, tc);
            widthBoost.gain.setTargetAtTime(1.25, t, tc);
            break;
        case 'night':
            exciterBass.gain.setTargetAtTime(-6.0, t, tc);
            mudRemoval.gain.setTargetAtTime(0.0, t, tc);
            exciterAir.gain.setTargetAtTime(-2.0, t, tc);
            widthBoost.gain.setTargetAtTime(1.0, t, tc);
            break;
        case 'podcast':
        case 'custom':
        default:
            exciterBass.gain.setTargetAtTime(-3.0, t, tc);
            mudRemoval.gain.setTargetAtTime(-1.0, t, tc);
            exciterAir.gain.setTargetAtTime(1.0, t, tc);
            widthBoost.gain.setTargetAtTime(1.0, t, tc);
            break;
    }

    // Phantom do vòng hiệu chuẩn trong tick điều khiển; ở đây chỉ tắt hẳn nếu profile không dùng
    if (PHANTOM_MIX_DB[mode] === null || PHANTOM_MIX_DB[mode] === undefined) {
        phantomGain.gain.setTargetAtTime(0, t, tc);
        phantomGainDb = -40;
    }

    chainOffsetDb = 0; // đổi profile = đổi độ lợi chain, số hiệu chuẩn cũ hết hiệu lực
    isCorrecting = true;
    console.log(`🎛️ DSP Profile: [${String(mode).toUpperCase()}] — reset hiệu chuẩn chain`);
}

function applyBypass(on) {
    if (!isInitialized) return;
    const t = audioCtx.currentTime;
    dryGain.gain.setTargetAtTime(on ? 1 : 0, t, 0.01);
    wetGain.gain.setTargetAtTime(on ? 0 : 1, t, 0.01);
    console.log(on ? '⏸️ BYPASS: nghe tín hiệu gốc' : '▶️ ACTIVE: nghe tín hiệu đã xử lý');
}

// --- 5. WAVESHAPER (đã chuẩn hoá độ lợi) ---
function makeSaturationCurve(k, n = 8192) {
    const curve = new Float32Array(n);
    const deg = Math.PI / 180;
    const slopeAtZero = (3 + k) * 20 * deg / Math.PI;
    for (let i = 0; i < n; i++) {
        const x = (i * 2) / (n - 1) - 1;
        curve[i] = ((3 + k) * x * 20 * deg / (Math.PI + k * Math.abs(x))) / slopeAtZero;
    }
    return curve;
}

// Chuỗi hài đầy đủ (bậc 2 trội) cho ảo giác missing fundamental, độ dốc gốc = 1
function makePhantomCurve(n = 8192) {
    const curve = new Float32Array(n);
    for (let i = 0; i < n; i++) {
        const x = (i * 2) / (n - 1) - 1;
        curve[i] = x + 0.7 * x * x + 0.35 * x * x * x; // DC bị HP 100Hz cắt bỏ
    }
    return curve;
}

// --- 6. BỘ ĐO LUFS 2 KÊNH (BS.1770) ---
function createLufsMeter(inputNode) {
    const stereoForce = audioCtx.createGain();
    stereoForce.channelCount = 2;
    stereoForce.channelCountMode = 'explicit';
    stereoForce.channelInterpretation = 'speakers';

    const shelf = audioCtx.createBiquadFilter();
    shelf.type = 'highshelf';
    shelf.frequency.value = 1681.97;
    shelf.Q.value = Math.SQRT1_2;
    shelf.gain.value = 3.99;

    const hp = audioCtx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 38.13;
    hp.Q.value = 0.5;

    const splitter = audioCtx.createChannelSplitter(2);
    const aL = audioCtx.createAnalyser(); aL.fftSize = FFT_SIZE;
    const aR = audioCtx.createAnalyser(); aR.fftSize = FFT_SIZE;

    inputNode.connect(stereoForce);
    stereoForce.connect(shelf);
    shelf.connect(hp);
    hp.connect(splitter);
    splitter.connect(aL, 0);
    splitter.connect(aR, 1);

    return { aL, aR, bufL: new Float32Array(FFT_SIZE), bufR: new Float32Array(FFT_SIZE) };
}

function measureLufs(meter) {
    meter.aL.getFloatTimeDomainData(meter.bufL);
    meter.aR.getFloatTimeDomainData(meter.bufR);

    const n = meter.bufL.length;
    let sumL = 0, sumR = 0;
    for (let i = 0; i < n; i++) {
        const l = meter.bufL[i];
        const r = meter.bufR[i];
        sumL += l * l;
        sumR += r * r;
    }

    const meanSquare = sumL / n + sumR / n; // BS.1770: cộng năng lượng từng kênh
    if (meanSquare <= 0) return null;

    const lufs = -0.691 + 10 * Math.log10(meanSquare);
    return lufs < ABS_GATE_LUFS ? null : lufs;
}

function probeRmsDb(analyserNode, buf) {
    analyserNode.getFloatTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    const ms = sum / buf.length;
    return ms <= 0 ? -140 : 10 * Math.log10(ms);
}

// --- 7. KHỞI TẠO AUDIO GRAPH ---
async function initAudioGraph() {
    if (isInitialized || isInitializing) return;
    isInitializing = true;

    audioCtx = new (window.AudioContext || window.webkitAudioContext)();

    // Nạp limiter worklet TRƯỚC khi dựng graph, để không phải hot-swap gây click
    try {
        await audioCtx.audioWorklet.addModule(chrome.runtime.getURL('limiter-worklet.js'));
        usingWorkletLimiter = true;
    } catch (e) {
        usingWorkletLimiter = false;
        console.warn('⚠️ Không nạp được limiter worklet, dùng DynamicsCompressor thay thế:', e);
    }

    preInput = audioCtx.createGain();
    chainIn = audioCtx.createGain();
    preInput.connect(chainIn);

    dryGain = audioCtx.createGain();
    dryGain.gain.value = 0;
    preInput.connect(dryGain);

    // ---- MULTI-BAND: Linkwitz-Riley 24dB/oct ----
    const Q_BUTTER = Math.SQRT1_2;
    const XO_LOW = 250;
    const XO_HIGH = 4000;

    const lr = (type, freq) => {
        const f = audioCtx.createBiquadFilter();
        f.type = type;
        f.frequency.value = freq;
        f.Q.value = Q_BUTTER;
        return f;
    };

    const lowLp1 = lr('lowpass', XO_LOW), lowLp2 = lr('lowpass', XO_LOW);
    const restHp1 = lr('highpass', XO_LOW), restHp2 = lr('highpass', XO_LOW);
    chainIn.connect(lowLp1); lowLp1.connect(lowLp2);
    chainIn.connect(restHp1); restHp1.connect(restHp2);

    // LP4+HP4 tại 4kHz cộng lại = allpass bậc 2; nhánh Low phải đi qua đúng allpass đó
    const lowAllpass = lr('allpass', XO_HIGH);
    lowLp2.connect(lowAllpass);

    const midLp1 = lr('lowpass', XO_HIGH), midLp2 = lr('lowpass', XO_HIGH);
    const highHp1 = lr('highpass', XO_HIGH), highHp2 = lr('highpass', XO_HIGH);
    restHp2.connect(midLp1); midLp1.connect(midLp2);
    restHp2.connect(highHp1); highHp1.connect(highHp2);

    // Makeup gain khởi tạo UNITY. Giá trị cố định 1.25/1.4/1.1 của bản cũ là một
    // bộ EQ tilt vĩnh viễn (~+2.5dB) áp cả khi compressor không nén gì.
    // Giờ makeup bám theo mức nén thực tế => không nén thì không tô màu.
    compLow = audioCtx.createDynamicsCompressor();
    compLow.threshold.value = -24; compLow.ratio.value = 4.0;
    compLow.attack.value = 0.01; compLow.release.value = 0.1;
    gainLow = audioCtx.createGain(); gainLow.gain.value = 1.0;
    lowAllpass.connect(compLow); compLow.connect(gainLow);

    compMid = audioCtx.createDynamicsCompressor();
    compMid.threshold.value = -30; compMid.ratio.value = 3.0;
    compMid.attack.value = 0.005; compMid.release.value = 0.2;
    gainMid = audioCtx.createGain(); gainMid.gain.value = 1.0;
    midLp2.connect(compMid); compMid.connect(gainMid);

    compHigh = audioCtx.createDynamicsCompressor();
    compHigh.threshold.value = -20; compHigh.ratio.value = 6.0; // de-esser
    compHigh.attack.value = 0.001; compHigh.release.value = 0.05;
    gainHigh = audioCtx.createGain(); gainHigh.gain.value = 1.0;
    highHp2.connect(compHigh); compHigh.connect(gainHigh);

    // ---- PHANTOM BASS ----
    // Trích xuất 35–90Hz. Chặn rumble dưới 35Hz vì hài của nó rơi xuống dưới 130Hz,
    // sẽ bị bộ lọc phía sau vứt đi — sinh ra chỉ để lãng phí và thêm méo.
    const phRumble1 = lr('highpass', 35), phRumble2 = lr('highpass', 35);
    const phExtract1 = lr('lowpass', 90), phExtract2 = lr('lowpass', 90);
    chainIn.connect(phRumble1); phRumble1.connect(phRumble2);
    phRumble2.connect(phExtract1); phExtract1.connect(phExtract2);

    phantomProbe = audioCtx.createAnalyser();
    phantomProbe.fftSize = 2048;
    phantomProbeBuf = new Float32Array(phantomProbe.fftSize);
    phExtract2.connect(phantomProbe);

    // Ghim mức nạp vào waveshaper (điều khiển trong updatePhantom)
    phantomDrive = audioCtx.createGain();
    phantomDrive.gain.value = 1;
    phExtract2.connect(phantomDrive);

    const phSaturator = audioCtx.createWaveShaper();
    phSaturator.curve = makePhantomCurve();
    phSaturator.oversample = '4x';
    phantomDrive.connect(phSaturator);

    // HP bậc 8 (48dB/oct) @130Hz. Bản trước dùng 100Hz bậc 4: chỉ triệt 60Hz được
    // -18.8dB trong khi cho 120Hz qua ở -3.4dB => thứ đi qua chủ yếu là NỀN TẢNG
    // BỊ RÒ chứ không phải hài. Cấu hình này đẩy khoảng cách đó lên ~40dB.
    let phHp = phSaturator;
    for (let i = 0; i < 4; i++) {
        const f = lr('highpass', 130);
        phHp.connect(f);
        phHp = f;
    }

    // Đo mức hài SAU khi lọc, TRƯỚC gate/gain => tỉ lệ trộn tự hiệu chuẩn được
    phantomOutProbe = audioCtx.createAnalyser();
    phantomOutProbe.fftSize = 2048;
    phantomOutBuf = new Float32Array(phantomOutProbe.fftSize);
    phHp.connect(phantomOutProbe);

    phantomGate = audioCtx.createGain();
    phantomGate.gain.value = 0;
    phHp.connect(phantomGate);

    phantomGain = audioCtx.createGain();
    phantomGain.gain.value = 0;
    phantomGate.connect(phantomGain);

    // ---- SUMMING BUS ----
    sumNode = audioCtx.createGain();
    gainLow.connect(sumNode);
    gainMid.connect(sumNode);
    gainHigh.connect(sumNode);
    phantomGain.connect(sumNode);

    // ---- EXCITER / TONE ----
    exciterBass = audioCtx.createBiquadFilter();
    exciterBass.type = 'peaking'; exciterBass.frequency.value = 60;
    exciterBass.Q.value = 1.0; exciterBass.gain.value = 0;

    mudRemoval = audioCtx.createBiquadFilter();
    mudRemoval.type = 'peaking'; mudRemoval.frequency.value = 300;
    mudRemoval.Q.value = 1.0; mudRemoval.gain.value = 0;

    exciterAir = audioCtx.createBiquadFilter();
    exciterAir.type = 'highshelf'; exciterAir.frequency.value = 12000;
    exciterAir.gain.value = 0;

    sumNode.connect(exciterBass);
    exciterBass.connect(mudRemoval);
    mudRemoval.connect(exciterAir);

    // ---- ANALOG SATURATION (gain staging trung tính) ----
    const preSatGain = audioCtx.createGain();
    preSatGain.gain.value = 0.5;
    exciterAir.connect(preSatGain);

    const tubeSaturator = audioCtx.createWaveShaper();
    tubeSaturator.curve = makeSaturationCurve(1.0);
    tubeSaturator.oversample = '4x';
    preSatGain.connect(tubeSaturator);

    const postSatGain = audioCtx.createGain();
    postSatGain.gain.value = 2.0;
    tubeSaturator.connect(postSatGain);

    // ---- 3D STEREO WIDENER (Mid/Side) ----
    const splitter = audioCtx.createChannelSplitter(2);
    postSatGain.connect(splitter);

    const midSum = audioCtx.createGain();
    midSum.gain.value = 0.5;
    splitter.connect(midSum, 0);
    splitter.connect(midSum, 1);

    const sideSum = audioCtx.createGain();
    sideSum.gain.value = 0.5;
    const invR = audioCtx.createGain();
    invR.gain.value = -1.0;
    splitter.connect(sideSum, 0);
    splitter.connect(invR, 1);
    invR.connect(sideSum);

    widthBoost = audioCtx.createGain();
    widthBoost.gain.value = 1.0;
    sideSum.connect(widthBoost);

    const merger = audioCtx.createChannelMerger(2);
    const invSide = audioCtx.createGain();
    invSide.gain.value = -1.0;
    widthBoost.connect(invSide);

    midSum.connect(merger, 0, 0);
    widthBoost.connect(merger, 0, 0);
    midSum.connect(merger, 0, 1);
    invSide.connect(merger, 0, 1);

    // ---- AGC + LIMITER ----
    agcGain = audioCtx.createGain();
    merger.connect(agcGain);

    const ceilingLin = Math.pow(10, LIMIT_CEILING_DB / 20);

    if (usingWorkletLimiter) {
        limiterNode = new AudioWorkletNode(audioCtx, 'lookahead-limiter', {
            numberOfInputs: 1,
            numberOfOutputs: 1,
            outputChannelCount: [2],
            processorOptions: { lookaheadMs: LOOKAHEAD_MS }
        });
        limiterNode.parameters.get('ceiling').value = ceilingLin;
        limiterNode.parameters.get('release').value = 0.08;
        limiterNode.port.onmessage = (e) => {
            if (e.data && typeof e.data.reductionDb === 'number') limiterReductionDb = e.data.reductionDb;
        };
        console.log(`🧱 Brickwall limiter: look-ahead ${LOOKAHEAD_MS}ms @ ${LIMIT_CEILING_DB} dBFS`);
    } else {
        limiterNode = audioCtx.createDynamicsCompressor();
        limiterNode.threshold.value = LIMIT_CEILING_DB;
        limiterNode.knee.value = 3.0;
        limiterNode.ratio.value = 20.0;
        limiterNode.attack.value = 0.003;
        limiterNode.release.value = 0.25;
    }

    agcGain.connect(limiterNode);

    wetGain = audioCtx.createGain();
    wetGain.gain.value = 1;
    limiterNode.connect(wetGain);

    // ---- OUTPUT BUS ----
    outBus = audioCtx.createGain();
    wetGain.connect(outBus);
    dryGain.connect(outBus);
    outBus.connect(audioCtx.destination);

    inMeter = createLufsMeter(preInput);
    outMeter = createLufsMeter(outBus);

    isInitialized = true;
    isInitializing = false;
    applyAudioProfile(currentUIMode);
    applyBypass(isBypassed);
    console.log('✅ Smart LUFS Normalizer Pro v4.1: audio graph sẵn sàng.');
}

// --- 8. GẮN / ĐỔI NGUỒN ---
function attachSource(el) {
    if (currentElement === el) return;

    if (currentSource) {
        try { currentSource.disconnect(); } catch (e) { /* node đã rời graph */ }
    }

    let src = sourceCache.get(el);
    if (!src) {
        try {
            src = audioCtx.createMediaElementSource(el); // chỉ gọi được 1 lần / element
            sourceCache.set(el, src);
        } catch (e) {
            console.warn('⚠️ Không thể gắn vào element này:', e);
            return;
        }
    }

    src.connect(preInput);
    currentSource = src;
    currentElement = el;
    console.log('🔌 Đã gắn vào player chính.');
}

// --- 9. VÒNG ĐIỀU KHIỂN ---
function resetTrackState() {
    inLufsSmooth = null;
    outLufsSmooth = null;
    tickCount = 0;
    isCorrecting = true;
    // chainOffsetDb và makeupDb KHÔNG reset: đó là đặc tính của chain, không phải của bài
}

// Makeup bám theo mức nén trung bình dài hạn: giữ nguyên độ nén tức thời (density),
// chỉ trả lại phần âm lượng bị mất bền vững. Không nén => makeup = 0dB => không tô màu.
function updateAutoMakeup(now) {
    const bands = [
        [compLow, gainLow, 'low'],
        [compMid, gainMid, 'mid'],
        [compHigh, gainHigh, 'high']
    ];
    for (const [comp, node, key] of bands) {
        const red = comp.reduction || 0; // dB, <= 0
        const target = Math.min(MAKEUP_MAX_DB, Math.max(0, -red));
        makeupDb[key] += (target - makeupDb[key]) * MAKEUP_ALPHA;
        node.gain.setTargetAtTime(Math.pow(10, makeupDb[key] / 20), now, 0.5);
    }
}

// Tỉ lệ trộn Phantom được đặt bằng dB so với siêu trầm gốc, rồi tự tính ra hệ số
// gain cần thiết từ mức hài đo được. Đổi đường cong waveshaper không làm sai lệch
// kết quả => không phải chỉnh lại bằng tai.
function updatePhantom(now) {
    const mix = PHANTOM_MIX_DB[currentUIMode];
    const subDb = probeRmsDb(phantomProbe, phantomProbeBuf);

    if (mix === null || mix === undefined || subDb <= PHANTOM_GATE_DB) {
        phantomGate.gain.setTargetAtTime(0, now, 0.15);
        return;
    }

    // Chuẩn hoá mức nạp trước khi bóp méo. Vòng này là phản hồi âm tự ổn định:
    // drive tăng -> harmDb tăng -> gain bù giảm.
    let driveDb = PHANTOM_DRIVE_DB - subDb;
    driveDb = Math.max(-12, Math.min(40, driveDb));
    phantomDriveDb += (driveDb - phantomDriveDb) * 0.15;
    phantomDrive.gain.setTargetAtTime(Math.pow(10, phantomDriveDb / 20), now, 0.2);

    const harmDb = probeRmsDb(phantomOutProbe, phantomOutBuf);
    if (harmDb > -130) {
        let gDb = subDb + mix - harmDb;
        gDb = Math.max(-40, Math.min(MAX_GAIN_DB, gDb));
        phantomGainDb += (gDb - phantomGainDb) * 0.1;
        phantomGain.gain.setTargetAtTime(Math.pow(10, phantomGainDb / 20), now, 0.3);
    }
    phantomGate.gain.setTargetAtTime(1, now, 0.03);
}

function startMonitor() {
    if (monitorInterval) clearInterval(monitorInterval);

    monitorInterval = setInterval(() => {
        if (!isInitialized || !currentElement) return;
        if (currentElement.paused || currentElement.ended) return;

        const now = audioCtx.currentTime;

        updateAutoMakeup(now);
        updatePhantom(now);

        if (!usingWorkletLimiter) limiterReductionDb = limiterNode.reduction || 0;

        if (isBypassed) return;

        // Tôn trọng thanh volume YouTube, nếu không AGC sẽ kéo ngược lại
        const vol = currentElement.muted ? 0 : (currentElement.volume ?? 1);
        if (vol < 0.02) return;
        const volDb = 20 * Math.log10(vol);

        const inLufs = measureLufs(inMeter);
        const outLufs = measureLufs(outMeter);
        if (inLufs === null) return; // khoảng lặng: giữ nguyên gain

        tickCount++;
        const fastLock = tickCount <= FAST_LOCK_TICKS;

        const aIn = fastLock ? 0.35 : (inLufs > inLufsSmooth ? 0.07 : 0.05);
        inLufsSmooth = (inLufsSmooth === null) ? inLufs : inLufsSmooth + (inLufs - inLufsSmooth) * aIn;

        if (outLufs !== null) {
            const aOut = fastLock ? 0.35 : 0.06;
            outLufsSmooth = (outLufsSmooth === null) ? outLufs : outLufsSmooth + (outLufs - outLufsSmooth) * aOut;
        }

        // Hiệu chuẩn vòng kín: học độ lợi cố định của chain, chỉ khi hệ đứng yên
        // và limiter không can thiệp (nếu không sẽ học nhầm thành vòng lặp dương)
        const limiting = limiterReductionDb < -1.0;
        if (!fastLock && !isCorrecting && !limiting && outLufsSmooth !== null) {
            const measuredOffset = outLufsSmooth - inLufsSmooth - currentAppliedGainDb;
            chainOffsetDb += (measuredOffset - chainOffsetDb) * 0.02; // TC ~10s
            chainOffsetDb = Math.max(-MAX_GAIN_DB, Math.min(MAX_GAIN_DB, chainOffsetDb));
        }

        const effMin = TARGET_MIN + volDb;
        const effMax = TARGET_MAX + volDb;
        const base = inLufsSmooth + chainOffsetDb; // mức ra dự kiến khi gain = 0

        let desiredGainDb = 0;
        if (base < effMin) desiredGainDb = effMin - base;
        else if (base > effMax) desiredGainDb = effMax - base;
        desiredGainDb = Math.max(-MAX_GAIN_DB, Math.min(MAX_GAIN_DB, desiredGainDb));

        // Deadband có trễ: mở rộng, đóng hẹp => hội tụ được thay vì đóng băng
        const err = Math.abs(desiredGainDb - currentAppliedGainDb);
        if (!isCorrecting && err > DEADBAND_OPEN_DB) isCorrecting = true;
        else if (isCorrecting && err < DEADBAND_CLOSE_DB) isCorrecting = false;

        if (fastLock) {
            currentAppliedGainDb = desiredGainDb;
            agcGain.gain.setTargetAtTime(Math.pow(10, currentAppliedGainDb / 20), now, 0.15);
        } else if (isCorrecting) {
            const step = SLEW_DB_PER_SEC * (TICK_MS / 1000);
            const delta = desiredGainDb - currentAppliedGainDb;
            currentAppliedGainDb += Math.sign(delta) * Math.min(Math.abs(delta), step);
            agcGain.gain.setTargetAtTime(Math.pow(10, currentAppliedGainDb / 20), now, 0.12);
        }

        if (tickCount % 10 === 0) {
            console.log(
                `[AGC] IN ${inLufsSmooth.toFixed(1)} → OUT ${outLufsSmooth === null ? '--' : outLufsSmooth.toFixed(1)} LUFS | ` +
                `Gain ${currentAppliedGainDb >= 0 ? '+' : ''}${currentAppliedGainDb.toFixed(2)}dB | ` +
                `Offset ${chainOffsetDb >= 0 ? '+' : ''}${chainOffsetDb.toFixed(2)}dB | ` +
                `Makeup L/M/H ${makeupDb.low.toFixed(1)}/${makeupDb.mid.toFixed(1)}/${makeupDb.high.toFixed(1)}dB | ` +
                `Limiter ${limiterReductionDb.toFixed(1)}dB | ${isCorrecting ? 'ĐANG CHỈNH' : 'ỔN ĐỊNH'}`
            );
        }
    }, TICK_MS);
}

// --- 10. THEO DÕI PLAYER CHÍNH ---
function isPlayerPage() {
    return location.pathname.startsWith('/watch') || location.pathname.startsWith('/shorts/');
}

function getVideoId() {
    try {
        const u = new URL(location.href);
        if (u.pathname.startsWith('/shorts/')) return u.pathname.split('/')[2] || null;
        return u.searchParams.get('v');
    } catch (e) {
        return null;
    }
}

// Chỉ chấp nhận player CHÍNH — createMediaElementSource không hoàn tác được,
// gắn nhầm video preview ở trang chủ là hỏng vĩnh viễn tab đó.
function getMainVideo() {
    if (!isPlayerPage()) return null;

    const scopes = location.pathname.startsWith('/shorts/')
        ? ['ytd-reel-video-renderer[is-active]', '#shorts-player', 'ytd-shorts']
        : ['ytd-player #movie_player', '#movie_player'];

    for (const sel of scopes) {
        const host = document.querySelector(sel);
        if (!host) continue;
        const v = host.querySelector('video.html5-main-video') || host.querySelector('video');
        if (v && v.readyState >= 1) return v;
    }
    return null;
}

function syncWithPage() {
    const video = getMainVideo();
    const vid = getVideoId();

    if (!video) {
        if (currentElement) {
            if (monitorInterval) { clearInterval(monitorInterval); monitorInterval = null; }
            currentElement = null;
            currentVideoId = null;
        }
        return;
    }

    if (!isInitialized) {
        // addModule() là async; poll 500ms sẽ không gọi trùng nhờ cờ isInitializing
        if (!isInitializing) initAudioGraph().then(() => syncWithPage());
        return;
    }

    if (audioCtx.state === 'suspended') audioCtx.resume();

    const elementChanged = video !== currentElement;
    const trackChanged = vid !== currentVideoId;

    if (elementChanged) attachSource(video);

    if (elementChanged || trackChanged) {
        currentVideoId = vid;
        resetTrackState();
        startMonitor();
        console.log(`▶️ Track mới: ${vid || '(không rõ id)'}`);
    }
}

function startWatcher() {
    if (!watcherInterval) watcherInterval = setInterval(syncWithPage, 500);
    syncWithPage();
}

document.addEventListener('yt-navigate-finish', syncWithPage);
window.addEventListener('pageshow', startWatcher); // khôi phục sau bfcache

window.addEventListener('pagehide', () => {
    if (monitorInterval) { clearInterval(monitorInterval); monitorInterval = null; }
    if (watcherInterval) { clearInterval(watcherInterval); watcherInterval = null; }
});

startWatcher();
