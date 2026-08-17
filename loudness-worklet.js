// ============================================================================
//  Loudness Meter (AudioWorklet) — block BS.1770-4 đúng chuẩn
//
//  Vì sao phải là worklet chứ không phải AnalyserNode + setInterval:
//   1. AnalyserNode chỉ đưa ra CỬA SỔ MỚI NHẤT tại đúng thời điểm gọi. Timer
//      trên main thread bị GC, layout của YouTube và throttle của tab đẩy đi
//      vài chục ms mỗi lần, nên các block đo ra chồng lấn không đều — trong
//      khi bộ tích phân có cổng lại coi mỗi block là một mẫu thống kê ngang
//      quyền nhau. Sai số đó rơi thẳng vào số LUFS mà AGC lái theo.
//   2. BS.1770-4 quy định block 400ms chồng lấn 75%. Bản cũ lấy cửa sổ 341ms
//      (FFT 16384 @48kHz) mỗi 200ms, tức chồng ~41% — không phải cùng một
//      phép đo, và ngưỡng cổng tương đối -10 LU được hiệu chuẩn cho 75%.
//   3. Ở đây không mất mẫu nào: worklet thấy từng render quantum liên tục.
//
//  Chồng lấn 75% của cửa sổ 400ms chính là bốn đoạn 100ms liền nhau. Nên chỉ
//  cần cộng dồn năng lượng từng đoạn 100ms rồi giữ lại bốn đoạn gần nhất —
//  O(1) bộ nhớ, không cần vòng đệm 400ms, và mỗi 100ms phát ra đúng một block.
// ============================================================================

const HOP_SEC = 0.1;      // bước nhảy: 400ms chồng 75% => 100ms
const SLOTS = 4;          // 4 x 100ms = cửa sổ 400ms

class LoudnessProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this.hop = Math.max(1, Math.round(sampleRate * HOP_SEC));
        this.slots = new Float64Array(SLOTS);
        this.slot = 0;
        this.filled = 0;
        this.acc = 0;      // tổng bình phương của đoạn đang gom
        this.count = 0;
    }

    process(inputs) {
        const input = inputs[0];
        // Không ghi gì vào output: node này chỉ để đo. Output tồn tại và được
        // nối vào một gain 0 chỉ để đồ thị chắc chắn kéo processor chạy.
        if (!input || input.length === 0) return true;

        const L = input[0];
        if (!L) return true;
        // stereoForce phía trước đã ép 2 kênh. Nguồn mono được upmix thành
        // L = R, và BS.1770 khi đó cộng năng lượng hai kênh giống nhau —
        // giữ nguyên hành vi của bản dùng AnalyserNode + ChannelSplitter.
        const R = input.length > 1 ? input[1] : L;
        const frames = L.length;

        for (let i = 0; i < frames; i++) {
            const l = L[i], r = R[i];
            // BS.1770: trọng số kênh L và R đều bằng 1, nên cộng thẳng.
            // Cộng năng lượng ở miền TUYẾN TÍNH; đổi sang dB rồi mới cộng là
            // sai về mặt vật lý.
            this.acc += l * l + r * r;

            if (++this.count === this.hop) {
                this.slots[this.slot] = this.acc;
                this.slot = this.slot === SLOTS - 1 ? 0 : this.slot + 1;
                if (this.filled < SLOTS) this.filled++;
                this.acc = 0;
                this.count = 0;

                if (this.filled === SLOTS) {
                    let sum = 0;
                    for (let k = 0; k < SLOTS; k++) sum += this.slots[k];
                    // Chia cho SỐ MẪU MỖI KÊNH: sumL/n + sumR/n = (sumL+sumR)/n
                    this.port.postMessage({ ms: sum / (SLOTS * this.hop) });
                }
            }
        }

        return true;
    }
}

registerProcessor('loudness', LoudnessProcessor);
