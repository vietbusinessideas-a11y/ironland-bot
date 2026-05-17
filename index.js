const express = require("express");
const { google } = require("googleapis");
const app = express();
app.use(express.json());

// ===================== CẤU HÌNH =====================
const CONFIG = {
  VERIFY_TOKEN: process.env.VERIFY_TOKEN || "ironland2024",
  PAGE_ACCESS_TOKEN: process.env.PAGE_ACCESS_TOKEN,
  GEMINI_API_KEY: process.env.GEMINI_API_KEY,
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID,
  SPREADSHEET_ID: process.env.SPREADSHEET_ID,
  GOOGLE_CLIENT_EMAIL: process.env.GOOGLE_CLIENT_EMAIL,
  GOOGLE_PRIVATE_KEY: (process.env.GOOGLE_PRIVATE_KEY || "").replace(/\\n/g, "\n"),
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
- Khi khách muốn đăng ký: đề nghị để lại số điện thoại và tên để nhân viên liên hệ
- Không bịa thêm thông tin ngoài dữ liệu đã cung cấp
- Khóa nâng cao cần tư vấn thêm, mời khách để lại SĐT
- Dùng emoji vừa phải cho thân thiện

QUAN TRỌNG - PHÁT HIỆN SĐT:
Khi khách nhắn tin có chứa số điện thoại (dãy số 10 chữ số bắt đầu bằng 0, hoặc +84), hãy:
1. Cảm ơn khách và xác nhận đã nhận thông tin
2. Hứa nhân viên sẽ liên hệ trong thời gian sớm nhất
3. Thêm dòng cuối CHÍNH XÁC theo định dạng này (không thay đổi):
[LEAD:SĐT={số điện thoại},TÊN={tên nếu có, nếu không có ghi "Chưa cung cấp"},KHÓA={khóa học quan tâm nếu biết, nếu không ghi "Chưa xác định"}]`;

// ===================== LƯU LỊCH SỬ HỘI THOẠI =====================
const conversationHistory = new Map();

function getHistory(userId) {
  if (!conversationHistory.has(userId)) conversationHistory.set(userId, []);
  return conversationHistory.get(userId);
}

function addToHistory(userId, role, text) {
  const history = getHistory(userId);
  history.push({ role, parts: [{ text }] });
  if (history.length > 20) history.splice(0, 2);
}

// ===================== PHÁT HIỆN LEAD =====================
function extractLead(text) {
  const match = text.match(/\[LEAD:SĐT=([^,\]]+),TÊN=([^,\]]+),KHÓA=([^\]]+)\]/);
  if (!match) return null;
  return { phone: match[1].trim(), name: match[2].trim(), course: match[3].trim() };
}

function cleanReply(text) {
  return text.replace(/\[LEAD:[^\]]+\]/g, "").trim();
}

// ===================== GỬI TELEGRAM =====================
async function sendTelegram(lead, fbUserId) {
  if (!CONFIG.TELEGRAM_BOT_TOKEN || !CONFIG.TELEGRAM_CHAT_ID) return;
  const time = new Date().toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" });
  const msg =
    `🔔 *KHÁCH HÀNG MỚI - IRON LAND*\n\n` +
    `📞 SĐT: *${lead.phone}*\n` +
    `👤 Tên: ${lead.name}\n` +
    `📚 Khóa quan tâm: ${lead.course}\n` +
    `🕐 Thời gian: ${time}\n` +
    `🆔 Facebook ID: \`${fbUserId}\``;
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${CONFIG.TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: CONFIG.TELEGRAM_CHAT_ID, text: msg, parse_mode: "Markdown" }),
      }
    );
    const json = await res.json();
    if (json.ok) console.log("✅ Telegram sent");
    else console.error("❌ Telegram error:", json.description);
  } catch (err) {
    console.error("❌ Telegram error:", err.message);
  }
}

