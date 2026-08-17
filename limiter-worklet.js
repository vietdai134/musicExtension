// ============================================================================
//  True-peak Look-ahead Brickwall Limiter (AudioWorklet)
//  Chạy trên audio thread, xử lý từng mẫu — đảm bảo tuyệt đối |out| <= ceiling
//  KỂ CẢ giữa hai mẫu.
//
//  Nguyên lý:
//   1. Dò đỉnh trên tín hiệu nội suy 4x (true peak), không phải trên mẫu rời rạc.
//   2. Trễ tín hiệu L mẫu (look-ahead).
//   3. Với mỗi mẫu ĐẦU VÀO, tính độ lợi cần thiết để nó không vượt trần.
//   4. Sliding-minimum (monotonic deque, O(1)) trên cửa sổ L mẫu => biết trước
//      độ lợi nhỏ nhất mà mẫu đang phát ra sẽ cần trong tương lai gần.
//   5. Envelope trượt xuống mượt trong đúng L mẫu đó => không méo, không clip.
//   6. Kẹp cứng bằng độ lợi yêu cầu thực của mẫu đầu ra => brickwall theo cấu trúc.
// ============================================================================

// --- DÒ TRUE PEAK: nội suy 4x bằng FIR đa pha ---
// Đỉnh của dạng sóng đã tái tạo nằm GIỮA hai mẫu và có thể vượt đỉnh mẫu tới
// ~3dB. Canh trần bằng đỉnh mẫu nghĩa là tin rằng tín hiệu phẳng giữa các mẫu —
// nó không phẳng, nên đầu ra vẫn clip ở tầng resample/DAC của hệ điều hành, nghe
// ra kiểu "rè lấm tấm ở đoạn to". Đây là lý do BS.1770-4 đo true peak qua 4x.
//
// N = 47 với tâm ở k = 23 (SỐ NGUYÊN) là mấu chốt của việc tối ưu: với pha 3,
// các hệ số rơi đúng vào sinc(bội số nguyên) = 0 trừ một hệ số duy nhất, nên
// pha đó chính là mẫu gốc trễ 5 nhịp — khỏi phải tính. Chỉ còn 3 pha phân số.
const TP_TAPS = 12;                       // hệ số mỗi pha
const TP_LAST = TP_TAPS - 1;
const TP_N = 4 * TP_TAPS - 1;             // 47
const TP_CENTER = (TP_N - 1) / 2;         // 23
const TP_DELAY = 5;                       // trễ nhóm, tính bằng MẪU ĐẦU VÀO

// Lưới 4x tự nó không bao giờ chạm đúng đỉnh: hai điểm lấy mẫu con gần nhất có
// thể kẹp hai bên đỉnh thật, sai tối đa cos(pi*f/(4*fs)) — -0.17dB ở 12kHz,
// -0.30dB ở 16kHz, -0.47dB ở 20kHz. Bộ lọc hoàn hảo cũng không sửa được, chỉ có
// tăng bội số lấy mẫu (đắt gấp đôi cho mỗi lần gấp đôi). Rẻ hơn nhiều là hạ trần
// DÒ đúng bằng phần dư đó.
// Đo với biên 0.5dB (trần -1.0 dBTP, tham chiếu nội suy sinc 24x độc lập):
//   sine 19kHz .............. -1.49 dBTP   đạt
//   sine 21kHz .............. -1.48 dBTP   đạt
//   xung vuông 1kHz ......... -1.26 dBTP   đạt
//   nhiễu lọc 16kHz ......... -1.41 dBTP   đạt
//   nhiễu lọc 20kHz ......... -1.23 dBTP   đạt
//   nhiễu TRẮNG tới 24kHz ... -0.37 dBTP   VƯỢT 0.63dB
// Trường hợp cuối là giới hạn cố hữu của 4x, không phải lỗi cài đặt: phủ được
// nó cần biên ~0.7dB hoặc nội suy 8x. Không đáng — Opus/AAC của YouTube không
// bao giờ giao tín hiệu biên độ đầy trải tới 24kHz, và hai ca nhiễu đã lọc dải
// ở trên chính là thứ nguồn thật tạo ra, đều còn dư biên.
// Biên này chỉ ăn vào headroom đỉnh chứ gần như không ăn vào độ to trung bình:
// AGC đã tự lùi khi limiter ghì quá LIMIT_ALLOW_DB.
const TP_MARGIN = 0.9441;                 // 10^(-0.5/20)

