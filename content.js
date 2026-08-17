// ============================================================================
//  Smart LUFS Normalizer Pro — v5.4
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
//
//  v4.6 — ba lỗi kỹ thuật, sửa xong không đổi "gu" âm thanh, chỉ hết sai:
//   1. Xếp N biquad Q=0.707 GIỐNG NHAU không ra Butterworth bậc 2N. Bốn tầng
//      thành -12dB ngay tại f0 và điểm -3dB trôi lên ~1.5x. Hậu quả: HP 130Hz
//      của Phantom Bass thực chất cắt ở 197Hz, chém mất -12..-4dB đúng dải
//      130–180Hz nơi hài bậc 2 của bass rơi vào — tức là chém đúng thứ nó sinh
//      ra để giữ; HP 7.5kHz của HF Exciter thực chất ở ~9.7kHz, vứt gần hết hài
//      7–10kHz; và dải trích "3.5–6.5kHz" thực chất chỉ còn ~4.3–5.3kHz.
//      Sửa: chia cực Butterworth, mỗi tầng một Q. Cùng số biquad, cùng CPU.
//   2. Limiter dò đỉnh trên mẫu rời rạc => đỉnh giữa hai mẫu vượt trần tới ~1dB
//      và clip ở tầng resample/DAC. Sửa: dò true peak qua nội suy 4x (BS.1770-4).
//   3. AudioContext để latencyHint mặc định 'interactive' cho buffer 128–256 mẫu,
//      quá ngặt cho chain ~45 node + 2 worklet per-sample => trượt deadline,
//      nghe ra tiếng lụp bụp. Sửa: 'playback'.
//
//  v4.7 — trả lại quyền kiểm soát độ nén cho người dùng:
//   1. Nén multiband trước đây đặt cứng MỘT LẦN lúc dựng graph: kéo cường độ về
//      0% vẫn nén 4:1, và "Đêm" dùng y hệt setting nén như "Nhạc" dù hai chế độ
//      này yêu cầu ngược nhau. Nay có COMP_PROFILE theo chế độ, và cường độ co
//      tỉ số về 1.0 (= không nén chút nào, đo được chính xác 1.00 ở mọi dải).
//   2. compHigh là de-esser 4:1 attack 1ms/release 50ms áp lên TOÀN BỘ dải
//      >4kHz — cymbal bị ghì rồi nhả trong 50ms, mất đuôi ngân. Việc dò
//      sibilance đã có deharsh trong worklet lo đúng cách nên hạ về band
//      compressor bình thường: tỉ số 1.8–3.5, attack 3ms, release 120ms.
//   3. Bão hoà trước đây luôn bật bất kể cường độ. makeSaturationCurve rút gọn
//      thành x*pi/(pi + k*|x|), nên k = 0 cho ĐÚNG hàm đồng nhất — chỉ cần co k
//      theo cường độ là tắt được tuyệt đối, không cần nhánh dry/wet song song
//      (nhánh song song sẽ comb filter vì WaveShaper oversample 4x có trễ riêng).
//
//  v4.8 — đưa phép đo loudness xuống audio thread:
//   1. AnalyserNode chỉ đưa ra cửa sổ MỚI NHẤT tại thời điểm gọi, nên timer
//      jitter trên main thread làm các block đo chồng lấn không đều — trong khi
//      bộ tích phân có cổng coi mọi block là mẫu thống kê ngang quyền. Sai số
//      đó rơi thẳng vào số LUFS mà AGC lái theo. Nay loudness-worklet.js tích
//      luỹ năng lượng trên audio thread, không mất mẫu nào.
//   2. Block nay đúng BS.1770-4: cửa sổ 400ms chồng lấn 75% (bản cũ 341ms mỗi
//      200ms = chồng ~41%, trong khi ngưỡng cổng tương đối -10 LU được hiệu
//      chuẩn cho 75%). Chồng lấn 75% của cửa sổ 400ms chính là bốn đoạn 100ms
//      liền nhau, nên chỉ cần giữ bốn tổng năng lượng — O(1) bộ nhớ.
//   3. Các hằng số thời gian nay suy ra TỪ nhịp block (lufsBlockDt) chứ không
//      đếm block, nên đổi nhịp 200ms -> 100ms không âm thầm đổi ý nghĩa của
//      chúng. LUFS_TC_* tái lập chính xác alpha đã hiệu chỉnh của bản 200ms.
//   4. Giữ nhánh dự phòng AnalyserNode: hai worklet kia hỏng thì bỏ tính năng
//      được, còn bộ đo hỏng thì AGC chết hẳn.
//
//  v4.9 — bốn chỗ nhỏ hơn, đều là "làm đúng ý đồ sẵn có":
//   1. exciterAir là highshelf 12kHz: với +3dB danh nghĩa thì tại 12kHz mới
//      được +1.50dB, phải tới 16kHz mới đạt +2.46dB — mà Opus/AAC của YouTube
//      đã cắt gần sạch trên 16kHz, nên phần lớn độ nâng rơi vào nhiễu mã hoá.
//      Hạ về 9kHz để độ nâng rơi vào chỗ còn tín hiệu.
//   2. Nới rộng Side dựng bằng cách CỘNG SONG SONG nhánh HP300 vào nhánh HP40.
//      Hai bộ lọc lệch điểm cắt thì lệch pha trong vùng chuyển: lệch tới
//      -1.13dB so với ý đồ, và ở 100–200Hz nó CẮT phần Side đáng lẽ để phẳng.
//      Ý đồ vốn là một highshelf — nay dựng đúng bằng highshelf nối tiếp.
//   3. Nhánh dry (bypass) không bù trễ, lệch nhánh wet 8.1ms. Crossfade hai bản
//      sao tương quan cao lệch 8.1ms => comb filter, hõm đầu ở 62Hz. Limiter
//      nay tự báo độ trễ của nó về qua port và nhánh dry được bù đúng bằng đó.
//   4. resetTrackState không xoá vocalAmount, mà TC của nó là ~7s: bài mới thừa
//      hưởng tới 4.5dB EQ của bài cũ trong nhiều giây đầu. (phantomGainDb và
//      hfGainDb thì cố ý KHÔNG reset — xem ghi chú tại chỗ.)
//
//  v5.0 — ĐÚNG VIỆC CHÍNH CỦA APP: mức ổn định khi chuyển bài.
//  Đo bằng mô phỏng chạy chính vòng điều khiển này (6 bài, nguồn -27..-9 LUFS):
//  bản cũ cho các bài rơi vào -16.00 hoặc -12.00 => LUÔN chênh nhau 4.00dB.
//   1. NGUYÊN NHÂN LỚN NHẤT, và không phải hiện tượng nhất thời: AGC kéo bài
//      nhỏ lên đúng TARGET_MIN và ép bài to xuống đúng TARGET_MAX. Cả hai đều
//      "đạt" nhưng cách nhau đúng bề rộng cửa sổ. Nay đã phải chỉnh thì chỉnh
//      về GIỮA cửa sổ => 6 bài đó tụ lại trong 0.78dB. Cửa sổ vẫn còn tác dụng
//      deadband: nằm trong thì không đụng, khỏi chỉnh vặt.
//   2. Bài mới kế thừa nguyên độ lợi của bài cũ (currentAppliedGainDb không hề
//      được reset). Bài cũ là bản thu nhỏ cần +9dB thì bài mới lãnh đủ +9dB đó.
//      Nay hạ về prior học qua các bài, rồi ducking thêm 6dB cho quãng mù.
//   3. Slew đối xứng 1.5dB/s: phát hiện quá to rồi vẫn phải mất ~9s mới hạ
//      xong, và tai chịu suốt 9s đó. Nay hạ 6dB/s, lên vẫn 1.5dB/s.
//   4. Watcher poll 500ms là quá chậm — bài mới đã phát rồi mới reset. Nay bắt
//      'loadstart'/'emptied' của thẻ video, bắn trước khi có mẫu nào ra loa.
//   5. Cửa sổ 400ms của bộ đo còn chứa audio BÀI CŨ sau khi chuyển; nay xả, và
//      worklet phát block partial để có ước lượng sau ~100ms thay vì 400ms.
//   6. Mấy giây đầu một bài không đại diện cho cả bài (intro nhẹ). Khi số đo
//      còn non thì cố ý nhắm thấp hơn, cộng một chốt chặn theo mức tức thời
//      chỉ hạ chứ không nâng. Đo: nhạc verse/chorus chênh 8dB mỗi 8s làm độ
//      lợi dao động 0.00dB => chốt chặn không biến AGC thành compressor.
//
//  v5.1 — gỡ khoá cứng vào YouTube.
//  App này không phải chỉ để cho YouTube, nên phần phụ thuộc trang được gom hết
//  vào SITE_ADAPTERS ở mục 10. Mọi thứ khác — đo LUFS, AGC, limiter, chuỗi DSP
//  — không biết gì về YouTube và không cần biết. Trước đây có 5 chỗ khoá cứng
//  nằm rải rác: isPlayerPage, getVideoId, getMainVideo, sự kiện
//  'yt-navigate-finish', và các selector ytd-*/movie_player.
//  Adapter tổng quát không đoán cấu trúc DOM của trang (mỗi trang một kiểu,
//  đoán là sai) mà chỉ dựa vào chính các thẻ media: loại thẻ chưa nạp xong,
//  thẻ câm, và thẻ ngắn hơn 20s (thường là quảng cáo hoặc tiếng thông báo);
//  trong số còn lại thì ưu tiên thẻ ĐANG PHÁT, rồi tới thẻ hiển thị to nhất.
//  Dè dặt là bắt buộc: createMediaElementSource không hoàn tác được, gắn nhầm
//  là hỏng vĩnh viễn thẻ đó cho tới khi tải lại trang.
//  Thêm một trang mới giờ là: thêm một mục vào SITE_ADAPTERS (nếu trang cần xử
//  lý riêng) + thêm match vào manifest. Không phải sửa gì trong phần âm thanh.
//
//  v5.2 — HẾT "to nhỏ thất thường": sửa TOPOLOGY, không phải chỉnh hằng số.
//  Các bản trước chữa triệu chứng bằng cách chỉnh hằng số thời gian của mấy
//  vòng lặp. Không bao giờ hết được, vì lỗi nằm ở THỨ TỰ của chuỗi.
//
//  Đo bằng mô phỏng có mô hình chain PHỤ THUỘC MỨC (mô phỏng của v5.0 coi chain
//  là hằng số +2dB nên đã che mất đúng loại lỗi này). Chỉ số: nhạc 4 đoạn
//  -26..-12 LUFS, hỏi "cùng một mức nguồn thì mức ra có lặp lại được không".
//    v5.1 ......................... 7.96dB   <- chính là cái nghe thấy
//    v5.2 ......................... 0.19dB
//
//   1. agcGain nằm ở CUỐI chuỗi, nên multiband compressor nhìn thấy mức NGUỒN
//      THÔ. Bài -27 LUFS gần như không bị nén, bài -9 LUFS bị nén mạnh; trong
//      cùng một bài thì đoạn nhẹ và đoạn mạnh cũng khác nhau. Độ lợi chain vì
//      thế biến thiên hơn 10dB, mà chainOffsetDb chỉ là MỘT số vô hướng cố mô
//      hình hoá tất cả chỗ đó — mô hình không nổi. Chuyển AGC lên ĐẦU chuỗi:
//      chuẩn hoá trước rồi mới xử lý, đúng thứ tự của một chuỗi mastering.
//   2. chainOffsetDb học từ momentary (TC ~3-4s) nên nó bám theo TỪNG ĐOẠN
//      NHẠC thay vì là hằng số của chain, kéo AGC thành compressor rất chậm.
//      Nay học từ integrated — số có cổng, của cả bài.
//   3. Auto-makeup bám theo comp.reduction là MỘT VÒNG LẶP CHẬM THỨ HAI chạy
//      song song với AGC; hai vòng đuổi nhau. Chỉnh TC (2.5s -> 20s ở các bản
//      trước) chỉ đổi chu kỳ đuổi chứ không bỏ được nó. Nay makeup suy thẳng
//      từ ngưỡng/tỉ số hiệu dụng tại MAKEUP_REF_DB: không đo thì không có vòng
//      lặp. Chỉ có nghĩa nhờ (1) — compressor luôn nhận tín hiệu đã chuẩn hoá.
//   4. Bỏ lớp "nhắm thấp khi số đo còn non" của v5.0. Nó đổi một cú vọt CHỈ
//      xảy ra ở bài có intro nhẹ lấy một cú trôi ĐẢM BẢO CÓ Ở MỌI BÀI: đo được
//      gain bò 8.05 -> 10.84dB suốt 16 giây đầu trên nguồn đứng yên hoàn toàn.
//      Sau (1) thì compressor tự hấp thụ cú nhảy intro -> thân bài (đỉnh chỉ
//      còn vượt 1.2dB trong 4.3s, trước là 7.3dB trong 10.8s) nên hết cần.
//
//  Lưu ý khi đọc số: độ lợi CHAIN vẫn biến thiên ~9dB theo mức vào. Đó là
//  compressor đang làm đúng việc của nó. Khác biệt là nay nó là HÀM THUẦN của
//  mức vào — lặp lại được — chứ không phụ thuộc đoạn nhạc vừa phát trước đó.
//
//  v5.3 — "mới vô rất to rồi nhỏ dần": fastLock nhảy cóc LÊN.
//  Mấy trăm ms tới vài giây đầu một video thường rất khẽ — fade-in, logo, im
//  lặng trước khi nhạc vào. Chưa có integrated nên AGC lấy momentary của đúng
//  đoạn khẽ đó làm mức của cả bài, rồi fastLock CHỐT THẲNG độ lợi tính ra —
//  kịch trần +24dB. Tới khi nhạc thật vào thì đã muộn, và phải mất cả chục
//  giây bò về. Đo với 3 giây khẽ ở đầu: vọt lên -6.76 LUFS rồi ~10s mới về.
//  Sửa: fastLock giữ nguyên tính bất đối xứng của phần còn lại — HẠ tức thì
//  (sai theo hướng to mới hại tai), NÂNG có trần tốc độ. Dò 2/3/4/6 dB/s:
//    2 dB/s -> vọt 0.82dB, bài khẽ vẫn lên đúng mức sau 0.4s
//    4 dB/s -> vọt 2.84dB
//    6 dB/s -> vọt 4.63dB
//  Chọn 2 dB/s: bảo vệ tốt nhất mà không chậm đi (nhờ prior nên khoảng cách
//  cần đi thường rất ngắn; chỉ bài ĐẦU TIÊN sau khi cài mới phải đi xa).
//
//  Ghi chú về công cụ đo: mô hình chain của các mô phỏng trước cho cả ba băng
//  nhận CÙNG mức với tín hiệu full-band. Sai — crossover chia phổ nên mỗi băng
//  nằm thấp hơn mức full-band nhiều, tức là thấp hơn ngưỡng compressor hơn
//  nhiều. Mô hình sai đánh giá quá cao mức nén và cho ra chiều NGƯỢC LẠI với
//  thực tế. Nay dùng chung một mô hình có offset và trọng số năng lượng theo
//  băng, và mọi mô phỏng đều require nó để không lệch nhau.
// ============================================================================

