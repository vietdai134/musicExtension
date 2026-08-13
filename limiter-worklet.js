// ============================================================================
//  True Look-ahead Brickwall Limiter (AudioWorklet)
//  Chạy trên audio thread, xử lý từng mẫu — đảm bảo tuyệt đối |out| <= ceiling.
//
//  Nguyên lý:
//   1. Trễ tín hiệu L mẫu (look-ahead).
//   2. Với mỗi mẫu ĐẦU VÀO, tính độ lợi cần thiết để nó không vượt trần.
//   3. Sliding-minimum (monotonic deque, O(1)) trên cửa sổ L mẫu => biết trước
//      độ lợi nhỏ nhất mà mẫu đang phát ra sẽ cần trong tương lai gần.
//   4. Envelope trượt xuống mượt trong đúng L mẫu đó => không méo, không clip.
//   5. Kẹp cứng bằng độ lợi yêu cầu thực của mẫu đầu ra => brickwall theo cấu trúc.
// ============================================================================

class LookaheadLimiterProcessor extends AudioWorkletProcessor {
    static get parameterDescriptors() {
        return [
            // 10^(-1/20) = -1.0 dBFS
            { name: 'ceiling', defaultValue: 0.891251, minValue: 0.001, maxValue: 1.0, automationRate: 'k-rate' },
            { name: 'release', defaultValue: 0.08, minValue: 0.005, maxValue: 2.0, automationRate: 'k-rate' }
        ];
    }

    constructor(options) {
        super();

        const ms = (options && options.processorOptions && options.processorOptions.lookaheadMs) || 5;
        this.L = Math.max(16, Math.round(sampleRate * ms / 1000));

        // Monotonic deque (vòng tròn) cho sliding minimum
        this.C = this.L + 2;
        this.dqVal = new Float32Array(this.C);
        this.dqIdx = new Float64Array(this.C);
        this.head = 0;
        this.tail = 0;
        this.count = 0;

        // Đường trễ
        this.delay = null;
        this.reqDelay = new Float32Array(this.L).fill(1);
        this.dIdx = 0;

        this.n = 0;
        this.gain = 1;
        this.attackCoef = Math.exp(-1 / Math.max(1, this.L / 4)); // tới đích trong ~L mẫu

        this.minGainBlock = 1;
        this.blocks = 0;
    }

    ensureChannels(nch) {
        if (this.delay && this.delay.length === nch) return;
        this.delay = [];
        for (let c = 0; c < nch; c++) this.delay.push(new Float32Array(this.L));
        this.dIdx = 0;
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
        const releaseCoef = Math.exp(-1 / Math.max(1, params.release[0] * sampleRate));
        const C = this.C;
        const L = this.L;

        for (let i = 0; i < frames; i++) {
            // --- 1. Đỉnh liên kết kênh (giữ nguyên ảnh stereo) ---
            let peak = 0;
            for (let c = 0; c < nch; c++) {
                const a = input[c][i] < 0 ? -input[c][i] : input[c][i];
                if (a > peak) peak = a;
            }
            const req = peak > ceiling ? ceiling / peak : 1;

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
                const y = d[this.dIdx] * g;
                d[this.dIdx] = input[c][i];
                output[c][i] = y > ceiling ? ceiling : (y < -ceiling ? -ceiling : y);
            }

            // Nguồn ít kênh hơn đích: nhân bản kênh đầu
            for (let c = nch; c < output.length; c++) output[c][i] = output[0][i];

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