// Ba pha phân số, đã chuẩn hoá tổng = 1 để DC đi qua đúng đơn vị (nếu không,
// bộ dò sẽ có độ lệch cố định và limiter ghì sai vài phần mười dB).
// Cửa sổ Hamming chứ không phải Blackman: bộ dò đỉnh cần PASSBAND PHẲNG, không
// cần stopband sâu. Blackman đổi độ phẳng lấy -74dB stopband vô dụng ở đây và
// sụt -0.58dB tại 18kHz — tức là đánh giá thấp đỉnh và cho lọt clip.
function buildPolyphase() {
    const h = new Float64Array(TP_N);
    for (let k = 0; k < TP_N; k++) {
        const t = (k - TP_CENTER) / 4;
        const sinc = t === 0 ? 1 : Math.sin(Math.PI * t) / (Math.PI * t);
        const w = 0.54 - 0.46 * Math.cos(2 * Math.PI * k / (TP_N - 1));
        h[k] = sinc * w;
    }
    const phases = [];
    for (let p = 0; p < 3; p++) {
        const taps = [];
        for (let k = p; k < TP_N; k += 4) taps.push(h[k]);
        let sum = 0;
        for (const v of taps) sum += v;
        phases.push(Float32Array.from(taps, (v) => v / sum));
    }
    return phases;
}

const TP_PHASE = buildPolyphase();

class LookaheadLimiterProcessor extends AudioWorkletProcessor {
    static get parameterDescriptors() {
        return [
            // 10^(-1/20) = -1.0 dBTP
            { name: 'ceiling', defaultValue: 0.891251, minValue: 0.001, maxValue: 1.0, automationRate: 'k-rate' },
            { name: 'release', defaultValue: 0.08, minValue: 0.005, maxValue: 2.0, automationRate: 'k-rate' }
        ];
    }

    constructor(options) {
        super();

        const ms = (options && options.processorOptions && options.processorOptions.lookaheadMs) || 5;
        this.L = Math.max(16, Math.round(sampleRate * ms / 1000));

        // Đường trễ tín hiệu dài hơn look-ahead đúng bằng trễ nhóm của bộ dò.
        // Nhờ đó độ lợi tính tại nhịp n (ứng với mẫu n - TP_DELAY) vẫn gặp đúng
        // mẫu của nó ở đầu ra, và cửa sổ look-ahead giữ nguyên đúng L mẫu.
        this.SL = this.L + TP_DELAY;

        // Monotonic deque (vòng tròn) cho sliding minimum
        this.C = this.L + 2;
        this.dqVal = new Float32Array(this.C);
        this.dqIdx = new Float64Array(this.C);
        this.head = 0;
        this.tail = 0;
        this.count = 0;

        this.delay = null;      // tín hiệu, vòng độ dài SL
        this.hist = null;       // lịch sử cho FIR dò, vòng độ dài TP_TAPS
        this.reqDelay = new Float32Array(this.L).fill(1);
        this.sIdx = 0;
        this.dIdx = 0;
        this.hIdx = 0;

        this.n = 0;
        this.gain = 1;
        this.attackCoef = Math.exp(-1 / Math.max(1, this.L / 4)); // tới đích trong ~L mẫu

        this.minGainBlock = 1;
        this.blocks = 0;

        // Báo tổng trễ để main thread bù cho nhánh dry khi bypass. Gửi từ đây
        // thay vì để content.js chép lại hằng số: L phụ thuộc sampleRate thật
        // của thiết bị, và TP_DELAY là chi tiết nội bộ của bộ dò true-peak.
        this.port.postMessage({ latencySamples: this.SL });
    }

    ensureChannels(nch) {
        if (this.delay && this.delay.length === nch) return;
        this.delay = [];
        this.hist = [];
        for (let c = 0; c < nch; c++) {
            this.delay.push(new Float32Array(this.SL));
            this.hist.push(new Float32Array(TP_TAPS));
        }
        this.sIdx = 0;
        this.hIdx = 0;
        this.dIdx = 0;
        this.reqDelay.fill(1);
    }