// --- 1. HẰNG SỐ ĐIỀU KHIỂN ---
const TICK_MS = 200;
const FFT_SIZE = 16384;              // chỉ dùng cho nhánh dự phòng AnalyserNode (~341ms @48kHz)
const ABS_GATE_LUFS = -55;
const DEADBAND_OPEN_DB = 1.0;
const DEADBAND_CLOSE_DB = 0.15;

// --- Integrated loudness (BS.1770-4) ---
// AGC PHẢI lái bằng integrated, không phải momentary. Loudness momentary của
// nhạc chênh ±10dB giữa đoạn nhẹ và điệp khúc; bám theo nó với TC ~4s thì AGC
// biến thành một compressor rất chậm — nghe ra đúng là "nhỏ to thất thường".
// Integrated đo cả bài, có cổng, cho MỘT con số ổn định để khoá vào.
const INTEG_MAX_BLOCKS = 9000;       // ring ~15 phút @100ms; dài hơn thì lịch sử cũ đóng băng AGC
const INTEG_MIN_SEC = 1.6;           // đo đủ ngần này mới đủ tin cậy
const REL_GATE_LIN = Math.pow(10, -10 / 10);  // cổng tương đối -10 LU

// Nhịp giữa hai block loudness. Worklet phát mỗi 100ms (BS.1770-4: cửa sổ
// 400ms chồng lấn 75%); nhánh dự phòng bằng AnalyserNode chạy theo tick 200ms.
// Mọi hằng số thời gian bên dưới suy ra TỪ giá trị này chứ không phải đếm
// block, để đổi nhịp không âm thầm đổi luôn ý nghĩa của chúng.
let lufsBlockDt = 0.1;

// Hằng số thời gian làm mượt momentary, tính bằng GIÂY. Các số này giữ đúng
// hành vi đã hiệu chỉnh của bản 200ms (alpha 0.35 / 0.07 / 0.05 / 0.06).
const LUFS_TC_FAST = 0.4642;         // trong FAST_LOCK, bám nhanh cho kịp đầu bài
const LUFS_TC_UP = 2.7559;           // mức đang tăng
const LUFS_TC_DOWN = 3.8993;         // mức đang giảm
const LUFS_TC_OUT = 3.2323;          // đường ra
const alphaFor = (tcSec) => 1 - Math.exp(-lufsBlockDt / tcSec);

