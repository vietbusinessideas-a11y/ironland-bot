const express = require("express");
const app = express();
app.use(express.json());

// ===================== CẤU HÌNH =====================
const CONFIG = {
  VERIFY_TOKEN: process.env.VERIFY_TOKEN || "ironland2024",
  PAGE_ACCESS_TOKEN: process.env.PAGE_ACCESS_TOKEN,
  GEMINI_API_KEY: process.env.GEMINI_API_KEY,
  PORT: process.env.PORT || 3000,
};

// ===================== DỮ LIỆU KHÓA HỌC =====================
const SYSTEM_PROMPT = `Bạn là trợ lý tư vấn của Iron Land — Trung tâm đào tạo Rope Access & Rescue Training Center tại Việt Nam.

DANH SÁCH KHÓA HỌC:

1. KHÓA LÀM VIỆC TRÊN CAO (Work at Heights)
   - Thời lượng: 1 ngày tại trung tâm Iron Land
   - Học phí: 3.500.000 VND/người
   - Kết quả: Kiến thức an toàn làm việc trên cao + Chứng chỉ nội bộ Iron Land
   - Phù hợp: Người mới bắt đầu, cần nền tảng an toàn cơ bản

2. KHÓA ĐU DÂY TIẾP CẬN CƠ BẢN - Chứng chỉ nội bộ
   - Thời lượng: 3 ngày
   - Học phí: 7.000.000 VND/người
   - Kết quả: Kỹ năng rope access đầy đủ + Chứng chỉ nội bộ Iron Land
   - Phù hợp: Muốn học kỹ thuật rope access, chứng chỉ dùng nội bộ doanh nghiệp

3. KHÓA ĐU DÂY TIẾP CẬN CƠ BẢN - Chứng chỉ pháp lý
   - Thời lượng: 3 ngày học + 1 ngày đánh giá (tổng 4 ngày)
   - Học phí: 10.000.000 VND/người
   - Kết quả: Chứng chỉ pháp lý nhà nước có giá trị toàn quốc + Thẻ ATVSLĐ Nhóm 3
   - Phù hợp: Cần chứng chỉ pháp lý cho dự án, công trình yêu cầu chứng nhận nhà nước

4. KHÓA ĐU DÂY NÂNG CAO & CỨU HỘ DÂY
   - Thời lượng: Thiết kế theo nhu cầu
   - Học phí: Báo giá theo yêu cầu (liên hệ trực tiếp)
   - Kết quả: Kỹ năng quản lý an toàn, thiết kế hệ thống đu dây và cứu hộ chuyên nghiệp
   - Phù hợp: Quản lý an toàn, doanh nghiệp cần đào tạo chuyên sâu theo yêu cầu riêng

HƯỚNG DẪN TƯ VẤN:
- Trả lời bằng tiếng Việt, thân thiện, ngắn gọn (tối đa 3-4 câu)
- Hỏi thêm nhu cầu để tư vấn khóa học phù hợp nhất
- Báo rõ học phí khi được hỏi
- Khi khách muốn đăng ký: đề nghị để lại số điện thoại để nhân viên liên hệ
- Không bịa thêm thông tin ngoài dữ liệu đã cung cấp
- Khóa nâng cao cần tư vấn thêm, mời khách để lại SĐT
- Dùng emoji vừa phải cho thân thiện`;

// ===================== LƯU LỊCH SỬ HỘI THOẠI =====================
// Gemini dùng format: { role: "user"/"model", parts: [{ text }] }
const conversationHistory = new Map();

function getHistory(userId) {
  if (!conversationHistory.has(userId)) {
    conversationHistory.set(userId, []);
  }
  return conversationHistory.get(userId);
}

function addToHistory(userId, role, text) {
  const history = getHistory(userId);
  history.push({ role, parts: [{ text }] });
  // Giữ tối đa 20 tin nhắn gần nhất
  if (history.length > 20) history.splice(0, 2);
}

// ===================== GỌI GEMINI API =====================
async function askGemini(userId, userMessage) {
  addToHistory(userId, "user", userMessage);

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${CONFIG.GEMINI_API_KEY}`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      system_instruction: {
        parts: [{ text: SYSTEM_PROMPT }],
      },
      contents: getHistory(userId),
      generationConfig: {
        maxOutputTokens: 500,
        temperature: 0.7,
      },
    }),
  });

  const data = await response.json();

  // Xử lý lỗi từ Gemini
  if (data.error) {
    console.error("Gemini error:", data.error);
    throw new Error(data.error.message);
  }

  const reply =
    data.candidates?.[0]?.content?.parts?.[0]?.text ||
    "Xin lỗi, có lỗi xảy ra. Vui lòng thử lại sau.";

  addToHistory(userId, "model", reply);
  return reply;
}

// ===================== GỬI TIN MESSENGER =====================
async function sendMessage(recipientId, text) {
  // Facebook giới hạn 2000 ký tự/tin nhắn
  const chunks = text.match(/.{1,1900}(\s|$)/gs) || [text];

  for (const chunk of chunks) {
    const res = await fetch(
      `https://graph.facebook.com/v18.0/me/messages?access_token=${CONFIG.PAGE_ACCESS_TOKEN}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          recipient: { id: recipientId },
          message: { text: chunk.trim() },
        }),
      }
    );
    const json = await res.json();
    if (json.error) console.error("FB send error:", json.error);
  }
}

// ===================== WEBHOOK ROUTES =====================

// Xác thực webhook với Facebook
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === CONFIG.VERIFY_TOKEN) {
    console.log("✅ Webhook verified!");
    res.status(200).send(challenge);
  } else {
    console.warn("❌ Webhook verification failed");
    res.sendStatus(403);
  }
});

// Nhận tin nhắn từ Facebook
app.post("/webhook", async (req, res) => {
  const body = req.body;
  if (body.object !== "page") return res.sendStatus(404);

  res.sendStatus(200); // Phải trả 200 ngay để Facebook không retry

  for (const entry of body.entry || []) {
    for (const event of entry.messaging || []) {
      if (!event.message?.text) continue; // Bỏ qua sticker, file, reaction

      const senderId = event.sender.id;
      const messageText = event.message.text;

      console.log(`📨 [${senderId}]: ${messageText}`);

      try {
        const reply = await askGemini(senderId, messageText);
        await sendMessage(senderId, reply);
        console.log(`✉️  Reply sent to ${senderId}`);
      } catch (err) {
        console.error("❌ Error:", err.message);
        await sendMessage(
          senderId,
          "Xin lỗi, hệ thống đang bận. Vui lòng thử lại sau ít phút nhé! 🙏"
        );
      }
    }
  }
});

// Health check
app.get("/", (req, res) =>
  res.send("🚀 Iron Land Bot (Gemini) đang chạy ✅")
);

app.listen(CONFIG.PORT, () => {
  console.log(`🚀 Iron Land Bot chạy tại port ${CONFIG.PORT}`);
});
