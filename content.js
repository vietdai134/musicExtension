// ============================================================================
//  Smart LUFS Normalizer Pro — v4.5
//  - AGC feed-forward có hiệu chuẩn vòng kín (chainOffsetDb)
//  - Multiband auto-makeup: trung tính khi không nén, không còn EQ tilt cố định
//  - Phantom Bass tự hiệu chuẩn theo tỉ lệ dB so với siêu trầm gốc
//  - Brickwall limiter look-ahead thật (AudioWorklet), fallback DynamicsCompressor
//
//  v4.2 — sửa méo ("rè"): toàn bộ là lỗi gain staging, không phải lỗi thuật toán.
//   1. Waveshaper kẹp cứng input ngoài [-1,1]; drive 0.5 cho ngưỡng clip chỉ
//      +6dBFS, thấp hơn đỉnh chain thực tế. Hạ drive → headroom +14dBFS.
//   2. Trần auto-makeup 12dB x 3 băng là nguồn đẩy chain vượt headroom đó.
//   3. compLow attack 10ms ngắn hơn chu kỳ 60Hz → điều chế biên độ trong lòng
//      sóng, nghe ra tiếng rè ù ở trầm.
//   4. Phantom bass nạp -6dBFS RMS → đỉnh vượt ±1 → clip cứng, hài bậc cao chói.
//   5. AGC không lùi khi limiter bị ghì sâu → méo xuyên điều chế ở trầm.
//
//  v4.3 — sửa "nhỏ to thất thường": lỗi vòng điều khiển.
//   1. AGC lái bằng loudness MOMENTARY (341ms) làm mượt TC ~4s => nó bám theo
//      động lực của bản nhạc, tức là hoạt động như compressor chậm chứ không
//      phải normalizer. Thay bằng INTEGRATED có cổng (BS.1770-4).
//   2. Khoá dần theo lượng dữ liệu đã đo: sau ~30s deadband nới 2dB, slew tụt
//      còn 0.3dB/s => mức đứng yên phần còn lại của bài.
//   3. Vòng limiterTrim của v4.2 đối xứng, loop gain ~1, hai lag nối tiếp => nó
//      dao động. Làm bất đối xứng: hạ nhanh, hồi TC ~40s.
//   4. Auto-makeup TC 2.5s nhanh hơn chainOffset (10s) nên chainOffset không bao
//      giờ trừ được nó; độ lợi chain lắc ±6dB ngay dưới chân AGC. Hạ về TC ~20s.
//
//  v4.5 — thêm phần "nghe thấy được", chọn theo thiết bị:
//   1. Transient shaper (worklet): trả lại độ nảy mà multiband compressor bóp
//      chết. Đo được +3.2dB tương phản attack/sustain, sustain không đổi.
//   2. Dynamic de-harsh (worklet): dập cú vọt 2–6kHz theo ngưỡng TƯƠNG ĐỐI nên
//      không phụ thuộc mức nguồn. Dập -4.3dB cú vọt, nền ổn định lệch 0.03dB.
//   3. HF Exciter: tổng hợp hài từ 3.5–6.5kHz vào dải 7–13kHz.
//   4. Nới rộng phụ thuộc tần số + đưa trầm về giữa, thay cho nới đều toàn dải.
//   5. Crossfeed Bauer cho tai nghe.
//   6. Cắt siêu trầm cho loa nhỏ, đặt SAU chỗ Phantom Bass trích tín hiệu.
// ============================================================================

// --- 1. HẰNG SỐ ĐIỀU KHIỂN ---
const TICK_MS = 200;
const FFT_SIZE = 16384;              // ~341ms @48kHz — phủ trọn khoảng cách 2 lần đo
const ABS_GATE_LUFS = -55;
const DEADBAND_OPEN_DB = 1.0;
const DEADBAND_CLOSE_DB = 0.15;
const SLEW_DB_PER_SEC = 1.5;

// --- Integrated loudness (BS.1770-4) ---
// AGC PHẢI lái bằng integrated, không phải momentary. Loudness momentary của
// nhạc chênh ±10dB giữa đoạn nhẹ và điệp khúc; bám theo nó với TC ~4s thì AGC
// biến thành một compressor rất chậm — nghe ra đúng là "nhỏ to thất thường".
// Integrated đo cả bài, có cổng, cho MỘT con số ổn định để khoá vào.
const INTEG_MAX_BLOCKS = 4500;       // ring ~15 phút; dài hơn thì lịch sử cũ đóng băng AGC
const INTEG_MIN_BLOCKS = 8;          // ~1.6s mới đủ tin cậy
const REL_GATE_LIN = Math.pow(10, -10 / 10);  // cổng tương đối -10 LU

// Khoá dần: biến AGC từ "compressor chậm" thành "normalizer mỗi bài một lần".
// Điều kiện khoá là SỐ ĐO ĐÃ ĐỨNG YÊN, không phải đã trôi qua bao nhiêu giây.
// Bài mở đầu bằng intro nhẹ thì ở mốc 30s integrated còn lệch ~6dB so với giá
// trị thật; khoá theo đồng hồ là khoá đúng vào lúc số đo còn sai.
// Cách này cũng tự MỞ KHOÁ nếu nội dung đổi thật (video tổng hợp nhiều bài).
const LOCK_BLOCKS = 150;             // ~30s: điều kiện cần
const LOCK_CHECK_TICKS = 50;         // đối chiếu mỗi 10s
const LOCK_STABLE_DB = 0.5;          // trôi dưới ngần này trong 10s = đã đứng yên
const SLEW_LOCKED_DB_PER_SEC = 0.3;
const DEADBAND_OPEN_LOCKED_DB = 2.0;
const MAX_GAIN_DB = 24;
const LIMIT_CEILING_DB = -1.0;
const LOOKAHEAD_MS = 8;              // 5ms quá ngắn cho trầm: envelope bám theo chu kỳ sóng
const FAST_LOCK_TICKS = 13;          // ~2.6s đầu mỗi track