// Khoá dần: biến AGC từ "compressor chậm" thành "normalizer mỗi bài một lần".
// Điều kiện khoá là SỐ ĐO ĐÃ ĐỨNG YÊN, không phải đã trôi qua bao nhiêu giây.
// Bài mở đầu bằng intro nhẹ thì ở mốc 30s integrated còn lệch ~6dB so với giá
// trị thật; khoá theo đồng hồ là khoá đúng vào lúc số đo còn sai.
// Cách này cũng tự MỞ KHOÁ nếu nội dung đổi thật (video tổng hợp nhiều bài).
const LOCK_SECONDS = 30;             // điều kiện cần (tính bằng dữ liệu đã đo, không phải đồng hồ)
const LOCK_CHECK_TICKS = 50;         // đối chiếu mỗi 10s (tick điều khiển vẫn 200ms)
const LOCK_STABLE_DB = 0.5;          // trôi dưới ngần này trong 10s = đã đứng yên
// Slew BẤT ĐỐI XỨNG. Sai theo hướng TO khó chịu hơn hẳn sai theo hướng NHỎ:
// quá to là chói tai và phải với tay vặn nhỏ, quá nhỏ chỉ là hơi khẽ vài giây.
// Bản đối xứng 1.5dB/s là lý do "nhỏ dần dần" — khi bài mới hoá ra to hơn
// tưởng 14dB thì phải mất ~9s mới hạ xong, và suốt 9s đó tai phải chịu.
// Hạ nhanh, lên chậm: 6dB/s cắt quãng đó còn ~2.3s mà không gây bơm.
const SLEW_UP_DB_PER_SEC = 1.5;
const SLEW_DOWN_DB_PER_SEC = 6.0;
const SLEW_LOCKED_UP_DB_PER_SEC = 0.3;
const SLEW_LOCKED_DOWN_DB_PER_SEC = 2.0;   // đã khoá vẫn phải thoát nhanh khi đoán sai
// Tốc độ NÂNG trong giai đoạn bám ban đầu. Nhanh hơn lúc bình thường để bài nhỏ
// lên mức đúng sớm, nhưng vẫn có trần: một ước lượng sai kiểu +24dB không bao
// giờ được phép hiện thực hoá ngay lập tức.
const SLEW_ACQUIRE_UP_DB_PER_SEC = 2.0;
const DEADBAND_OPEN_LOCKED_DB = 2.0;
const MAX_GAIN_DB = 24;
const LIMIT_CEILING_DB = -1.0;
const LOOKAHEAD_MS = 8;              // 5ms quá ngắn cho trầm: envelope bám theo chu kỳ sóng
const FAST_LOCK_TICKS = 13;          // ~2.6s đầu mỗi track

// --- KHỚP MỨC KHI CHUYỂN BÀI ---
// Bài mới KHÔNG kế thừa độ lợi của bài trước. Bài trước có thể là bản thu rất
// nhỏ (độ lợi +12dB); áp nguyên số đó lên bài sau là một cú vọt. Thay bằng
// trung bình động của độ lợi đã ổn định qua các bài đã nghe, lấy min() để
// không bao giờ khởi đầu to hơn.
//
// Bản 5.0 còn một lớp nữa: nhắm thấp hơn mục tiêu vài dB khi số đo còn non, để
// phòng bài mở đầu bằng intro nhẹ. ĐÃ BỎ. Nó đổi một cú vọt CHỈ xảy ra ở bài
// có intro nhẹ lấy một cú trôi mức ĐẢM BẢO CÓ Ở MỌI BÀI: đo được gain bò từ
// 8.05 lên 10.84dB suốt 16 giây đầu trên nguồn đứng yên hoàn toàn — chính là
// cái "lúc mới vào bài cứ to nhỏ" mà người dùng nghe thấy. Sau khi AGC chuyển
// lên đầu chuỗi thì lớp này cũng hết cần: compressor tự hấp thụ cú nhảy
// intro -> thân bài, đo được đỉnh chỉ còn vượt 1.2dB trong 4.3s (trước: 7.3dB
// trong 10.8s), nên không đáng đánh đổi.
const PRIOR_ALPHA = 0.35;            // mỗi bài đóng góp ngần này vào prior
const TRACK_CHANGE_DUCK_DB = 6.0;    // hạ tạm lúc chuyển bài, bám lại ngay sau đó

// Chốt chặn theo mức TỨC THỜI. Cần nó vì integrated làm đúng việc của nó vẫn
// gây vọt: bài mở đầu bằng intro nhẹ 4s thì integrated (gồm cả intro) nói bài
// này nhỏ, và cổng tương đối -10 LU KHÔNG loại được intro chỉ thấp hơn ~12dB.
// Thân bài vào là vọt, mà integrated vẫn đang bảo "cứ nâng lên".
// Đây KHÔNG phải bộ lái — AGC vẫn chạy bằng integrated. Nó chỉ chặn một chiều
// (hạ, không nâng) và chỉ khi mức ra tức thời vượt trần mục tiêu quá ngưỡng
// dưới đây. Nhạc bình thường có momentary cao hơn integrated ~3-6dB ở điệp
// khúc, nên ngưỡng phải rộng hơn thế mới không biến thành compressor chậm.
const MOMENTARY_GUARD_DB = 7.0;

// Limiter được phép ghì tới mức này. Vượt qua, AGC tự hạ gain thay vì để
// limiter méo tín hiệu. Đây là đánh đổi có ý thức: to hơn <-> sạch hơn.
const LIMIT_ALLOW_DB = -1.5;
const LIMIT_TRIM_MAX_DB = 12;

// Makeup TĨNH. Các bản trước để nó bám theo comp.reduction đo được — dù ở TC
// 2.5s hay 20s thì bản chất vẫn là MỘT VÒNG LẶP CHẬM THỨ HAI chạy song song
// với AGC, và hai vòng đó đuổi nhau. Chỉnh hằng số thời gian chỉ đổi chu kỳ
// đuổi chứ không bỏ được nó. Nay makeup suy ra thẳng từ ngưỡng/tỉ số hiệu dụng
// tại một mức tham chiếu: không đo thì không có vòng lặp.
// Mức tham chiếu chỉ có nghĩa vì AGC đã chuyển lên ĐẦU chuỗi — compressor luôn
// nhận tín hiệu đã chuẩn hoá, nên "mức vào điển hình" là một số xác định.
// Trần 6dB x 3 băng: 12dB của bản rất cũ đủ đẩy đỉnh chain vượt vùng tuyến
// tính của waveshaper phía sau => clip cứng.
const MAKEUP_REF_DB = -14;
const MAKEUP_MAX_DB = 6;

// Mức trung bình của TỪNG BĂNG so với mức FULL-BAND, với phổ nhạc điển hình đi
// qua crossover LR4 tại 250Hz và 4kHz (thấp ~45%, trung ~45%, cao ~10% năng
// lượng). Bắt buộc phải có con số này: ngưỡng compressor là ngưỡng CỦA BĂNG,
// còn MAKEUP_REF_DB là mức FULL-BAND. So thẳng hai thứ đó là sai thứ nguyên —
// nó tưởng băng nào cũng bị nén mạnh nên bù quá tay, nặng nhất ở dải cao: băng
// đó chỉ mang ~10% năng lượng nên thực tế gần như không chạm ngưỡng, mà vẫn
// được bù như thể có.
const BAND_LEVEL_OFFSET_DB = { low: -3.5, mid: -3.5, high: -10.0 };

// Headroom cho tầng bão hoà. WaveShaper KẸP CỨNG input ngoài [-1,1], nên
// ngưỡng clip = 1/SAT_DRIVE. 0.5 (bản cũ) => clip ngay ở +6dBFS đỉnh chain.
// 0.2 => +14dBFS, đủ chỗ cho makeup + exciter + widener cộng dồn.
const SAT_DRIVE = 0.2;
const SAT_CURVE_K = 2.0;             // bù lại độ "màu" bị mất khi hạ drive

// --- NÉN MULTIBAND THEO CHẾ ĐỘ ---
// Bản 4.6 trở về trước đặt cứng ngưỡng/tỉ số MỘT LẦN lúc dựng graph rồi không
// bao giờ đổi. Nghĩa là kéo cường độ về 0% vẫn nén 4:1 ở trầm và cao, và
// "Đêm" với "Nhạc" dùng y hệt setting nén — trong khi đó là hai yêu cầu ngược
// nhau: nghe đêm cần ghì mạnh cho đoạn nhỏ nghe được, nghe nhạc cần để yên
// dynamic. Đây là nguồn "phẳng lì, hết sức sống" lớn nhất còn lại của chain,
// và người dùng không có nút nào chạm tới được.
//
// [ngưỡng dB, tỉ số]. Dải cao ĐÃ HẠ hẳn tỉ số: bản cũ để 4:1 @-20dB với
// attack 1ms/release 50ms, tức là một de-esser áp lên TOÀN BỘ mọi thứ trên
// 4kHz — cymbal, hi-hat, đàn dây đều bị ghì như tiếng "s". Việc dò sibilance
// đã có deharsh trong worklet lo bằng ngưỡng TƯƠNG ĐỐI (đúng cách), nên ở đây
// chỉ cần kiểm soát dải nhẹ nhàng.
const COMP_PROFILE = {
    movie:   { low: [-24, 3.0], mid: [-28, 2.5], high: [-18, 2.5] },
    music:   { low: [-20, 2.0], mid: [-24, 1.8], high: [-14, 1.8] },
    night:   { low: [-30, 5.0], mid: [-34, 4.5], high: [-24, 3.5] },
    podcast: { low: [-24, 3.0], mid: [-30, 4.0], high: [-20, 2.5] },
    custom:  { low: [-24, 2.5], mid: [-28, 2.5], high: [-18, 2.0] }
};

