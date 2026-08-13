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
    const hint = document.getElementById('hint');

    let isBypassed = false;

    const modes = {
        movie: { min: -24.0, max: -10.0 },
        music: { min: -18.0, max: -12.0 },
        podcast: { min: -16.0, max: -12.0 },
        night: { min: -24.0, max: -22.0 }
    };

    // --- Tải cấu hình ---
    chrome.storage.sync.get(['userTargetMin', 'userTargetMax', 'userMode', 'userBypass'], (data) => {
        modeSelect.value = data.userMode || 'podcast';
        if (data.userTargetMin !== undefined) minInput.value = data.userTargetMin;
        if (data.userTargetMax !== undefined) maxInput.value = data.userTargetMax;
        isBypassed = !!data.userBypass;
        renderBypass();
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
                    ? 'Limiter (brickwall 5ms)'
                    : 'Limiter (fallback)';
                paintOut(mOut, res.outLufs);

                hint.textContent = res.bypassed
                    ? 'Đang BYPASS — số liệu là của tín hiệu gốc. Bấm nút xanh để so sánh.'
                    : '"Độ lợi chain" là mức khuếch đại cố định do DSP tạo ra, AGC đã tự trừ đi.';

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