// Limiter được phép ghì tới mức này. Vượt qua, AGC tự hạ gain thay vì để
// limiter méo tín hiệu. Đây là đánh đổi có ý thức: to hơn <-> sạch hơn.
const LIMIT_ALLOW_DB = -1.5;
const LIMIT_TRIM_MAX_DB = 12;

// Auto-makeup: TC ~20s. Bản cũ để 2.5s — nhanh hơn cả vòng hiệu chuẩn
// chainOffset (10s), nên chainOffset không bao giờ đuổi kịp và độ lợi chain
// lắc ±6dB ngay dưới chân AGC. Makeup phải là hằng số của BÀI, không phải
// của đoạn nhạc: chậm hơn hẳn chainOffset thì chainOffset mới trừ được nó.
// Trần 12dB cũ x 3 băng cộng vào sumNode đủ đẩy đỉnh chain lên 4–8 lần,
// vượt xa vùng tuyến tính của waveshaper phía sau => clip cứng.
const MAKEUP_ALPHA = 0.01;
const MAKEUP_MAX_DB = 6;

// Headroom cho tầng bão hoà. WaveShaper KẸP CỨNG input ngoài [-1,1], nên
// ngưỡng clip = 1/SAT_DRIVE. 0.5 (bản cũ) => clip ngay ở +6dBFS đỉnh chain.
// 0.2 => +14dBFS, đủ chỗ cho makeup + exciter + widener cộng dồn.
const SAT_DRIVE = 0.2;
const SAT_CURVE_K = 2.0;             // bù lại độ "màu" bị mất khi hạ drive

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
const PHANTOM_GATE_HYST_DB = 4;      // trễ đóng/mở: tránh gate chattering => click
// Mức RMS chuẩn nạp vào waveshaper. Hài sinh ra tỉ lệ với BÌNH PHƯƠNG biên độ,
// nên nếu để mức vào tự do thì tỉ lệ hài/nền tảng thay đổi ~2:1 theo mức tín hiệu
// và vòng hiệu chuẩn phải bù tới +40dB. Ghim mức nạp => tỉ lệ hài không đổi.
// -6 dBFS RMS là quá nóng: bass đã lọc dải có crest ~6dB nên đỉnh vượt ±1 và bị
// waveshaper kẹp cứng, sinh chuỗi hài bậc cao chói. -12 giữ đỉnh trong vùng cong.
const PHANTOM_DRIVE_DB = -12;

// --- VOCAL FOCUS ---
// KHÔNG tách được vocal bằng Web Audio. Cái làm được là giảm CHE LẤP PHỔ:
// đo tỉ lệ năng lượng dải hiện diện giọng (1.1–3.6kHz, kênh Mid) so với dải
// che lấp chính (100–400Hz). Tỉ lệ thấp = giọng đang bị beat/bass phủ lên.
// Rồi hạ dải che lấp, nâng dải hiện diện, và hạ Side trong dải giọng để phần
// trung tâm (nơi vocal gần như luôn nằm) nổi lên so với nhạc cụ trải rộng.
// Hai ngưỡng này KHÔNG đoán được bằng trực giác: bandpass 2kHz Q0.8 có băng
// thông (Hz) rộng gấp ~8 lần bandpass 250Hz Q0.8, nên nó bù gần hết độ dốc 1/f
// của phổ nhạc. Đo bằng mô hình phổ thực: pink -0.1dB, acoustic +3.3dB,
// pop -3.7dB, EDM bass nặng -8.6dB. Ngưỡng phải bám dải đó.
const VOCAL_RATIO_OK_DB = -2;        // tỉ lệ này trở lên: mix đã cân, không đụng vào
const VOCAL_RATIO_BAD_DB = -10;      // tỉ lệ này trở xuống: can thiệp tối đa
const VOCAL_DEMUD_MAX_DB = 4.5;      // cắt 320Hz
const VOCAL_PRESENCE_MAX_DB = 4.0;   // nâng 3kHz
const VOCAL_SIDE_DUCK_MAX_DB = 3.5;  // hạ Side trong dải giọng
const VOCAL_ALPHA = 0.03;            // TC ~7s: đặc tính của BÀI, không bám theo từng câu hát
const VOCAL_GATE_DB = -60;

// --- HF EXCITER (chi tiết / "air") ---
// Cùng khuôn với Phantom Bass nhưng soi gương: trích 3.5–6.5kHz, sinh hài bậc
// 2 (rơi vào 7–13kHz), lọc bỏ nền tảng, trộn lại theo tỉ lệ dB so với dải gốc.
// Trích dải CAO hơn thì hài rơi trên 16kHz — phần lớn người không nghe thấy,
// tốn CPU để tạo ra thứ vô hình. WaveShaper oversample 4x lo phần chống alias.
const HF_EXTRACT_LO = 3500;
const HF_EXTRACT_HI = 6500;
const HF_OUT_HP = 7500;
const HF_DRIVE_DB = -12;
const HF_GATE_DB = -60;

// --- HỒ SƠ THIẾT BỊ ---
// Ba thiết bị này đòi hỏi xử lý gần như ngược nhau, nên gộp chung một preset
// "hay" là không thể. Loa nhỏ cần bù trầm ảo + cắt siêu trầm vô ích; tai nghe
// cần crossfeed và KHÔNG cần bù trầm; loa rời cần để yên.
const DEVICE_PROFILE = {
    headphone: {
        crossfeed: 0.45,      // Bauer: trộn chéo có trễ + lọc, mô phỏng nghe loa
        sideMonoHz: 120,      // trầm về giữa: tai nghe tách trầm hai bên nghe rất giả
        subCutHz: 20,         // ~tắt
        phantomAdjDb: -4,
        phantomForceDb: null,
        hfMixDb: -20,         // tai nghe phơi bày độ chói => nhẹ tay
        punch: 0.45, sustain: 0, deharsh: 0.5, widthExtra: 0.35
    },
    laptop: {
        crossfeed: 0,
        sideMonoHz: 200,
        subCutHz: 95,         // loa nhỏ không phát nổi, giữ lại chỉ tốn headroom và gây méo
        phantomAdjDb: 4,
        phantomForceDb: -12,  // bật cả khi profile tắt: đây là nơi trầm ảo có giá trị nhất
        hfMixDb: -14,
        punch: 0.6, sustain: 0, deharsh: 0.6, widthExtra: 0.5
    },
    speaker: {
        crossfeed: 0,
        sideMonoHz: 40,       // ~tắt
        subCutHz: 20,
        phantomAdjDb: 0,
        phantomForceDb: null,
        hfMixDb: -18,
        punch: 0.5, sustain: 0, deharsh: 0.4, widthExtra: 0.4
    }
};