// ===================== GHI GOOGLE SHEETS =====================
async function appendToSheet(lead, fbUserId) {
  if (!CONFIG.GOOGLE_CLIENT_EMAIL || !CONFIG.GOOGLE_PRIVATE_KEY || !CONFIG.SPREADSHEET_ID) {
    console.log("⚠️  Google Sheets chưa cấu hình, bỏ qua");
    return;
  }
  try {
    const auth = new google.auth.GoogleAuth({
      credentials: {
        client_email: CONFIG.GOOGLE_CLIENT_EMAIL,
        private_key: CONFIG.GOOGLE_PRIVATE_KEY,
      },
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });
    const sheets = google.sheets({ version: "v4", auth });
    const time = new Date().toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" });
    await sheets.spreadsheets.values.append({
      spreadsheetId: CONFIG.SPREADSHEET_ID,
      range: "Sheet1!A:E",
      valueInputOption: "USER_ENTERED",
      resource: {
        values: [[time, lead.name, lead.phone, lead.course, fbUserId]],
      },
    });
    console.log("✅ Google Sheets updated");
  } catch (err) {
    console.error("❌ Sheets error:", err.message);
  }
}

// ===================== GỌI GEMINI API =====================
async function askGemini(userId, userMessage) {
  addToHistory(userId, "user", userMessage);
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${CONFIG.GEMINI_API_KEY}`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: getHistory(userId),
      generationConfig: { maxOutputTokens: 500, temperature: 0.7 },
    }),
  });
  const data = await response.json();
  if (data.error) { console.error("Gemini error:", data.error); throw new Error(data.error.message); }
  const rawReply = data.candidates?.[0]?.content?.parts?.[0]?.text || "Xin lỗi, có lỗi xảy ra. Vui lòng thử lại sau.";
  addToHistory(userId, "model", rawReply);
  return rawReply;
}

// ===================== GỬI TIN MESSENGER =====================
async function sendMessage(recipientId, text) {
  const chunks = text.match(/.{1,1900}(\s|$)/gs) || [text];
  for (const chunk of chunks) {
    const res = await fetch(
      `https://graph.facebook.com/v18.0/me/messages?access_token=${CONFIG.PAGE_ACCESS_TOKEN}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ recipient: { id: recipientId }, message: { text: chunk.trim() } }),
      }
    );
    const json = await res.json();
    if (json.error) console.error("FB send error:", json.error);
  }
}

// ===================== WEBHOOK =====================
app.get("/webhook", (req, res) => {
  const { "hub.mode": mode, "hub.verify_token": token, "hub.challenge": challenge } = req.query;
  if (mode === "subscribe" && token === CONFIG.VERIFY_TOKEN) {
    console.log("✅ Webhook verified!");
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

app.post("/webhook", async (req, res) => {
  const body = req.body;
  if (body.object !== "page") return res.sendStatus(404);
  res.sendStatus(200);

  for (const entry of body.entry || []) {
    for (const event of entry.messaging || []) {
      if (!event.message?.text) continue;
      const senderId = event.sender.id;
      const messageText = event.message.text;
      console.log(`📨 [${senderId}]: ${messageText}`);
      try {
        const rawReply = await askGemini(senderId, messageText);
        const lead = extractLead(rawReply);
        if (lead) {
          console.log(`🎯 Lead detected:`, lead);
          await Promise.all([
            sendTelegram(lead, senderId),
            appendToSheet(lead, senderId),
          ]);
        }
        await sendMessage(senderId, cleanReply(rawReply));
      } catch (err) {
        console.error("❌ Error:", err.message);
        await sendMessage(senderId, "Xin lỗi, hệ thống đang bận. Vui lòng thử lại sau ít phút nhé! 🙏");
      }
    }
  }
});

app.get("/", (req, res) => res.send("🚀 Iron Land Bot (Gemini + Telegram + Sheets) đang chạy ✅"));
app.listen(CONFIG.PORT, () => console.log(`🚀 Iron Land Bot chạy tại port ${CONFIG.PORT}`));