// Cường độ 0 PHẢI trung tính tuyệt đối, không phải "gần trung tính". Tỉ số 1.0
// là điều kiện đủ: DynamicsCompressor với ratio 1 không giảm độ lợi chút nào,
// nên comp.reduction = 0 và auto-makeup cũng tự về 0dB. Nới thêm ngưỡng chỉ để
// đường chuyển mượt, không phải để đảm bảo trung tính.
const COMP_OFF_THRESH_DB = 18;

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

let preInput, chainIn, dryGain, dryDelay, wetGain, outBus, agcGain, sumNode;
let compLow, compMid, compHigh, gainLow, gainMid, gainHigh;
let tubeSaturator;
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
let inMeter, outMeter, silentSink;
let usingLoudnessWorklet = false;

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
// Độ lợi điển hình của nội dung người dùng đang nghe, học dần qua các bài.
// Lưu xuống storage để bài ĐẦU TIÊN của phiên sau cũng có điểm khởi đầu đúng.
let priorGainDb = null;
let priorSavedThisTrack = false;
let isCorrecting = false;
let tickCount = 0;

const makeupDb = { low: 0, mid: 0, high: 0 };
let phantomGainDb = -40;
let phantomDriveDb = 0;
let phantomOpen = false;

let limiterAvgDb = 0;
let limiterTrimDb = 0;

const sourceCache = new WeakMap();
const mediaHooked = new WeakSet();   // tránh gắn trùng listener khi gắn lại nguồn
let currentSource = null;
let currentElement = null;
let currentVideoId = null;
let monitorInterval = null;
let watcherInterval = null;

// --- 3. CÀI ĐẶT NGƯỜI DÙNG ---
const clampVocal = (v) => Math.max(0, Math.min(1, (parseFloat(v) || 0) / 100));

// Prior để ở storage.local: nó là đặc tính của thư viện nhạc người dùng đang
// nghe trên máy này, không phải cài đặt cần đồng bộ giữa các thiết bị.
chrome.storage.local.get(['priorGainDb'], (data) => {
    if (data && typeof data.priorGainDb === 'number' && isFinite(data.priorGainDb)) {
        priorGainDb = Math.max(-MAX_GAIN_DB, Math.min(MAX_GAIN_DB, data.priorGainDb));
        console.log(`📌 Điểm khởi đầu độ lợi học từ phiên trước: ${priorGainDb.toFixed(2)}dB`);
    }
});

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
            locked: inIntg !== null && inIntg.n * lufsBlockDt >= LOCK_SECONDS && integStable,
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

    // Đặt luôn độ nén của chế độ này; applyDynamics tự lo phần reset hiệu chuẩn
    applyDynamics();

    const p = COMP_PROFILE[currentUIMode] || COMP_PROFILE.custom;
    console.log(`🎛️ DSP Profile: [${String(mode).toUpperCase()}] — reset hiệu chuẩn chain · ` +
        `nén L/M/H ${p.low[1]}:1 / ${p.mid[1]}:1 / ${p.high[1]}:1 @ ${(intensity * 100).toFixed(0)}%`);
}