let TARGET_MIN = -16.0;
let TARGET_MAX = -12.0;
let vocalStrength = 0.7;             // 0..1, người dùng chỉnh
let currentDevice = 'laptop';
let intensity = 1.0;                 // 0..1, cường độ tổng

// --- 2. TRẠNG THÁI ---
let audioCtx = null;
let isInitialized = false;
let isInitializing = false;
let currentUIMode = 'podcast';
let isBypassed = false;

let preInput, chainIn, dryGain, wetGain, outBus, agcGain, sumNode;
let compLow, compMid, compHigh, gainLow, gainMid, gainHigh;
let exciterBass, mudRemoval, exciterAir, widthBoost, phantomGain, phantomGate;
let vocalDemud, vocalPresence, vocalSideDuck;
let vocalCenterProbe, vocalCenterBuf, vocalMaskProbe, vocalMaskBuf;
let vocalAmount = 0;
let vocalRatioDb = null;
let phantomProbe, phantomProbeBuf, phantomOutProbe, phantomOutBuf, phantomDrive;
let hfProbe, hfProbeBuf, hfOutProbe, hfOutBuf, hfDrive, hfGain, hfGate;
let subCut1, subCut2, sideMono, widthExtra, xfGainL, xfGainR;
let enhanceNode = null;
let usingEnhance = false;
let hfGainDb = -40, hfDriveDb = 0, hfOpen = false;
let inMeter, outMeter;

let limiterNode = null;              // AudioWorkletNode hoặc DynamicsCompressor
let usingWorkletLimiter = false;
let limiterReductionDb = 0;

let inLufsSmooth = null;
let outLufsSmooth = null;
let inIntegrated = null;
let outIntegrated = null;
let inIntg = null, outIntg = null;
let integRefDb = null;
let integStable = false;
let chainOffsetDb = 0;
let currentAppliedGainDb = 0;
let isCorrecting = false;
let tickCount = 0;

const makeupDb = { low: 0, mid: 0, high: 0 };
let phantomGainDb = -40;
let phantomDriveDb = 0;
let phantomOpen = false;

let limiterAvgDb = 0;
let limiterTrimDb = 0;

const sourceCache = new WeakMap();
let currentSource = null;
let currentElement = null;
let currentVideoId = null;
let monitorInterval = null;
let watcherInterval = null;

// --- 3. CÀI ĐẶT NGƯỜI DÙNG ---
const clampVocal = (v) => Math.max(0, Math.min(1, (parseFloat(v) || 0) / 100));