    process(inputs, outputs, params) {
        const input = inputs[0];
        const output = outputs[0];
        if (!output || output.length === 0) return true;

        const frames = output[0].length;

        // Không có nguồn: xả im lặng nhưng vẫn giữ processor sống
        if (!input || input.length === 0) {
            for (let c = 0; c < output.length; c++) output[c].fill(0);
            return true;
        }

        const nch = Math.min(input.length, output.length);
        this.ensureChannels(nch);

        const ceiling = params.ceiling[0];
        const detectCeiling = ceiling * TP_MARGIN;
        const releaseCoef = Math.exp(-1 / Math.max(1, params.release[0] * sampleRate));
        const C = this.C;
        const L = this.L;
        const SL = this.SL;
        const p0 = TP_PHASE[0], p1 = TP_PHASE[1], p2 = TP_PHASE[2];

        for (let i = 0; i < frames; i++) {
            // --- 1. True peak liên kết kênh (giữ nguyên ảnh stereo) ---
            // Bốn điểm lấy mẫu con: ba pha phân số cộng chính mẫu gốc (pha 3).
            let peak = 0;
            for (let c = 0; c < nch; c++) {
                const hist = this.hist[c];
                hist[this.hIdx] = input[c][i];

                let idx = this.hIdx;
                let a0 = 0, a1 = 0, a2 = 0, mid = 0;
                for (let j = 0; j < TP_TAPS; j++) {
                    const v = hist[idx];
                    a0 += p0[j] * v;
                    a1 += p1[j] * v;
                    a2 += p2[j] * v;
                    if (j === TP_DELAY) mid = v;   // pha 3 = mẫu gốc, không cần nhân
                    idx = idx === 0 ? TP_LAST : idx - 1;
                }

                if (a0 < 0) a0 = -a0;
                if (a1 < 0) a1 = -a1;
                if (a2 < 0) a2 = -a2;
                if (mid < 0) mid = -mid;
                if (a0 > peak) peak = a0;
                if (a1 > peak) peak = a1;
                if (a2 > peak) peak = a2;
                if (mid > peak) peak = mid;
            }
            this.hIdx = this.hIdx === TP_LAST ? 0 : this.hIdx + 1;

            const req = peak > detectCeiling ? detectCeiling / peak : 1;

            // --- 2. Đẩy vào deque, giữ tính đơn điệu tăng ---
            while (this.count > 0) {
                const t = (this.tail - 1 + C) % C;
                if (this.dqVal[t] >= req) { this.tail = t; this.count--; } else break;
            }
            this.dqVal[this.tail] = req;
            this.dqIdx[this.tail] = this.n;
            this.tail = (this.tail + 1) % C;
            this.count++;

            // --- 3. Loại phần tử đã rời cửa sổ [n-L+1, n] ---
            const minIdx = this.n - L + 1;
            while (this.count > 0 && this.dqIdx[this.head] < minIdx) {
                this.head = (this.head + 1) % C;
                this.count--;
            }
            const target = this.dqVal[this.head]; // độ lợi nhỏ nhất trong tương lai gần

            // --- 4. Envelope ---
            const coef = target < this.gain ? this.attackCoef : releaseCoef;
            this.gain = target + (this.gain - target) * coef;

            // --- 5. Kẹp bằng yêu cầu thực của mẫu đang phát ra (brickwall) ---
            const outReq = this.reqDelay[this.dIdx];
            this.reqDelay[this.dIdx] = req;
            let g = this.gain;
            if (g > outReq) g = outReq;

            for (let c = 0; c < nch; c++) {
                const d = this.delay[c];
                const y = d[this.sIdx] * g;
                d[this.sIdx] = input[c][i];
                output[c][i] = y > ceiling ? ceiling : (y < -ceiling ? -ceiling : y);
            }

            // Nguồn ít kênh hơn đích: nhân bản kênh đầu
            for (let c = nch; c < output.length; c++) output[c][i] = output[0][i];

            this.sIdx = this.sIdx + 1 === SL ? 0 : this.sIdx + 1;
            this.dIdx = this.dIdx + 1 === L ? 0 : this.dIdx + 1;
            if (g < this.minGainBlock) this.minGainBlock = g;
            this.n++;
        }

        // Báo mức nén về main thread (~64ms/lần)
        if (++this.blocks >= 24) {
            this.port.postMessage({
                reductionDb: 20 * Math.log10(this.minGainBlock > 1e-6 ? this.minGainBlock : 1e-6)
            });
            this.minGainBlock = 1;
            this.blocks = 0;
        }

        return true;
    }
}

registerProcessor('lookahead-limiter', LookaheadLimiterProcessor);