// Nén multiband + bão hoà, cả hai đều phụ thuộc CHẾ ĐỘ lẫn CƯỜNG ĐỘ nên phải
// tính chung một chỗ. Gọi từ cả applyAudioProfile (đổi mode) lẫn
// applyDeviceProfile (đổi thiết bị/cường độ).
function applyDynamics() {
    if (!isInitialized) return;
    const t = audioCtx.currentTime;
    const tc = 0.5;
    const prof = COMP_PROFILE[currentUIMode] || COMP_PROFILE.custom;

    const bands = [
        [compLow, gainLow, prof.low, 'low'],
        [compMid, gainMid, prof.mid, 'mid'],
        [compHigh, gainHigh, prof.high, 'high']
    ];
    for (const [comp, makeupNode, [thrDb, ratio], key] of bands) {
        // ratio 1.0 = không nén gì. Đây là cái đảm bảo cường độ 0 trung tính.
        const effRatio = 1 + (ratio - 1) * intensity;
        const effThr = Math.min(0, thrDb + (1 - intensity) * COMP_OFF_THRESH_DB);
        comp.ratio.setTargetAtTime(effRatio, t, tc);
        comp.threshold.setTargetAtTime(effThr, t, tc);

        // Makeup TĨNH, suy ra từ chính cấu hình compressor tại mức tham chiếu.
        // Bản cũ để makeup bám theo comp.reduction đo được (TC ~20s) — đó là
        // một vòng lặp chậm THỨ HAI chạy song song với AGC, và nó làm độ lợi
        // của chain phụ thuộc vào đoạn nhạc vừa phát trước đó. Hệ quả đo được:
        // cùng một mức nguồn, mức ra chênh nhau tới 3.96dB tuỳ lịch sử.
        // Không đo thì không có vòng lặp, không có phụ thuộc lịch sử. Làm được
        // điều này chính là nhờ AGC đã chuyển lên đầu chuỗi: mức vào compressor
        // nay luôn quanh MAKEUP_REF_DB nên một con số tĩnh mới có nghĩa.
        // Vẫn tự đổi theo chế độ và cường độ vì nó suy ra từ ngưỡng/tỉ số hiệu
        // dụng — cường độ 0 cho ratio 1 => makeup đúng 0dB, không tô màu.
        const over = MAKEUP_REF_DB + BAND_LEVEL_OFFSET_DB[key] - effThr;
        const mk = over > 0 ? Math.min(MAKEUP_MAX_DB, over * (1 - 1 / effRatio)) : 0;
        makeupDb[key] = mk;
        makeupNode.gain.setTargetAtTime(Math.pow(10, mk / 20), t, tc);
    }

    // Bão hoà: đường cong makeSaturationCurve rút gọn thành x*pi/(pi + k*|x|),
    // nên k = 0 cho ĐÚNG BẰNG x — hàm đồng nhất tuyệt đối, không phải xấp xỉ.
    // Vì vậy chỉ cần co k theo cường độ là tắt được hẳn mà không cần nhánh
    // dry/wet song song (nhánh song song sẽ comb filter: WaveShaper oversample
    // 4x có trễ riêng mà nhánh dry không có).
    if (tubeSaturator) tubeSaturator.curve = makeSaturationCurve(SAT_CURVE_K * intensity);

    chainOffsetDb = 0;   // đổi độ nén = đổi độ lợi chain
    limiterAvgDb = 0;
    limiterTrimDb = 0;
    isCorrecting = true;
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
    // widthExtra nay là highshelf nên gain tính bằng dB, không phải hệ số cộng.
    // g = 0 cho 20*log10(1) = 0dB, tức trung tính đúng như trước.
    rampParam(widthExtra.gain, 20 * Math.log10(1 + d.widthExtra * intensity), t, tc);

    const xf = d.crossfeed * intensity;
    rampParam(xfGainL.gain, xf, t, tc);
    rampParam(xfGainR.gain, xf, t, tc);

    if (enhanceNode) {
        rampParam(enhanceNode.parameters.get('punch'), d.punch * intensity, t, tc);
        rampParam(enhanceNode.parameters.get('sustain'), d.sustain * intensity, t, tc);
        rampParam(enhanceNode.parameters.get('deharsh'), d.deharsh * intensity, t, tc);
    }

    // Cường độ cũng lái độ nén và độ bão hoà, không riêng width/crossfeed/punch.
    // applyDynamics tự lo phần reset hiệu chuẩn chain.
    applyDynamics();

    console.log(`🎧 Thiết bị: [${String(currentDevice).toUpperCase()}] · cường độ ${(intensity * 100).toFixed(0)}%` +
        `${intensity <= 0 ? ' · nén và bão hoà TẮT HẲN' : ''}` +
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
// Lọc K vẫn dựng bằng BiquadFilter ở đây (đúng và rẻ); chỉ phần TÍCH LUỸ
// NĂNG LƯỢNG mới xuống worklet, vì đó là chỗ duy nhất mà timer jitter gây sai.
function createLufsMeter(inputNode, onBlock) {
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

    inputNode.connect(stereoForce);
    stereoForce.connect(shelf);
    shelf.connect(hp);

    if (usingLoudnessWorklet) {
        const node = new AudioWorkletNode(audioCtx, 'loudness', {
            numberOfInputs: 1,
            numberOfOutputs: 1,
            outputChannelCount: [1]
        });
        hp.connect(node);
        // Node không phát ra gì, nhưng vẫn phải nằm trên đường tới destination
        // thì đồ thị mới chắc chắn kéo nó chạy. silentSink là gain 0.
        node.connect(silentSink);
        node.port.onmessage = (e) => {
            if (e.data && typeof e.data.ms === 'number') onBlock(e.data.ms, !!e.data.partial);
        };
        return { worklet: true, node };
    }

    // Dự phòng: AudioWorklet không nạp được thì AGC vẫn phải hoạt động, chỉ là
    // block đo kém đều hơn. Đo trong tick 200ms như bản cũ.
    const splitter = audioCtx.createChannelSplitter(2);
    const aL = audioCtx.createAnalyser(); aL.fftSize = FFT_SIZE;
    const aR = audioCtx.createAnalyser(); aR.fftSize = FFT_SIZE;
    hp.connect(splitter);
    splitter.connect(aL, 0);
    splitter.connect(aR, 1);

    return { worklet: false, aL, aR, bufL: new Float32Array(FFT_SIZE), bufR: new Float32Array(FFT_SIZE) };
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
    if (g.n * lufsBlockDt < INTEG_MIN_SEC) return null;
    const relThresh = (g.sum / g.n) * REL_GATE_LIN;
    let sum = 0, count = 0;
    for (let i = 0; i < g.n; i++) {
        const v = g.buf[i];
        if (v >= relThresh) { sum += v; count++; }
    }
    return count === 0 ? null : msToLufs(sum / count);
}

// Nhận MỘT block loudness (400ms, chồng lấn 75%) từ worklet — hoặc từ nhánh
// dự phòng trong tick. Đây là nơi duy nhất inLufsSmooth/inIntegrated được cập
// nhật, nên vòng điều khiển chỉ việc đọc số đã sẵn sàng.
// partial = cửa sổ chưa đủ 400ms (mấy trăm ms đầu sau khi chuyển bài). Dùng
// được cho momentary — đủ để chặn cú vọt — nhưng KHÔNG đưa vào bộ tích phân,
// vì block ngắn hơn 400ms không phải block hợp lệ của BS.1770 và sẽ làm lệch
// thống kê cổng.
function pushLufsBlock(isInput, ms, partial) {
    const lufs = blockLufs(ms);
    if (lufs === null) return;    // cổng tuyệt đối -55 LUFS: khoảng lặng không tính

    const fast = tickCount <= FAST_LOCK_TICKS;

    if (isInput) {
        const a = fast ? alphaFor(LUFS_TC_FAST)
            : alphaFor(inLufsSmooth !== null && lufs > inLufsSmooth ? LUFS_TC_UP : LUFS_TC_DOWN);
        inLufsSmooth = (inLufsSmooth === null) ? lufs : inLufsSmooth + (lufs - inLufsSmooth) * a;
        if (!partial) {
            pushBlock(inIntg, ms);
            inIntegrated = integratedLufs(inIntg);
        }
    } else {
        const a = fast ? alphaFor(LUFS_TC_FAST) : alphaFor(LUFS_TC_OUT);
        outLufsSmooth = (outLufsSmooth === null) ? lufs : outLufsSmooth + (lufs - outLufsSmooth) * a;
        if (!partial) {
            pushBlock(outIntg, ms);
            outIntegrated = integratedLufs(outIntg);
        }
    }
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

    // latencyHint 'playback': chain này có ~45 node, 2 AudioWorklet chạy từng mẫu
    // và 4 WaveShaper oversample 4x. Mặc định 'interactive' cho buffer 128–256
    // mẫu — audio thread trượt deadline lúc YouTube decode nặng và sinh ra tiếng
    // lụp bụp. Ở đây không có gì cần độ trễ thấp: không tương tác realtime,
    // AGC/limiter đều là vòng chậm hơn buffer nhiều bậc.
    audioCtx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'playback' });

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

    // Bộ đo loudness. Khác hai worklet trên, cái này KHÔNG bỏ được: AGC sống
    // bằng số nó trả về. Không nạp được thì lùi về AnalyserNode + tick 200ms.
    try {
        await audioCtx.audioWorklet.addModule(chrome.runtime.getURL('loudness-worklet.js'));
        usingLoudnessWorklet = true;
        lufsBlockDt = 0.1;
    } catch (e) {
        usingLoudnessWorklet = false;
        lufsBlockDt = TICK_MS / 1000;
        console.warn('⚠️ Không nạp được loudness worklet — đo bằng AnalyserNode, block kém đều hơn:', e);
    }

    preInput = audioCtx.createGain();

    // AGC đặt Ở ĐẦU chuỗi, TRƯỚC multiband — không phải ở cuối như các bản trước.
    // Ở cuối thì compressor nhìn thấy mức NGUỒN THÔ: bài -27 LUFS gần như không
    // bị nén, bài -9 LUFS bị nén mạnh, và trong cùng một bài thì đoạn nhẹ với
    // đoạn mạnh cũng khác nhau. Độ lợi của chain vì thế biến thiên hơn 10dB, mà
    // chainOffsetDb chỉ là MỘT số vô hướng cố mô hình hoá tất cả chỗ đó — không
    // mô hình được, nên nó đi bám theo đoạn nhạc đang phát và kéo AGC theo.
    // Chuẩn hoá TRƯỚC rồi mới xử lý là thứ tự đúng của một chuỗi mastering:
    // compressor luôn làm việc quanh cùng một điểm, nên hành vi của nó lặp lại
    // được, và bù makeup tĩnh mới có nghĩa.
    // Đo trên mô phỏng có mô hình chain phụ thuộc mức, nhạc 4 đoạn -26..-12 LUFS,
    // chỉ số là "cùng một mức nguồn thì mức ra có lặp lại không":
    //   AGC cuối + makeup tự động (bản cũ) ... 3.96dB
    //   AGC đầu  + makeup tự động ........... 1.37dB
    //   AGC cuối + makeup tĩnh .............. 1.43dB
    //   AGC đầu  + makeup tĩnh (bản này) .... 0.44dB
    agcGain = audioCtx.createGain();
    preInput.connect(agcGain);

    chainIn = audioCtx.createGain();
    agcGain.connect(chainIn);

    // Nhánh dry (dùng khi bypass) phải trễ bằng nhánh wet, nếu không lúc
    // crossfade hai bản sao tương quan cao lệch nhau 8.1ms sẽ comb filter với
    // hõm đầu tiên ở 62Hz — giữa dải, nghe rõ. Phần trễ CỐ ĐỊNH và biết chính
    // xác là look-ahead của limiter; limiter tự báo về qua port. Phần còn lại
    // (group delay của biquad, oversample của WaveShaper) phụ thuộc tần số nên
    // không bù được bằng một DelayNode — nhưng nó nhỏ hơn hẳn.
    dryDelay = audioCtx.createDelay(0.05);
    dryDelay.delayTime.value = 0;
    preInput.connect(dryDelay);

    dryGain = audioCtx.createGain();
    dryGain.gain.value = 0;
    dryDelay.connect(dryGain);

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

    // Xếp N biquad GIỐNG HỆT nhau không ra Butterworth bậc 2N. Mỗi tầng Q=0.707
    // đã -3dB tại f0, nên 4 tầng thành -12dB tại f0 và điểm -3dB thực trôi lên
    // ~1.5x f0. Butterworth bậc cao phải CHIA CỰC: mỗi tầng một Q riêng. Chỉ khi
    // đó passband mới phẳng và -3dB mới rơi đúng f0, với cùng số biquad, cùng CPU.
    // (LR4 của crossover thì ngược lại — hai tầng Q=0.707 là ĐÚNG theo định
    // nghĩa, vì LR cần -6dB tại điểm cắt để hai nhánh cộng lại phẳng.)
    const BUTTER_Q = {
        4: [0.54119610, 1.30656296],
        6: [0.51763809, 0.70710678, 1.93185165],
        8: [0.50979558, 0.60134489, 0.89997622, 2.56291545]
    };
    const cascade = (src, type, f0, order) => {
        let node = src;
        for (const q of BUTTER_Q[order]) {
            const f = lr(type, f0);
            f.Q.value = q;
            node.connect(f);
            node = f;
        }
        return node;
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
    // Ngưỡng/tỉ số do applyDynamics đặt theo chế độ + cường độ (gọi ở cuối hàm
    // này). Ở đây chỉ đặt hằng số thời gian — thứ phụ thuộc VẬT LÝ của dải tần
    // chứ không phụ thuộc sở thích người dùng — và khởi tạo ratio 1.0 để nếu
    // applyDynamics vì lý do gì chưa chạy thì chain vẫn trung tính.
    compLow = audioCtx.createDynamicsCompressor();
    compLow.threshold.value = -24; compLow.ratio.value = 1.0;
    compLow.attack.value = 0.03; compLow.release.value = 0.25;
    gainLow = audioCtx.createGain(); gainLow.gain.value = 1.0;
    lowAllpass.connect(compLow); compLow.connect(gainLow);

    compMid = audioCtx.createDynamicsCompressor();
    compMid.threshold.value = -30; compMid.ratio.value = 1.0;
    compMid.attack.value = 0.005; compMid.release.value = 0.2;
    gainMid = audioCtx.createGain(); gainMid.gain.value = 1.0;
    midLp2.connect(compMid); compMid.connect(gainMid);

    // Attack 1ms / release 50ms của bản cũ là hằng số của một DE-ESSER, mà nó
    // lại áp lên toàn bộ dải >4kHz: mỗi cú cymbal bị ghì rồi nhả trong 50ms,
    // nghe ra là cymbal phập phồng và mất đuôi ngân. Việc dò sibilance đã có
    // deharsh trong worklet lo đúng cách (ngưỡng tương đối, bandpass 2–6kHz),
    // nên ở đây trả về hằng số của một band compressor bình thường.
    compHigh = audioCtx.createDynamicsCompressor();
    compHigh.threshold.value = -20; compHigh.ratio.value = 1.0;
    compHigh.attack.value = 0.003; compHigh.release.value = 0.12;
    gainHigh = audioCtx.createGain(); gainHigh.gain.value = 1.0;
    highHp2.connect(compHigh); compHigh.connect(gainHigh);

    // ---- PHANTOM BASS ----
    // Trích xuất 35–90Hz. Chặn rumble dưới 35Hz vì hài của nó rơi xuống dưới 130Hz,
    // sẽ bị bộ lọc phía sau vứt đi — sinh ra chỉ để lãng phí và thêm méo.
    const phRumble = cascade(chainIn, 'highpass', 35, 4);
    const phBand = cascade(phRumble, 'lowpass', 90, 4);

    phantomProbe = audioCtx.createAnalyser();
    phantomProbe.fftSize = 2048;
    phantomProbeBuf = new Float32Array(phantomProbe.fftSize);
    phBand.connect(phantomProbe);

    // Ghim mức nạp vào waveshaper (điều khiển trong updatePhantom)
    phantomDrive = audioCtx.createGain();
    phantomDrive.gain.value = 1;
    phBand.connect(phantomDrive);

    const phSaturator = audioCtx.createWaveShaper();
    phSaturator.curve = makePhantomCurve();
    phSaturator.oversample = '4x';
    phantomDrive.connect(phSaturator);

    // HP Butterworth bậc 8 (48dB/oct) @130Hz.
    // Bản 4.5 xếp 4 biquad Q=0.707 giống nhau: -12dB ngay tại 130Hz và -3dB thực
    // ở tận 197Hz. Hài bậc 2 của bass 65–90Hz rơi đúng vào 130–180Hz nên bị chém
    // -12 đến -4dB — chính thứ node này sinh ra để giữ. Vòng hiệu chuẩn thấy
    // harmDb thấp lại đẩy gain bù lên, mà thứ được đẩy chủ yếu là nền tảng rò
    // qua. Chia cực đúng Butterworth: 130Hz trở lại -3dB, 180Hz gần như phẳng.
    const phHp = cascade(phSaturator, 'highpass', 130, 8);

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
    // Dải trích cũng phải là Butterworth thật: hai biquad Q=0.707 chồng nhau biến
    // "3.5–6.5kHz" thành ~4.3–5.3kHz, tức là mất hơn nửa lượng chất liệu để tổng hợp hài.
    const hfHi = cascade(chainIn, 'highpass', HF_EXTRACT_LO, 4);
    const hfBand = cascade(hfHi, 'lowpass', HF_EXTRACT_HI, 4);

    hfProbe = audioCtx.createAnalyser();
    hfProbe.fftSize = 2048;
    hfProbeBuf = new Float32Array(hfProbe.fftSize);
    hfBand.connect(hfProbe);

    hfDrive = audioCtx.createGain();
    hfDrive.gain.value = 1;
    hfBand.connect(hfDrive);

    const hfShaper = audioCtx.createWaveShaper();
    hfShaper.curve = makePhantomCurve();   // hài bậc 2 trội: ngọt hơn bậc 3 ở dải cao
    hfShaper.oversample = '4x';            // hài bậc 3 của 6.5kHz = 19.5kHz, cần chống alias
    hfDrive.connect(hfShaper);

    // HP Butterworth bậc 6 @7.5kHz. Xếp 3 biquad Q=0.707 (bản 4.5) cho -9dB ngay
    // tại 7.5kHz và -3dB thực ở ~9.7kHz: hài bậc 2 của nguồn 3.5–5kHz nằm ở
    // 7–10kHz và bị vứt gần hết, chỉ còn phần trên 12kHz sống sót — đúng vùng
    // Opus đã cắt sẵn, nên nghe ra "xì" chứ không phải chi tiết.
    const hfHp = cascade(hfShaper, 'highpass', HF_OUT_HP, 6);

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

    // Highshelf 12kHz (bản cũ) giao rất ít độ nâng vào chỗ còn nội dung: với
    // +3dB danh nghĩa, tại 12kHz mới được +1.50dB và phải tới 16kHz mới đạt
    // +2.46dB — mà Opus/AAC của YouTube đã cắt gần sạch trên 16kHz, nên phần
    // lớn độ nâng rơi vào nhiễu mã hoá. Hạ xuống 9kHz: +1.20dB ở 8kHz,
    // +1.79dB ở 10kHz, +2.26dB ở 12kHz — nằm trong vùng thật sự có tín hiệu.
    exciterAir = audioCtx.createBiquadFilter();
    exciterAir.type = 'highshelf'; exciterAir.frequency.value = 9000;
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

    // Đường cong do applyDynamics đặt theo cường độ (k = 0 => hàm đồng nhất).
    tubeSaturator = audioCtx.createWaveShaper();
    tubeSaturator.curve = makeSaturationCurve(SAT_CURVE_K * intensity);
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

    // Ý đồ là: Side bằng 0 dưới sideMonoHz, x1 tới 300Hz, x(1+g) trên 300Hz —
    // tức đúng một HIGHSHELF. Bản cũ dựng nó bằng cách CỘNG SONG SONG nhánh
    // HP300 vào nhánh HP40, mà hai bộ lọc lệch điểm cắt thì lệch pha trong
    // vùng chuyển: đo được lệch tới -1.13dB so với ý đồ ở g=0.5, và tệ hơn là
    // ở 100–200Hz nó CẮT phần Side đáng lẽ để phẳng (-0.27..-0.41dB thay vì
    // 0..+0.86dB). Nối tiếp một highshelf cho đúng ý đồ và bớt hai node.
    widthExtra = audioCtx.createBiquadFilter();
    widthExtra.type = 'highshelf';
    widthExtra.frequency.value = 300;
    widthExtra.gain.value = 0;              // 0dB = rộng đúng như bản gốc
    sideMono.connect(widthExtra);

    widthBoost = audioCtx.createGain();
    widthBoost.gain.value = 1.0;
    widthExtra.connect(widthBoost);

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
    // trả lại) và TRƯỚC limiter, để phần đỉnh mới tạo ra được limiter canh.
    // AGC nay nằm ở đầu chuỗi nên tín hiệu tới đây đã được chuẩn hoá mức.
    let chainOut;

    if (usingEnhance) {
        enhanceNode = new AudioWorkletNode(audioCtx, 'enhance', {
            numberOfInputs: 1,
            numberOfOutputs: 1,
            outputChannelCount: [2]
        });
        xfMerge.connect(enhanceNode);
        chainOut = enhanceNode;
    } else {
        chainOut = xfMerge;
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
            if (!e.data) return;
            if (typeof e.data.reductionDb === 'number') limiterReductionDb = e.data.reductionDb;
            if (typeof e.data.latencySamples === 'number') {
                dryDelay.delayTime.value = e.data.latencySamples / audioCtx.sampleRate;
                console.log(`↔️ Bù trễ nhánh dry: ${(e.data.latencySamples / audioCtx.sampleRate * 1000).toFixed(2)}ms`);
            }
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

    chainOut.connect(limiterNode);

    wetGain = audioCtx.createGain();
    wetGain.gain.value = 1;
    limiterNode.connect(wetGain);

    // ---- OUTPUT BUS ----
    outBus = audioCtx.createGain();
    wetGain.connect(outBus);
    dryGain.connect(outBus);
    outBus.connect(audioCtx.destination);

    // Điểm neo im lặng cho các node chỉ đo: gain 0 nối tới destination, đủ để
    // đồ thị kéo chúng chạy mà không đóng góp một mẫu nào vào đầu ra.
    silentSink = audioCtx.createGain();
    silentSink.gain.value = 0;
    silentSink.connect(audioCtx.destination);

    inIntg = createIntegrator();
    outIntg = createIntegrator();
    inMeter = createLufsMeter(preInput, (ms) => pushLufsBlock(true, ms));
    outMeter = createLufsMeter(outBus, (ms) => pushLufsBlock(false, ms));

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

    // Watcher poll 500ms là quá chậm cho việc này: suốt quãng đó bài mới đã
    // phát rồi mà AGC vẫn đang áp độ lợi của bài cũ. 'loadstart' và 'emptied'
    // bắn NGAY khi YouTube đổi nguồn của thẻ video, trước khi có mẫu âm thanh
    // nào ra loa — đó mới là thời điểm đúng để reset.
    if (!mediaHooked.has(el)) {
        mediaHooked.add(el);
        const onNewMedia = () => {
            if (!isInitialized) return;
            resetTrackState();
            startMonitor();
            // Cố ý KHÔNG đụng currentVideoId: để syncWithPage vẫn nhận ra và
            // cập nhật id khi location đổi. Reset hai lần là vô hại.
            console.log('⏭️ Nguồn media đổi — reset AGC ngay, không chờ poll');
        };
        el.addEventListener('loadstart', onNewMedia);
        el.addEventListener('emptied', onNewMedia);
    }

    console.log('🔌 Đã gắn vào player chính.');
}

// --- 9. VÒNG ĐIỀU KHIỂN ---
function resetTrackState() {
    // resetTrackState bị gọi HAI LẦN cho mỗi lần chuyển bài: một từ 'loadstart'
    // và một từ syncWithPage khi location đổi. Cú ducking bên dưới không được
    // cộng dồn thành 12dB, nên chỉ ducking ở lần gọi ĐẦU — nhận ra bằng việc
    // lần đó còn số đo của bài cũ, lần sau thì đã null rồi.
    const firstResetOfChange = inLufsSmooth !== null;

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
    priorSavedThisTrack = false;

    // Xả cửa sổ 400ms của bộ đo: nó đang chứa audio của BÀI CŨ, và nếu không xả
    // thì block đầu tiên sau khi chuyển vẫn nói về bài cũ.
    for (const m of [inMeter, outMeter]) {
        if (m && m.worklet && m.node) m.node.port.postMessage({ reset: true });
    }

    // KHÔNG kế thừa độ lợi của bài trước. Bài trước có thể là bản thu rất nhỏ
    // cần +12dB; áp nguyên số đó lên bài sau (có thể là master to) là đúng cú
    // "chuyển bài cái to hẳn". Hai lớp:
    //  - hạ về prior nếu prior thấp hơn (min, không phải gán: khởi đầu quá nhỏ
    //    chỉ khẽ vài trăm ms, khởi đầu quá to là chói tai),
    //  - rồi hạ thêm một cú ducking. Trong vài trăm ms mù này ta KHÔNG BIẾT GÌ
    //    về bài mới, nên chọn phía an toàn. fastLock kéo lại ngay khi block đầu
    //    tiên về (~100ms nhờ block partial), nên cái giá phải trả là vài trăm
    //    ms hơi khẽ — đổi lấy việc không bao giờ giật mình.
    if (isInitialized && firstResetOfChange) {
        if (priorGainDb !== null && priorGainDb < currentAppliedGainDb) currentAppliedGainDb = priorGainDb;
        currentAppliedGainDb = Math.max(-MAX_GAIN_DB, currentAppliedGainDb - TRACK_CHANGE_DUCK_DB);
        agcGain.gain.setTargetAtTime(Math.pow(10, currentAppliedGainDb / 20), audioCtx.currentTime, 0.03);
    }

    // Vocal focus PHẢI reset: nó là đặc tính của BẢN PHỐI, và TC ~7s nghĩa là
    // bài mới thừa hưởng tới 4.5dB EQ của bài cũ trong nhiều giây đầu. Về 0 là
    // về trung tính rồi mới bám lên, không bao giờ sai theo hướng quá tay.
    vocalAmount = 0;
    vocalRatioDb = null;
    if (isInitialized) applyVocalGains(audioCtx.currentTime);

    // phantomGainDb / hfGainDb thì KHÔNG reset: hai vòng đó có TC ~2s và bám
    // theo mức nguồn ĐÃ đo, nên tự đúng lại rất nhanh. Ép về -40dB sẽ tạo ra
    // một cú fade-in 2s của phần trầm ảo ở đầu mỗi bài — dễ nghe thấy hơn hẳn
    // so với chỗ sai mà nó khắc phục.

    // chainOffsetDb và makeupDb cũng KHÔNG reset: đó là đặc tính của chain
}

// Makeup nay do applyDynamics đặt một lần theo chế độ + cường độ (xem
// MAKEUP_REF_DB). Không còn hàm cập nhật theo tick nào cho nó.

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

        updatePhantom(now);
        updateHfExciter(now);
        updateVocalFocus(now);

        if (!usingWorkletLimiter) limiterReductionDb = limiterNode.reduction || 0;

        if (isBypassed) return;

        // Tôn trọng thanh volume YouTube, nếu không AGC sẽ kéo ngược lại
        const vol = currentElement.muted ? 0 : (currentElement.volume ?? 1);
        if (vol < 0.02) return;
        const volDb = 20 * Math.log10(vol);

        // Nhánh dự phòng: không có worklet thì phải tự lấy mẫu ở đây.
        // Có worklet thì số đo đã được pushLufsBlock cập nhật sẵn ở nhịp 100ms.
        if (!usingLoudnessWorklet) {
            pushLufsBlock(true, measureMeanSquare(inMeter));
            pushLufsBlock(false, measureMeanSquare(outMeter));
        }

        if (inLufsSmooth === null) return; // chưa đo được gì (hoặc đang lặng)

        tickCount++;
        const fastLock = tickCount <= FAST_LOCK_TICKS;

        // Đối chiếu integrated với chính nó 10s trước: trôi ít nghĩa là đã hội tụ.
        if (inIntegrated !== null && tickCount % LOCK_CHECK_TICKS === 0) {
            integStable = integRefDb !== null && Math.abs(inIntegrated - integRefDb) < LOCK_STABLE_DB;
            integRefDb = inIntegrated;
        }

        // Hiệu chuẩn vòng kín: học độ lợi cố định của chain, chỉ khi hệ đứng yên
        // và limiter không can thiệp (nếu không sẽ học nhầm thành vòng lặp dương)
        // Dùng INTEGRATED chứ không phải momentary. Đây là chỗ sai nặng nhất của
        // các bản trước: momentary (TC ~3-4s) bám theo TỪNG ĐOẠN NHẠC, mà độ lợi
        // của chain thì phụ thuộc mức vào (compressor nén đoạn to nhiều hơn đoạn
        // nhẹ - đúng việc của nó). Kết quả là chainOffsetDb, đáng lẽ là hằng số
        // của chain, lại đi bám theo mức của đoạn đang phát; AGC bù theo nó và
        // trở thành một compressor rất chậm. Đo được: cùng một mức nguồn, mức ra
        // chênh nhau tới 7.96dB tuỳ vào đoạn nào vừa phát trước đó.
        // Integrated có cổng, là số của CẢ BÀI, nên chainOffset mới thật sự là
        // đặc tính của chain.
        const limiting = limiterReductionDb < -1.0;
        if (!fastLock && !isCorrecting && !limiting && inIntegrated !== null && outIntegrated !== null) {
            const measuredOffset = outIntegrated - inIntegrated - currentAppliedGainDb;
            chainOffsetDb += (measuredOffset - chainOffsetDb) * 0.02;
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

        // Ra GIỮA cửa sổ, không phải ra mép gần nhất.
        // Bản cũ kéo bài nhỏ lên đúng TARGET_MIN và ép bài to xuống đúng
        // TARGET_MAX. Cả hai đều "đạt", nhưng hai bài đó cách nhau đúng bằng
        // BỀ RỘNG cửa sổ — mặc định 4dB. Đấy chính là "bài này nhỏ bài kia to"
        // ở trạng thái ĐÃ ỔN ĐỊNH, không phải hiện tượng nhất thời lúc chuyển
        // bài, và không có thời gian nào chữa được vì AGC coi cả hai là đúng.
        // Cửa sổ vẫn còn tác dụng: nằm trong thì không đụng vào (khỏi chỉnh
        // vặt), nhưng đã phải chỉnh thì chỉnh về giữa để mọi bài tụ về một mức.
        const effMid = (effMin + effMax) / 2;
        let desiredGainDb = 0;
        if (base < effMin || base > effMax) desiredGainDb = effMid - base;

        desiredGainDb += limiterTrimDb;

        // Chốt chặn tức thời: nếu mức RA ngay lúc này đã vượt trần mục tiêu quá
        // MOMENTARY_GUARD_DB thì hạ, bất kể integrated đang nói gì. Một chiều —
        // không bao giờ dùng để NÂNG — nên nó không thể biến AGC thành compressor.
        if (inLufsSmooth !== null) {
            const outNowDb = inLufsSmooth + chainOffsetDb + currentAppliedGainDb;
            const over = outNowDb - (effMax + MOMENTARY_GUARD_DB);
            if (over > 0) desiredGainDb = Math.min(desiredGainDb, currentAppliedGainDb - over);
        }

        desiredGainDb = Math.max(-MAX_GAIN_DB, Math.min(MAX_GAIN_DB, desiredGainDb));

        // Khoá dần: đo được càng nhiều thì con số càng đáng tin, và càng ít lý do
        // để còn ngọ nguậy. Sau ~30s, deadband nới ra 2dB và slew tụt còn 0.3dB/s
        // => mức đứng yên trong suốt phần còn lại của bài.
        const locked = inIntg.n * lufsBlockDt >= LOCK_SECONDS && integStable;
        const openDb = locked ? DEADBAND_OPEN_LOCKED_DB : DEADBAND_OPEN_DB;

        // Đã đo đủ và số đo đứng yên => chốt độ lợi của bài này vào prior, để
        // bài SAU có điểm khởi đầu đúng. Mỗi bài chỉ đóng góp một lần.
        if (locked && !priorSavedThisTrack) {
            priorSavedThisTrack = true;
            const settled = currentAppliedGainDb - limiterTrimDb;   // bỏ phần lùi tạm thời
            priorGainDb = priorGainDb === null
                ? settled
                : priorGainDb + (settled - priorGainDb) * PRIOR_ALPHA;
            chrome.storage.local.set({ priorGainDb });
        }

        // Deadband có trễ: mở rộng, đóng hẹp => hội tụ được thay vì đóng băng
        const delta = desiredGainDb - currentAppliedGainDb;
        const err = Math.abs(delta);
        if (!isCorrecting && err > openDb) isCorrecting = true;
        else if (isCorrecting && err < DEADBAND_CLOSE_DB) isCorrecting = false;

        if (fastLock) {
            // Giai đoạn bám ban đầu vẫn BẤT ĐỐI XỨNG, không nhảy cóc cả hai chiều.
            // Nhảy cóc lên là nguyên nhân của "mới vô rất to rồi nhỏ dần": mấy
            // trăm ms đầu một video thường rất khẽ (fade-in, logo, im lặng), AGC
            // lấy luôn số đó làm mức của cả bài và chốt độ lợi kịch trần +24dB;
            // tới khi nhạc thật vào thì đã muộn. Đo được: 3 giây khẽ ở đầu làm
            // mức ra vọt lên -6.76 LUFS rồi mất ~10 giây mới bò về -13.96.
            // HẠ thì vẫn tức thì — sai theo hướng to mới là thứ hại tai.
            if (desiredGainDb < currentAppliedGainDb) {
                currentAppliedGainDb = desiredGainDb;
            } else {
                const step = SLEW_ACQUIRE_UP_DB_PER_SEC * (TICK_MS / 1000);
                currentAppliedGainDb += Math.min(desiredGainDb - currentAppliedGainDb, step);
            }
            agcGain.gain.setTargetAtTime(Math.pow(10, currentAppliedGainDb / 20), now, 0.15);
        } else if (isCorrecting) {
            // Bất đối xứng: HẠ nhanh, LÊN chậm. Hạ chậm nghĩa là bắt tai chịu
            // đựng suốt quãng sửa sai; lên nhanh thì nghe ra bơm ở đoạn nhạc nhẹ.
            const down = delta < 0;
            const slewDb = locked
                ? (down ? SLEW_LOCKED_DOWN_DB_PER_SEC : SLEW_LOCKED_UP_DB_PER_SEC)
                : (down ? SLEW_DOWN_DB_PER_SEC : SLEW_UP_DB_PER_SEC);
            const step = slewDb * (TICK_MS / 1000);
            currentAppliedGainDb += Math.sign(delta) * Math.min(err, step);
            agcGain.gain.setTargetAtTime(Math.pow(10, currentAppliedGainDb / 20), now, 0.12);
        }

        if (tickCount % 10 === 0) {
            console.log(
                `[AGC] IN ${inIntegrated === null ? '--' : inIntegrated.toFixed(1)} → OUT ${outIntegrated === null ? '--' : outIntegrated.toFixed(1)} LUFS-I ` +
                `(${(inIntg.n * lufsBlockDt).toFixed(0)}s đo${locked ? ', ĐÃ KHOÁ' : ''}) | ` +
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
// Toàn bộ phần phụ thuộc TRANG gói gọn ở đây. Mọi thứ phía trên — đo LUFS,
// AGC, limiter, chuỗi DSP — không biết gì về YouTube và không cần biết.
// Thêm một trang mới = thêm một mục vào SITE_ADAPTERS + một dòng match trong
// manifest; không phải sửa gì trong phần xử lý âm thanh.
//
// Lưu ý an toàn chi phối cả thiết kế này: createMediaElementSource KHÔNG hoàn
// tác được. Gắn nhầm vào một thẻ video preview/quảng cáo là hỏng vĩnh viễn thẻ
// đó cho tới khi tải lại trang. Nên mọi adapter đều phải chọn dè dặt, và
// adapter tổng quát càng phải dè dặt hơn vì nó không biết trang trông thế nào.

const YOUTUBE_ADAPTER = {
    name: 'YouTube',
    match: (host) => /(^|\.)(youtube\.com|youtube-nocookie\.com)$/.test(host),
    navEvents: ['yt-navigate-finish'],
    isPlayerPage: () =>
        location.pathname.startsWith('/watch') || location.pathname.startsWith('/shorts/'),
    trackId: () => {
        try {
            const u = new URL(location.href);
            if (u.pathname.startsWith('/shorts/')) return u.pathname.split('/')[2] || null;
            return u.searchParams.get('v');
        } catch (e) {
            return null;
        }
    },
    findMedia: () => {
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
};

// Adapter tổng quát: dùng cho mọi trang không có adapter riêng. Không đoán cấu
// trúc DOM của trang (mỗi trang một kiểu, đoán là sai), chỉ dựa vào chính các
// thẻ media và trạng thái phát của chúng.
const GENERIC_MIN_DURATION = 20;   // giây; dưới ngưỡng này thường là quảng cáo,
// tiếng thông báo, video nền tự phát — không phải thứ người dùng đang nghe

const GENERIC_ADAPTER = {
    name: 'Tổng quát',
    match: () => true,             // luôn khớp, nên phải để CUỐI danh sách
    navEvents: [],
    isPlayerPage: () => true,
    // Nhiều trang nhạc đổi URL theo từng bài; trang nào không đổi thì vẫn được
    // 'loadstart' của thẻ media lo, nên không mất gì.
    trackId: () => {
        try {
            const u = new URL(location.href);
            u.hash = '';
            return u.href;
        } catch (e) {
            return null;
        }
    },
    findMedia: () => {
        const all = [...document.querySelectorAll('video, audio')].filter((m) => {
            if (m.readyState < 1) return false;
            if (!isFinite(m.duration) || m.duration < GENERIC_MIN_DURATION) return false;
            // Thẻ bị tắt tiếng thì người dùng không nghe nó — gắn vào là vô nghĩa
            // và có thể là thẻ preview tự phát câm.
            if (m.muted) return false;
            return true;
        });
        if (all.length === 0) return null;

        // Đang phát là bằng chứng mạnh nhất về "thứ người dùng đang nghe".
        const playing = all.filter((m) => !m.paused && !m.ended);
        const pool = playing.length ? playing : all;
        if (pool.length === 1) return pool[0];

        // Nhiều ứng viên: chọn thẻ hiển thị to nhất; thẻ audio không có kích
        // thước nên xếp theo thời lượng.
        const score = (m) => {
            const r = typeof m.getBoundingClientRect === 'function' ? m.getBoundingClientRect() : null;
            const area = r ? r.width * r.height : 0;
            return area > 0 ? area : m.duration;
        };
        return pool.reduce((best, m) => (score(m) > score(best) ? m : best));
    }
};

const SITE_ADAPTERS = [YOUTUBE_ADAPTER, GENERIC_ADAPTER];
const site = SITE_ADAPTERS.find((a) => a.match(location.hostname)) || GENERIC_ADAPTER;

function getVideoId() {
    return site.trackId();
}

function getMainVideo() {
    if (!site.isPlayerPage()) return null;
    return site.findMedia();
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

// Sự kiện điều hướng riêng của từng trang (SPA đổi bài mà không tải lại).
// Trang không có thì thôi — 'loadstart' của thẻ media và watcher vẫn bắt được.
for (const ev of site.navEvents) document.addEventListener(ev, syncWithPage);
window.addEventListener('pageshow', startWatcher); // khôi phục sau bfcache

window.addEventListener('pagehide', () => {
    if (monitorInterval) { clearInterval(monitorInterval); monitorInterval = null; }
    if (watcherInterval) { clearInterval(watcherInterval); watcherInterval = null; }
});

startWatcher();