chrome.storage.sync.get(
    ['userTargetMin', 'userTargetMax', 'userMode', 'userBypass', 'userVocal', 'userDevice', 'userIntensity'],
    (data) => {
        if (data.userTargetMin !== undefined) TARGET_MIN = parseFloat(data.userTargetMin);
        if (data.userTargetMax !== undefined) TARGET_MAX = parseFloat(data.userTargetMax);
        if (data.userMode) currentUIMode = data.userMode;
        if (data.userBypass !== undefined) isBypassed = !!data.userBypass;
        if (data.userVocal !== undefined) vocalStrength = clampVocal(data.userVocal);
        if (data.userDevice && DEVICE_PROFILE[data.userDevice]) currentDevice = data.userDevice;
        if (data.userIntensity !== undefined) intensity = clampVocal(data.userIntensity);
        applyAudioProfile(currentUIMode);
        applyDeviceProfile();
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
    if (changes.userVocal) vocalStrength = clampVocal(changes.userVocal.newValue);
    if (changes.userDevice || changes.userIntensity) {
        if (changes.userDevice && DEVICE_PROFILE[changes.userDevice.newValue]) {
            currentDevice = changes.userDevice.newValue;
        }
        if (changes.userIntensity) intensity = clampVocal(changes.userIntensity.newValue);
        applyDeviceProfile();
    }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.type === 'GET_STATUS') {
        sendResponse({
            active: isInitialized && currentElement !== null,
            bypassed: isBypassed,
            inLufs: inIntegrated !== null ? inIntegrated : inLufsSmooth,
            outLufs: outIntegrated !== null ? outIntegrated : outLufsSmooth,
            integrated: inIntegrated !== null,
            locked: inIntg !== null && inIntg.n >= LOCK_BLOCKS && integStable,
            gainDb: currentAppliedGainDb,
            chainOffsetDb: chainOffsetDb,
            limiterDb: limiterReductionDb,
            trueLimiter: usingWorkletLimiter,
            mode: currentUIMode,
            vocalAmount: vocalAmount,
            vocalRatioDb: vocalRatioDb,
            device: currentDevice,
            intensity: intensity,
            hasEnhance: usingEnhance,
            phantomOn: phantomOpen,
            hfOn: hfOpen
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

    // Phantom do vòng hiệu chuẩn trong tick điều khiển; ở đây chỉ tắt hẳn nếu
    // cả profile lẫn hồ sơ thiết bị đều không dùng đến nó
    if (phantomMixDb() === null) {
        phantomGain.gain.setTargetAtTime(0, t, tc);
        phantomGainDb = -40;
    }

    chainOffsetDb = 0; // đổi profile = đổi độ lợi chain, số hiệu chuẩn cũ hết hiệu lực
    limiterAvgDb = 0;
    limiterTrimDb = 0;
    isCorrecting = true;
    console.log(`🎛️ DSP Profile: [${String(mode).toUpperCase()}] — reset hiệu chuẩn chain`);
}

// setTargetAtTime tiệm cận chứ không bao giờ CHẠM đích. Với các tham số mà
// giá trị 0 mang nghĩa "tắt hẳn" thì phải chốt đúng 0, nếu không nhánh bypass
// trong worklet không bao giờ chạy và tín hiệu vẫn đi qua bộ lọc.
function rampParam(param, value, t, tc) {
    param.setTargetAtTime(value, t, tc);
    if (value === 0) param.setValueAtTime(0, t + 8 * tc);
}

// Tỉ lệ trộn Phantom sau khi tính cả thiết bị và cường độ.
// Loa laptop bật Phantom kể cả khi profile tắt: đó là nơi nó có giá trị nhất.
function phantomMixDb() {
    if (intensity <= 0) return null;
    const d = DEVICE_PROFILE[currentDevice] || DEVICE_PROFILE.laptop;
    const modeMix = PHANTOM_MIX_DB[currentUIMode];
    let mix;
    if (modeMix === null || modeMix === undefined) {
        if (d.phantomForceDb === null) return null;
        mix = d.phantomForceDb;
    } else {
        mix = modeMix + d.phantomAdjDb;
    }
    return mix - (1 - intensity) * 18;
}

function applyDeviceProfile() {
    if (!isInitialized) return;
    const t = audioCtx.currentTime;
    const tc = 0.3;
    const d = DEVICE_PROFILE[currentDevice] || DEVICE_PROFILE.laptop;

    subCut1.frequency.setTargetAtTime(d.subCutHz, t, tc);
    subCut2.frequency.setTargetAtTime(d.subCutHz, t, tc);
    sideMono.frequency.setTargetAtTime(d.sideMonoHz, t, tc);
    rampParam(widthExtra.gain, d.widthExtra * intensity, t, tc);

    const xf = d.crossfeed * intensity;
    rampParam(xfGainL.gain, xf, t, tc);
    rampParam(xfGainR.gain, xf, t, tc);

    if (enhanceNode) {
        rampParam(enhanceNode.parameters.get('punch'), d.punch * intensity, t, tc);
        rampParam(enhanceNode.parameters.get('sustain'), d.sustain * intensity, t, tc);
        rampParam(enhanceNode.parameters.get('deharsh'), d.deharsh * intensity, t, tc);
    }

    // Đổi thiết bị = đổi độ lợi chain => số hiệu chuẩn cũ hết hiệu lực
    chainOffsetDb = 0;
    limiterAvgDb = 0;
    limiterTrimDb = 0;
    isCorrecting = true;
    console.log(`🎧 Thiết bị: [${String(currentDevice).toUpperCase()}] · cường độ ${(intensity * 100).toFixed(0)}%` +
        `${usingEnhance ? '' : ' · KHÔNG có Punch/De-harsh (worklet lỗi)'}`);
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

// Trả về mean-square (năng lượng), chưa đổi ra dB — bộ tích phân cần số tuyến
// tính để cộng, đổi sang dB rồi mới cộng là sai về mặt năng lượng.
function measureMeanSquare(meter) {
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
    return sumL / n + sumR / n; // BS.1770: cộng năng lượng từng kênh
}

function msToLufs(ms) {
    return ms <= 0 ? null : -0.691 + 10 * Math.log10(ms);
}

function blockLufs(ms) {
    const lufs = msToLufs(ms);
    return (lufs === null || lufs < ABS_GATE_LUFS) ? null : lufs;
}

// --- BỘ TÍCH PHÂN LOUDNESS CÓ CỔNG (BS.1770-4) ---
// Ring buffer để video dài không đóng băng AGC bằng lịch sử hàng giờ trước đó.
function createIntegrator() {
    return { buf: new Float64Array(INTEG_MAX_BLOCKS), idx: 0, n: 0, sum: 0 };
}

function pushBlock(g, ms) {
    if (g.n === INTEG_MAX_BLOCKS) g.sum -= g.buf[g.idx];
    else g.n++;
    g.buf[g.idx] = ms;
    g.sum += ms;
    g.idx = (g.idx + 1) % INTEG_MAX_BLOCKS;
}

// Cổng tương đối: loại các block thấp hơn 10 LU so với trung bình chưa cổng.
// Không có bước này thì đoạn intro/outro nhẹ kéo tụt số đo và AGC đẩy cả bài
// lên quá to.
function integratedLufs(g) {
    if (g.n < INTEG_MIN_BLOCKS) return null;
    const relThresh = (g.sum / g.n) * REL_GATE_LIN;
    let sum = 0, count = 0;
    for (let i = 0; i < g.n; i++) {
        const v = g.buf[i];
        if (v >= relThresh) { sum += v; count++; }
    }
    return count === 0 ? null : msToLufs(sum / count);
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

    // Punch và de-harsh không có node thay thế. Không nạp được thì bỏ hẳn hai
    // tính năng đó chứ không giả lập bằng thứ nghe khác hẳn.
    try {
        await audioCtx.audioWorklet.addModule(chrome.runtime.getURL('enhance-worklet.js'));
        usingEnhance = true;
    } catch (e) {
        usingEnhance = false;
        console.warn('⚠️ Không nạp được enhance worklet — tắt Punch và De-harsh:', e);
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

    // Cắt siêu trầm cho loa nhỏ. Đặt SAU chỗ Phantom Bass trích tín hiệu (nó
    // lấy thẳng từ chainIn) — đặt trước thì cắt mất đúng cái mà Phantom cần để
    // tổng hợp hài, tự vô hiệu hoá chính mình.
    subCut1 = lr('highpass', 20); subCut2 = lr('highpass', 20);
    chainIn.connect(subCut1); subCut1.connect(subCut2);

    const lowLp1 = lr('lowpass', XO_LOW), lowLp2 = lr('lowpass', XO_LOW);
    const restHp1 = lr('highpass', XO_LOW), restHp2 = lr('highpass', XO_LOW);
    subCut2.connect(lowLp1); lowLp1.connect(lowLp2);
    subCut2.connect(restHp1); restHp1.connect(restHp2);

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
    // Băng <250Hz: chu kỳ 60Hz là 16.7ms. Attack 10ms / release 100ms của bản cũ
    // làm gain đổi NGAY TRONG lòng một chu kỳ sóng => điều chế biên độ, nghe ra
    // đúng là tiếng rè ù ở trầm. Hằng số thời gian phải dài hơn chu kỳ thấp nhất.
    compLow = audioCtx.createDynamicsCompressor();
    compLow.threshold.value = -24; compLow.ratio.value = 4.0;
    compLow.attack.value = 0.03; compLow.release.value = 0.25;
    gainLow = audioCtx.createGain(); gainLow.gain.value = 1.0;
    lowAllpass.connect(compLow); compLow.connect(gainLow);

    compMid = audioCtx.createDynamicsCompressor();
    compMid.threshold.value = -30; compMid.ratio.value = 3.0;
    compMid.attack.value = 0.005; compMid.release.value = 0.2;
    gainMid = audioCtx.createGain(); gainMid.gain.value = 1.0;
    midLp2.connect(compMid); compMid.connect(gainMid);

    compHigh = audioCtx.createDynamicsCompressor();
    compHigh.threshold.value = -20; compHigh.ratio.value = 4.0; // de-esser (6.0 quá gắt trên cymbal)
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

    // ---- HF EXCITER ----
    // Soi gương Phantom Bass. Nguồn Opus/AAC bào mòn phần cao tần; không lấy
    // lại được dữ liệu đã mất, nhưng tổng hợp hài từ dải 3.5–6.5kHz còn nguyên
    // vẹn thì tạo lại được cảm giác chi tiết mà tai quy cho dải đó.
    const hfEx1 = lr('highpass', HF_EXTRACT_LO), hfEx2 = lr('highpass', HF_EXTRACT_LO);
    const hfEx3 = lr('lowpass', HF_EXTRACT_HI), hfEx4 = lr('lowpass', HF_EXTRACT_HI);
    chainIn.connect(hfEx1); hfEx1.connect(hfEx2);
    hfEx2.connect(hfEx3); hfEx3.connect(hfEx4);

    hfProbe = audioCtx.createAnalyser();
    hfProbe.fftSize = 2048;
    hfProbeBuf = new Float32Array(hfProbe.fftSize);
    hfEx4.connect(hfProbe);

    hfDrive = audioCtx.createGain();
    hfDrive.gain.value = 1;
    hfEx4.connect(hfDrive);

    const hfShaper = audioCtx.createWaveShaper();
    hfShaper.curve = makePhantomCurve();   // hài bậc 2 trội: ngọt hơn bậc 3 ở dải cao
    hfShaper.oversample = '4x';            // hài bậc 3 của 6.5kHz = 19.5kHz, cần chống alias
    hfDrive.connect(hfShaper);

    let hfHp = hfShaper;
    for (let i = 0; i < 3; i++) {
        const f = lr('highpass', HF_OUT_HP);
        hfHp.connect(f);
        hfHp = f;
    }

    hfOutProbe = audioCtx.createAnalyser();
    hfOutProbe.fftSize = 2048;
    hfOutBuf = new Float32Array(hfOutProbe.fftSize);
    hfHp.connect(hfOutProbe);

    hfGate = audioCtx.createGain();
    hfGate.gain.value = 0;
    hfHp.connect(hfGate);

    hfGain = audioCtx.createGain();
    hfGain.gain.value = 0;
    hfGate.connect(hfGain);

    // ---- SUMMING BUS ----
    sumNode = audioCtx.createGain();
    gainLow.connect(sumNode);
    gainMid.connect(sumNode);
    gainHigh.connect(sumNode);
    phantomGain.connect(sumNode);
    hfGain.connect(sumNode);

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

    // ---- ANALOG SATURATION (gain staging có headroom) ----
    // Ngưỡng clip cứng = 1/SAT_DRIVE. Hạ drive để đỉnh chain (makeup + exciter
    // + widener cộng dồn) không chạm biên miền [-1,1] của WaveShaper, rồi tăng K
    // để đường cong vẫn cong đúng bằng ở mức tín hiệu thực tế.
    const preSatGain = audioCtx.createGain();
    preSatGain.gain.value = SAT_DRIVE;
    exciterAir.connect(preSatGain);

    const tubeSaturator = audioCtx.createWaveShaper();
    tubeSaturator.curve = makeSaturationCurve(SAT_CURVE_K);
    tubeSaturator.oversample = '4x';
    preSatGain.connect(tubeSaturator);

    const postSatGain = audioCtx.createGain();
    postSatGain.gain.value = 1 / SAT_DRIVE;
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

    // ---- VOCAL FOCUS (de-masking trên trục M/S) ----
    // Ba bộ lọc, tất cả khởi tạo 0dB => tắt hẳn là trung tính tuyệt đối.
    vocalDemud = audioCtx.createBiquadFilter();
    vocalDemud.type = 'peaking'; vocalDemud.frequency.value = 320;
    vocalDemud.Q.value = 1.0; vocalDemud.gain.value = 0;
    midSum.connect(vocalDemud);

    vocalPresence = audioCtx.createBiquadFilter();
    vocalPresence.type = 'peaking'; vocalPresence.frequency.value = 3000;
    vocalPresence.Q.value = 0.9; vocalPresence.gain.value = 0;
    vocalDemud.connect(vocalPresence);

    vocalSideDuck = audioCtx.createBiquadFilter();
    vocalSideDuck.type = 'peaking'; vocalSideDuck.frequency.value = 1800;
    vocalSideDuck.Q.value = 0.6; vocalSideDuck.gain.value = 0;
    sideSum.connect(vocalSideDuck);

    // Hai đầu dò lấy TRƯỚC ba bộ lọc trên. Lấy sau thì phép đo tự nuôi chính
    // nó: càng nâng 3kHz thì tỉ lệ đo được càng đẹp, càng nâng tiếp — chạy loạn.
    const vocalCenterBp = audioCtx.createBiquadFilter();
    vocalCenterBp.type = 'bandpass'; vocalCenterBp.frequency.value = 2000;
    vocalCenterBp.Q.value = 0.8;                    // ~1.1–3.6kHz
    midSum.connect(vocalCenterBp);
    vocalCenterProbe = audioCtx.createAnalyser();
    vocalCenterProbe.fftSize = 2048;
    vocalCenterBuf = new Float32Array(vocalCenterProbe.fftSize);
    vocalCenterBp.connect(vocalCenterProbe);

    const vocalMaskBp = audioCtx.createBiquadFilter();
    vocalMaskBp.type = 'bandpass'; vocalMaskBp.frequency.value = 250;
    vocalMaskBp.Q.value = 0.8;                      // ~100–400Hz
    midSum.connect(vocalMaskBp);
    vocalMaskProbe = audioCtx.createAnalyser();
    vocalMaskProbe.fftSize = 2048;
    vocalMaskBuf = new Float32Array(vocalMaskProbe.fftSize);
    vocalMaskBp.connect(vocalMaskProbe);

    // ---- NỚI RỘNG PHỤ THUỘC TẦN SỐ ----
    // Nới đều toàn dải (bản cũ) làm trầm bị tách sang hai bên: mất lực, và trên
    // hệ thống mono/loa bluetooth thì phần trầm lệch pha tự triệt tiêu nhau.
    // Trầm giữ ở giữa, chỉ mở rộng từ 300Hz trở lên.
    sideMono = lr('highpass', 40);          // tần số cắt đặt theo thiết bị
    vocalSideDuck.connect(sideMono);

    const sideWideHp = lr('highpass', 300);
    vocalSideDuck.connect(sideWideHp);
    widthExtra = audioCtx.createGain();
    widthExtra.gain.value = 0;              // 0 = rộng đúng như bản gốc
    sideWideHp.connect(widthExtra);

    const sideBus = audioCtx.createGain();
    sideMono.connect(sideBus);
    widthExtra.connect(sideBus);

    widthBoost = audioCtx.createGain();
    widthBoost.gain.value = 1.0;
    sideBus.connect(widthBoost);

    const merger = audioCtx.createChannelMerger(2);
    const invSide = audioCtx.createGain();
    invSide.gain.value = -1.0;
    widthBoost.connect(invSide);

    vocalPresence.connect(merger, 0, 0);
    widthBoost.connect(merger, 0, 0);
    vocalPresence.connect(merger, 0, 1);
    invSide.connect(merger, 0, 1);

    // ---- CROSSFEED (chỉ có nghĩa với tai nghe) ----
    // Tai nghe đưa kênh trái vào đúng tai trái, không tai nào nghe được kênh
    // kia — điều không xảy ra trong tự nhiên, và là lý do âm hình "dính trong
    // đầu" và nghe lâu mỏi. Bauer: mỗi tai nhận thêm bản sao của kênh đối diện,
    // trễ ~300µs (thời gian âm vòng qua đầu) và lọc thông thấp (đầu chắn cao tần).
    const xfSplit = audioCtx.createChannelSplitter(2);
    merger.connect(xfSplit);

    const xfMerge = audioCtx.createChannelMerger(2);
    xfSplit.connect(xfMerge, 0, 0);
    xfSplit.connect(xfMerge, 1, 1);

    const mkCrossfeed = (fromCh, toCh) => {
        const d = audioCtx.createDelay(0.01);
        d.delayTime.value = 0.0003;
        const lp = audioCtx.createBiquadFilter();
        lp.type = 'lowpass'; lp.frequency.value = 700; lp.Q.value = 0.5;
        const g = audioCtx.createGain();
        g.gain.value = 0;
        xfSplit.connect(d, fromCh);
        d.connect(lp); lp.connect(g);
        g.connect(xfMerge, 0, toCh);
        return g;
    };
    xfGainL = mkCrossfeed(0, 1);   // trái -> tai phải
    xfGainR = mkCrossfeed(1, 0);   // phải -> tai trái

    // ---- PUNCH + DE-HARSH ----
    // Đặt SAU multiband compressor (compressor bóp chết transient, đây là chỗ
    // trả lại) nhưng TRƯỚC AGC/limiter, để phần đỉnh mới tạo ra được limiter
    // canh và được AGC tính vào phép đo integrated.
    agcGain = audioCtx.createGain();

    if (usingEnhance) {
        enhanceNode = new AudioWorkletNode(audioCtx, 'enhance', {
            numberOfInputs: 1,
            numberOfOutputs: 1,
            outputChannelCount: [2]
        });
        xfMerge.connect(enhanceNode);
        enhanceNode.connect(agcGain);
    } else {
        xfMerge.connect(agcGain);
    }

    const ceilingLin = Math.pow(10, LIMIT_CEILING_DB / 20);

    if (usingWorkletLimiter) {
        limiterNode = new AudioWorkletNode(audioCtx, 'lookahead-limiter', {
            numberOfInputs: 1,
            numberOfOutputs: 1,
            outputChannelCount: [2],
            processorOptions: { lookaheadMs: LOOKAHEAD_MS }
        });
        limiterNode.parameters.get('ceiling').value = ceilingLin;
        limiterNode.parameters.get('release').value = 0.15;
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
    inIntg = createIntegrator();
    outIntg = createIntegrator();

    isInitialized = true;
    isInitializing = false;
    applyAudioProfile(currentUIMode);
    applyDeviceProfile();
    applyBypass(isBypassed);
    console.log('✅ Smart LUFS Normalizer Pro v4.5: audio graph sẵn sàng.');
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
    inIntegrated = null;
    outIntegrated = null;
    inIntg = createIntegrator();   // integrated là đặc tính của BÀI => phải reset
    outIntg = createIntegrator();
    integRefDb = null;
    integStable = false;
    limiterTrimDb = 0;             // headroom phụ thuộc chất liệu, bài mới thì đo lại
    limiterAvgDb = 0;
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
    const mix = phantomMixDb();
    const subDb = probeRmsDb(phantomProbe, phantomProbeBuf);

    // Trễ đóng/mở: mở ở PHANTOM_GATE_DB, chỉ đóng khi tụt thêm HYST nữa.
    // Không có trễ thì bass lảng vảng quanh ngưỡng sẽ bật/tắt mỗi tick => click.
    if (mix === null || mix === undefined) phantomOpen = false;
    else if (phantomOpen) phantomOpen = subDb > PHANTOM_GATE_DB - PHANTOM_GATE_HYST_DB;
    else phantomOpen = subDb > PHANTOM_GATE_DB;

    if (!phantomOpen) {
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

// Soi gương updatePhantom: chuẩn hoá mức nạp waveshaper rồi đặt tỉ lệ trộn
// bằng dB so với dải gốc, nên đổi đường cong không phải chỉnh lại bằng tai.
function updateHfExciter(now) {
    const d = DEVICE_PROFILE[currentDevice] || DEVICE_PROFILE.laptop;
    const mix = intensity <= 0 ? null : d.hfMixDb - (1 - intensity) * 18;
    const srcDb = probeRmsDb(hfProbe, hfProbeBuf);

    if (mix === null) hfOpen = false;
    else if (hfOpen) hfOpen = srcDb > HF_GATE_DB - 4;
    else hfOpen = srcDb > HF_GATE_DB;

    if (!hfOpen) {
        hfGate.gain.setTargetAtTime(0, now, 0.15);
        return;
    }

    let driveDb = HF_DRIVE_DB - srcDb;
    driveDb = Math.max(-12, Math.min(40, driveDb));
    hfDriveDb += (driveDb - hfDriveDb) * 0.15;
    hfDrive.gain.setTargetAtTime(Math.pow(10, hfDriveDb / 20), now, 0.2);

    const harmDb = probeRmsDb(hfOutProbe, hfOutBuf);
    if (harmDb > -130) {
        let gDb = srcDb + mix - harmDb;
        gDb = Math.max(-40, Math.min(MAX_GAIN_DB, gDb));
        hfGainDb += (gDb - hfGainDb) * 0.1;
        hfGain.gain.setTargetAtTime(Math.pow(10, hfGainDb / 20), now, 0.3);
    }
    hfGate.gain.setTargetAtTime(1, now, 0.03);
}

function applyVocalGains(now) {
    const tc = 0.4;
    vocalDemud.gain.setTargetAtTime(-VOCAL_DEMUD_MAX_DB * vocalAmount, now, tc);
    vocalPresence.gain.setTargetAtTime(VOCAL_PRESENCE_MAX_DB * vocalAmount, now, tc);
    vocalSideDuck.gain.setTargetAtTime(-VOCAL_SIDE_DUCK_MAX_DB * vocalAmount, now, tc);
}

// Lượng can thiệp = "bài này cần giúp bao nhiêu" x "người dùng cho phép bao nhiêu".
// Cố ý chậm (TC ~7s): đây là đặc tính của BẢN PHỐI, không phải của từng câu hát.
// Bám theo từng câu sẽ thành ducking nghe rõ nhạc cụ phập phồng quanh giọng.
function updateVocalFocus(now) {
    if (vocalStrength <= 0) {
        if (vocalAmount > 0.001) {
            vocalAmount += (0 - vocalAmount) * 0.2;
            applyVocalGains(now);
        }
        return;
    }

    const centerDb = probeRmsDb(vocalCenterProbe, vocalCenterBuf);
    const maskDb = probeRmsDb(vocalMaskProbe, vocalMaskBuf);
    if (centerDb <= VOCAL_GATE_DB && maskDb <= VOCAL_GATE_DB) return; // im lặng: giữ nguyên

    vocalRatioDb = centerDb - maskDb;
    const span = VOCAL_RATIO_OK_DB - VOCAL_RATIO_BAD_DB;
    const need = Math.max(0, Math.min(1, (VOCAL_RATIO_OK_DB - vocalRatioDb) / span));

    const target = need * vocalStrength;
    vocalAmount += (target - vocalAmount) * VOCAL_ALPHA;
    applyVocalGains(now);
}

function startMonitor() {
    if (monitorInterval) clearInterval(monitorInterval);

    monitorInterval = setInterval(() => {
        if (!isInitialized || !currentElement) return;
        if (currentElement.paused || currentElement.ended) return;

        const now = audioCtx.currentTime;

        updateAutoMakeup(now);
        updatePhantom(now);
        updateHfExciter(now);
        updateVocalFocus(now);

        if (!usingWorkletLimiter) limiterReductionDb = limiterNode.reduction || 0;

        if (isBypassed) return;

        // Tôn trọng thanh volume YouTube, nếu không AGC sẽ kéo ngược lại
        const vol = currentElement.muted ? 0 : (currentElement.volume ?? 1);
        if (vol < 0.02) return;
        const volDb = 20 * Math.log10(vol);

        const inMs = measureMeanSquare(inMeter);
        const outMs = measureMeanSquare(outMeter);
        const inLufs = blockLufs(inMs);
        const outLufs = blockLufs(outMs);
        if (inLufs === null) return; // khoảng lặng: giữ nguyên gain

        tickCount++;
        const fastLock = tickCount <= FAST_LOCK_TICKS;

        // Momentary (làm mượt) chỉ còn dùng cho việc hiệu chuẩn chainOffset —
        // ở đó ta cần IN và OUT đo CÙNG một thời điểm để lấy tỉ số.
        const aIn = fastLock ? 0.35 : (inLufs > inLufsSmooth ? 0.07 : 0.05);
        inLufsSmooth = (inLufsSmooth === null) ? inLufs : inLufsSmooth + (inLufs - inLufsSmooth) * aIn;

        if (outLufs !== null) {
            const aOut = fastLock ? 0.35 : 0.06;
            outLufsSmooth = (outLufsSmooth === null) ? outLufs : outLufsSmooth + (outLufs - outLufsSmooth) * aOut;
        }

        // Integrated là thứ lái AGC.
        pushBlock(inIntg, inMs);
        if (outLufs !== null) pushBlock(outIntg, outMs);
        inIntegrated = integratedLufs(inIntg);
        outIntegrated = integratedLufs(outIntg);

        // Đối chiếu integrated với chính nó 10s trước: trôi ít nghĩa là đã hội tụ.
        if (inIntegrated !== null && tickCount % LOCK_CHECK_TICKS === 0) {
            integStable = integRefDb !== null && Math.abs(inIntegrated - integRefDb) < LOCK_STABLE_DB;
            integRefDb = inIntegrated;
        }

        // Hiệu chuẩn vòng kín: học độ lợi cố định của chain, chỉ khi hệ đứng yên
        // và limiter không can thiệp (nếu không sẽ học nhầm thành vòng lặp dương)
        const limiting = limiterReductionDb < -1.0;
        if (!fastLock && !isCorrecting && !limiting && outLufsSmooth !== null) {
            const measuredOffset = outLufsSmooth - inLufsSmooth - currentAppliedGainDb;
            chainOffsetDb += (measuredOffset - chainOffsetDb) * 0.02; // TC ~10s
            chainOffsetDb = Math.max(-MAX_GAIN_DB, Math.min(MAX_GAIN_DB, chainOffsetDb));
        }

        // Vòng bảo vệ headroom. Ở v4.2 vòng này đối xứng: loop gain ~1 với HAI
        // lag nối tiếp (4s + 10s) => nó RING, chu kỳ vài chục giây, và chính nó
        // góp phần làm âm lượng phập phù. Giờ làm bất đối xứng: hạ nhanh khi bị
        // ghì (bảo vệ), hồi rất chậm (TC ~40s) nên không còn vòng dao động.
        limiterAvgDb += (limiterReductionDb - limiterAvgDb) * 0.05;
        const limitExcess = Math.min(0, limiterAvgDb - LIMIT_ALLOW_DB) * 0.7;
        const aTrim = limitExcess < limiterTrimDb ? 0.05 : 0.005;
        limiterTrimDb += (limitExcess - limiterTrimDb) * aTrim;
        limiterTrimDb = Math.max(-LIMIT_TRIM_MAX_DB, Math.min(0, limiterTrimDb));

        const effMin = TARGET_MIN + volDb;
        const effMax = TARGET_MAX + volDb;

        // Lái bằng integrated; chỉ mượn momentary trong ~1.6s đầu khi chưa đủ block.
        const measured = inIntegrated !== null ? inIntegrated : inLufsSmooth;
        const base = measured + chainOffsetDb; // mức ra dự kiến khi gain = 0

        let desiredGainDb = 0;
        if (base < effMin) desiredGainDb = effMin - base;
        else if (base > effMax) desiredGainDb = effMax - base;
        desiredGainDb += limiterTrimDb;
        desiredGainDb = Math.max(-MAX_GAIN_DB, Math.min(MAX_GAIN_DB, desiredGainDb));

        // Khoá dần: đo được càng nhiều thì con số càng đáng tin, và càng ít lý do
        // để còn ngọ nguậy. Sau ~30s, deadband nới ra 2dB và slew tụt còn 0.3dB/s
        // => mức đứng yên trong suốt phần còn lại của bài.
        const locked = inIntg.n >= LOCK_BLOCKS && integStable;
        const openDb = locked ? DEADBAND_OPEN_LOCKED_DB : DEADBAND_OPEN_DB;
        const slewDb = locked ? SLEW_LOCKED_DB_PER_SEC : SLEW_DB_PER_SEC;

        // Deadband có trễ: mở rộng, đóng hẹp => hội tụ được thay vì đóng băng
        const err = Math.abs(desiredGainDb - currentAppliedGainDb);
        if (!isCorrecting && err > openDb) isCorrecting = true;
        else if (isCorrecting && err < DEADBAND_CLOSE_DB) isCorrecting = false;

        if (fastLock) {
            currentAppliedGainDb = desiredGainDb;
            agcGain.gain.setTargetAtTime(Math.pow(10, currentAppliedGainDb / 20), now, 0.15);
        } else if (isCorrecting) {
            const step = slewDb * (TICK_MS / 1000);
            const delta = desiredGainDb - currentAppliedGainDb;
            currentAppliedGainDb += Math.sign(delta) * Math.min(Math.abs(delta), step);
            agcGain.gain.setTargetAtTime(Math.pow(10, currentAppliedGainDb / 20), now, 0.12);
        }

        if (tickCount % 10 === 0) {
            console.log(
                `[AGC] IN ${inIntegrated === null ? '--' : inIntegrated.toFixed(1)} → OUT ${outIntegrated === null ? '--' : outIntegrated.toFixed(1)} LUFS-I ` +
                `(${inIntg.n} block${locked ? ', ĐÃ KHOÁ' : ''}) | ` +
                `Gain ${currentAppliedGainDb >= 0 ? '+' : ''}${currentAppliedGainDb.toFixed(2)}dB | ` +
                `Offset ${chainOffsetDb >= 0 ? '+' : ''}${chainOffsetDb.toFixed(2)}dB | ` +
                `Makeup L/M/H ${makeupDb.low.toFixed(1)}/${makeupDb.mid.toFixed(1)}/${makeupDb.high.toFixed(1)}dB | ` +
                `Limiter ${limiterReductionDb.toFixed(1)}dB (tb ${limiterAvgDb.toFixed(1)}, lùi ${limiterTrimDb.toFixed(1)}) | ` +
                `Vocal ${vocalRatioDb === null ? '--' : vocalRatioDb.toFixed(1) + 'dB→' + (vocalAmount * 100).toFixed(0) + '%'} | ` +
                `${isCorrecting ? 'ĐANG CHỈNH' : 'ỔN ĐỊNH'}`
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
