document.addEventListener('DOMContentLoaded', () => {
    const minInput = document.getElementById('minLufs');
    const maxInput = document.getElementById('maxLufs');
    const modeSelect = document.getElementById('modeSelect');
    const saveBtn = document.getElementById('saveBtn');
    const statusDiv = document.getElementById('status');
    const bypassBtn = document.getElementById('bypassBtn');

    const mIn = document.getElementById('mIn');
    const mOut = document.getElementById('mOut');
    const mGain = document.getElementById('mGain');
    const mOffset = document.getElementById('mOffset');
    const mLimit = document.getElementById('mLimit');
    const mLimitLabel = document.getElementById('mLimitLabel');
    const mVocal = document.getElementById('mVocal');
    const hint = document.getElementById('hint');
    const vocalRange = document.getElementById('vocalRange');
    const vocalVal = document.getElementById('vocalVal');
    const mChain = document.getElementById('mChain');
    const deviceSelect = document.getElementById('deviceSelect');
    const intensityRange = document.getElementById('intensityRange');
    const intensityVal = document.getElementById('intensityVal');

    let isBypassed = false;

    const modes = {
        movie: { min: -24.0, max: -10.0 },
        music: { min: -18.0, max: -12.0 },
        podcast: { min: -16.0, max: -12.0 },
        night: { min: -24.0, max: -22.0 }
    };

    // --- Tải cấu hình ---
    chrome.storage.sync.get(
        ['userTargetMin', 'userTargetMax', 'userMode', 'userBypass', 'userVocal', 'userDevice', 'userIntensity'],
        (data) => {
            modeSelect.value = data.userMode || 'podcast';
            if (data.userTargetMin !== undefined) minInput.value = data.userTargetMin;
            if (data.userTargetMax !== undefined) maxInput.value = data.userTargetMax;
            if (data.userVocal !== undefined) vocalRange.value = data.userVocal;
            if (data.userDevice) deviceSelect.value = data.userDevice;
            if (data.userIntensity !== undefined) intensityRange.value = data.userIntensity;
            vocalVal.textContent = `${vocalRange.value}%`;
            intensityVal.textContent = `${intensityRange.value}%`;
            isBypassed = !!data.userBypass;
            renderBypass();
        });

    // Lưu ngay khi kéo: hiệu chỉnh bằng tai thì phải nghe được thay đổi tức thì.
    vocalRange.addEventListener('input', () => {
        vocalVal.textContent = `${vocalRange.value}%`;
        chrome.storage.sync.set({ userVocal: parseInt(vocalRange.value, 10) });
    });

    intensityRange.addEventListener('input', () => {
        intensityVal.textContent = `${intensityRange.value}%`;
        chrome.storage.sync.set({ userIntensity: parseInt(intensityRange.value, 10) });
    });

    deviceSelect.addEventListener('change', () => {
        chrome.storage.sync.set({ userDevice: deviceSelect.value });
    });

    // --- Lưu cấu hình ---
    const saveSettings = () => {
        const minVal = parseFloat(minInput.value);
        const maxVal = parseFloat(maxInput.value);

        if (Number.isNaN(minVal) || Number.isNaN(maxVal)) {
            alert('Lỗi: Giá trị LUFS không hợp lệ!');
            return;
        }
        if (minVal > maxVal) {
            alert('Lỗi: Mức nhỏ nhất không được lớn hơn Mức lớn nhất!');
            return;
        }

        chrome.storage.sync.set({
            userTargetMin: minVal,
            userTargetMax: maxVal,
            userMode: modeSelect.value
        }, () => {
            statusDiv.style.display = 'block';
            setTimeout(() => { statusDiv.style.display = 'none'; }, 2000);
        });
    };

    modeSelect.addEventListener('change', () => {
        const preset = modes[modeSelect.value];
        if (preset) {
            minInput.value = preset.min;
            maxInput.value = preset.max;
        }
        // "Tùy chỉnh" trước đây rơi vào nhánh chết: không preset, không lưu.
        // Giờ luôn lưu để chế độ DSP được áp dụng.
        saveSettings();
    });

    const onManualInputChange = () => { modeSelect.value = 'custom'; };
    minInput.addEventListener('input', onManualInputChange);
    maxInput.addEventListener('input', onManualInputChange);

    saveBtn.addEventListener('click', saveSettings);

    // --- Bypass (A/B) ---
    function renderBypass() {
        bypassBtn.textContent = isBypassed
            ? 'Đang nghe GỐC — bấm để bật xử lý'
            : 'Đang XỬ LÝ — bấm để nghe gốc';
        bypassBtn.classList.toggle('off', !isBypassed);
    }

    bypassBtn.addEventListener('click', () => {
        isBypassed = !isBypassed;
        renderBypass();
        chrome.storage.sync.set({ userBypass: isBypassed });
    });

    // --- Đồng hồ đo realtime ---
    const fmt = (v, unit, digits = 1) =>
        (v === null || v === undefined || Number.isNaN(v))
            ? `-- ${unit}`
            : `${v >= 0 && unit === 'dB' ? '+' : ''}${v.toFixed(digits)} ${unit}`;

    function paintOut(el, lufs) {
        el.classList.remove('in-range', 'out-range');
        if (lufs === null || lufs === undefined) return;
        const lo = parseFloat(minInput.value);
        const hi = parseFloat(maxInput.value);
        if (Number.isNaN(lo) || Number.isNaN(hi)) return;
        el.classList.add(lufs >= lo && lufs <= hi ? 'in-range' : 'out-range');
    }

    function clearMeters(message) {
        mIn.textContent = '-- LUFS';
        mOut.textContent = '-- LUFS';
        mGain.textContent = '-- dB';
        mOffset.textContent = '-- dB';
        mLimit.textContent = '-- dB';
        mVocal.textContent = '--';
        mChain.textContent = '--';
        mOut.classList.remove('in-range', 'out-range');
        hint.textContent = message;
    }

    function poll() {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            const tab = tabs && tabs[0];
            if (!tab || !tab.id) return clearMeters('Không tìm thấy tab đang mở.');

            chrome.tabs.sendMessage(tab.id, { type: 'GET_STATUS' }, (res) => {
                if (chrome.runtime.lastError || !res) {
                    return clearMeters('Mở một video YouTube để bắt đầu đo.');
                }
                if (!res.active) {
                    return clearMeters('Chưa gắn vào player — hãy mở trang /watch hoặc /shorts.');
                }

                mIn.textContent = fmt(res.inLufs, 'LUFS');
                mOut.textContent = fmt(res.outLufs, 'LUFS');
                mGain.textContent = fmt(res.gainDb, 'dB', 2);
                mOffset.textContent = fmt(res.chainOffsetDb, 'dB', 2);
                mLimit.textContent = fmt(res.limiterDb, 'dB');
                mLimitLabel.textContent = res.trueLimiter
                    ? 'Limiter (brickwall 8ms)'
                    : 'Limiter (fallback)';
                mVocal.textContent = (res.vocalAmount === undefined || res.vocalAmount === null)
                    ? '--'
                    : `${(res.vocalAmount * 100).toFixed(0)}%` +
                      (res.vocalRatioDb === null || res.vocalRatioDb === undefined
                          ? '' : ` (tỉ lệ ${res.vocalRatioDb.toFixed(1)} dB)`);
                // Liệt kê khối đang thực sự chạy — trả lời trực tiếp câu
                // "sao nghe không thấy khác gì" bằng dữ kiện thay vì phỏng đoán.
                const blocks = [];
                if (res.intensity > 0) {
                    // Nén và bão hoà nay cũng tắt hẳn ở cường độ 0, nên khi
                    // cường độ > 0 chúng thuộc danh sách "đang thực sự chạy".
                    blocks.push('Nén', 'Bão hoà');
                    if (res.hasEnhance) blocks.push('Punch', 'De-harsh');
                    if (res.phantomOn) blocks.push('Trầm ảo');
                    if (res.hfOn) blocks.push('Air');
                    if (res.device === 'headphone') blocks.push('Crossfeed');
                }
                mChain.textContent = blocks.length ? blocks.join(' · ') : 'chỉ chuẩn hoá âm lượng';

                paintOut(mOut, res.outLufs);

                if (res.bypassed) {
                    hint.textContent = 'Đang BYPASS — số liệu là của tín hiệu gốc. Bấm nút xanh để so sánh.';
                } else if (!res.integrated) {
                    hint.textContent = 'Đang đo integrated loudness của bài…';
                } else if (res.locked) {
                    hint.textContent = 'Đã khoá mức cho bài này — âm lượng sẽ giữ nguyên tới hết bài.';
                } else {
                    hint.textContent = 'Đang chuẩn hoá theo LUFS integrated; sẽ khoá mức sau ~30 giây.';
                }

                // Đồng bộ nếu trạng thái bị đổi từ nơi khác
                if (res.bypassed !== isBypassed) {
                    isBypassed = res.bypassed;
                    renderBypass();
                }
            });
        });
    }

    poll();
    const pollTimer = setInterval(poll, 300);
    window.addEventListener('unload', () => clearInterval(pollTimer));
});
