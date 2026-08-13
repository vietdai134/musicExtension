// ============================================================================
//  Enhance Worklet — Transient Shaper + Dynamic De-harsh
//  Hai việc này KHÔNG dựng được bằng node có sẵn:
//   - Web Audio không có upward expansion, nên không tạo được punch.
//   - Web Audio không có sidechain, nên không có dynamic EQ thật.
//  Cả hai đều là toán envelope từng mẫu => phải chạy trên audio thread.
// ============================================================================

// Bộ dò envelope hai hằng số thời gian, dùng chung cho cả hai tầng.
function coef(ms) {
    return Math.exp(-1 / Math.max(1, sampleRate * ms / 1000));
}

class EnhanceProcessor extends AudioWorkletProcessor {
    static get parameterDescriptors() {
        return [
            // 0 = tắt hẳn (đường tín hiệu trở thành y hệt đầu vào, không phải "gần giống")
            { name: 'punch', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
            { name: 'sustain', defaultValue: 0, minValue: -1, maxValue: 1, automationRate: 'k-rate' },
            { name: 'deharsh', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' }
        ];
    }

    constructor() {
        super();

        // --- Tầng 1: transient. Nhanh bám kịp cú gõ, chậm bám mức nền.
        // Tỉ số nhanh/chậm > 1 nghĩa là đang có transient.
        //
        // Cả hai envelope BẮT BUỘC đối xứng (attack = release). Envelope bất
        // đối xứng với attack chậm không bao giờ leo tới đỉnh của tín hiệu tuần
        // hoàn, nên nó luôn nằm dưới envelope nhanh và tỉ số luôn > 1 — hệ quả
        // là nhạc ổn định bị coi là transient và bị đẩy lên (+0.66dB đo được).
        // Một pole đối xứng trên |x| hội tụ về đúng trung bình |x| bất kể hằng
        // số thời gian, nên hai envelope bằng nhau tuyệt đối khi tín hiệu đứng
        // yên — ở MỌI tần số, không riêng tần số nào.
        // Gợn sóng trong bộ dò là cái bẫy thứ hai. Ở 60Hz, envelope nhanh một
        // cực vẫn bám theo dạng sóng; vì punch>0 còn sustain=0 nên nó CHỈ
        // khuếch đại nửa dương của gợn — chỉnh lưu thành mức tăng ròng
        // (+0.61dB đo được ở 60Hz). Hai lớp phòng vệ:
        //  1. lọc thông cao 120Hz cho ĐƯỜNG DÒ (không đụng đường tín hiệu),
        //  2. envelope nhanh hai cực, dốc gấp đôi ở dải gợn còn sót.
        this.setDetectorHp(120, 0.7);
        this.hpS = [];
        // 1.5ms/knee 6 là điểm quét ra tốt nhất: +3.2dB độ nảy, sai lệch tệ
        // nhất 0.17dB. Nhanh hơn (1.0ms) chỉ thêm 0.5dB nhưng sai lệch gấp đôi.
        this.fast = coef(1.5);
        this.slow = coef(70);
        this.envFast = 0; this.envFast2 = 0; this.envSlow = 0;
        this.tGain = 1;
        this.tSmooth = coef(0.5);   // chống zipper noise khi gain nhảy
        // Đầu cú gõ cho tỉ số tới ~12 lần; ánh xạ thẳng sẽ luôn chạm trần.
        // Hàm bão hoà này chặn độ lợi ở 1 + punch*KNEE mà vẫn mượt.
        this.punchKnee = 6;

        // --- Tầng 2: de-harsh. Bandpass 3.5kHz Q1 (~2–6kHz), nơi nén lossy để
        // lại artifact và nơi tai người nhạy nhất.
        this.bp = [];               // trạng thái biquad từng kênh
        this.setBandpass(3500, 1.0);
        this.bandFast = 0; this.bandSlow = 0;
        this.bandFastC = coef(5);    // đối xứng, cùng lý do như tầng 1
        this.bandSlowC = coef(400);
        this.dGain = 1;
        this.dSmooth = coef(1.5);

        // Ngưỡng TƯƠNG ĐỐI: dải này vọt lên hơn +6dB so với mức trung bình của
        // chính nó thì mới coi là chói. Tuyệt đối thì phụ thuộc mức nguồn,
        // mà node này nằm TRƯỚC AGC nên mức nguồn chưa được chuẩn hoá.
        this.harshThresh = 2.0;     // 2.0 lần = +6dB

        this.nch = 0;
    }

    setBandpass(f0, Q) {
        const w = 2 * Math.PI * f0 / sampleRate;
        const a = Math.sin(w) / (2 * Q);
        const c = Math.cos(w);
        const a0 = 1 + a;
        this.b0 = a / a0;
        this.b1 = 0;
        this.b2 = -a / a0;
        this.a1 = -2 * c / a0;
        this.a2 = (1 - a) / a0;
    }

    setDetectorHp(f0, Q) {
        const w = 2 * Math.PI * f0 / sampleRate;
        const a = Math.sin(w) / (2 * Q);
        const c = Math.cos(w);
        const a0 = 1 + a;
        this.hb0 = (1 + c) / 2 / a0;
        this.hb1 = -(1 + c) / a0;
        this.hb2 = (1 + c) / 2 / a0;
        this.ha1 = -2 * c / a0;
        this.ha2 = (1 - a) / a0;
    }

    ensure(nch) {
        if (this.nch === nch) return;
        this.nch = nch;
        this.bp = [];
        this.hpS = [];
        for (let c = 0; c < nch; c++) {
            this.bp.push({ x1: 0, x2: 0, y1: 0, y2: 0 });
            this.hpS.push({ x1: 0, x2: 0, y1: 0, y2: 0 });
        }
        this.band = new Float32Array(nch);
    }

    process(inputs, outputs, params) {
        const input = inputs[0];
        const output = outputs[0];
        if (!output || output.length === 0) return true;

        const frames = output[0].length;
        if (!input || input.length === 0) {
            for (let c = 0; c < output.length; c++) output[c].fill(0);
            return true;
        }

        const nch = Math.min(input.length, output.length);
        this.ensure(nch);

        const punch = params.punch[0];
        const sustain = params.sustain[0];
        const deharsh = params.deharsh[0];
        const bypass = punch === 0 && sustain === 0 && deharsh === 0;

        // Tắt hẳn = chép nguyên bản. Không để tín hiệu đi qua bộ lọc "trung tính"
        // vì biquad trung tính vẫn có sai số tích luỹ và trễ pha.
        if (bypass) {
            for (let c = 0; c < nch; c++) output[c].set(input[c]);
            for (let c = nch; c < output.length; c++) output[c].set(output[0]);
            this.envFast = this.envFast2 = this.envSlow = this.bandFast = this.bandSlow = 0;
            this.tGain = this.dGain = 1;
            return true;
        }

        for (let i = 0; i < frames; i++) {
            // --- Đỉnh liên kết kênh: giữ nguyên ảnh stereo, không để hai kênh
            // bị điều chế lệch nhau thành hiện tượng ảnh nhảy trái phải.
            // Lọc thông cao chỉ áp cho ĐƯỜNG DÒ; tín hiệu ra vẫn đủ dải.
            let peak = 0;
            for (let c = 0; c < nch; c++) {
                const s = this.hpS[c];
                const x = input[c][i];
                const y = this.hb0 * x + this.hb1 * s.x1 + this.hb2 * s.x2 - this.ha1 * s.y1 - this.ha2 * s.y2;
                s.x2 = s.x1; s.x1 = x; s.y2 = s.y1; s.y1 = y;
                const a = y < 0 ? -y : y;
                if (a > peak) peak = a;
            }

            // --- TẦNG 1: TRANSIENT ---
            this.envFast = peak + (this.envFast - peak) * this.fast;
            this.envFast2 = this.envFast + (this.envFast2 - this.envFast) * this.fast;
            this.envSlow = peak + (this.envSlow - peak) * this.slow;

            let tTarget = 1;
            if (this.envSlow > 1e-6) {
                // Làm hoàn toàn trong miền tuyến tính: không log/exp mỗi mẫu.
                // r = 1 khi tín hiệu ổn định => gain đúng bằng 1, không tô màu.
                const d = this.envFast2 / this.envSlow - 1;
                const shaped = d > 0
                    ? d / (1 + d / this.punchKnee)
                    : d / (1 - d / this.punchKnee);
                tTarget = 1 + (d > 0 ? punch : sustain) * shaped;
                if (tTarget > 3) tTarget = 3;
                else if (tTarget < 0.3) tTarget = 0.3;
            }
            this.tGain = tTarget + (this.tGain - tTarget) * this.tSmooth;

            // --- TẦNG 2: DE-HARSH ---
            // Lọc từng kênh nhưng dùng CHUNG một hệ số gain lấy từ đỉnh liên kết.
            let bandPeak = 0;
            const band = this.band;
            for (let c = 0; c < nch; c++) {
                const s = this.bp[c];
                const x = input[c][i];
                const y = this.b0 * x + this.b1 * s.x1 + this.b2 * s.x2 - this.a1 * s.y1 - this.a2 * s.y2;
                s.x2 = s.x1; s.x1 = x; s.y2 = s.y1; s.y1 = y;
                band[c] = y;
                const a = y < 0 ? -y : y;
                if (a > bandPeak) bandPeak = a;
            }

            this.bandFast = bandPeak + (this.bandFast - bandPeak) * this.bandFastC;
            this.bandSlow = bandPeak + (this.bandSlow - bandPeak) * this.bandSlowC;

            let dTarget = 1;
            if (deharsh > 0 && this.bandSlow > 1e-6) {
                const excess = this.bandFast / (this.bandSlow * this.harshThresh);
                if (excess > 1) dTarget = 1 - deharsh * (1 - 1 / excess);
            }
            this.dGain = dTarget + (this.dGain - dTarget) * this.dSmooth;

            // out = x + (g-1)*band. Khi g = 1 thì ra ĐÚNG BẰNG x — không có
            // comb filter, không lệch pha. Đây là lý do phải cộng phần chênh
            // lệch thay vì trừ dải rồi cộng dải đã nén trở lại.
            const dg = this.dGain - 1;
            for (let c = 0; c < nch; c++) {
                output[c][i] = (input[c][i] + dg * band[c]) * this.tGain;
            }
            for (let c = nch; c < output.length; c++) output[c][i] = output[0][i];
        }

        return true;
    }
}

registerProcessor('enhance', EnhanceProcessor);
