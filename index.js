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
  PRODUCT_SPREADSHEET_ID: process.env.PRODUCT_SPREADSHEET_ID,
  GOOGLE_CLIENT_EMAIL: process.env.GOOGLE_CLIENT_EMAIL,
  GOOGLE_PRIVATE_KEY: (process.env.GOOGLE_PRIVATE_KEY || "").replace(/\\n/g, "\n"),
  PORT: process.env.PORT || 3000,
};

// ===================== TRẠNG THÁI BOT THEO USER =====================
// Set chứa các userId mà bot đang bị TẮT (mình đang tự handle)
const botDisabledUsers = new Set();

function isBotEnabled(userId) {
  return !botDisabledUsers.has(userId);
}

function disableBot(userId) {
  botDisabledUsers.add(userId);
}

function enableBot(userId) {
  botDisabledUsers.delete(userId);
}

// ===================== GOOGLE AUTH =====================
function getGoogleAuth() {
  return new google.auth.GoogleAuth({
    credentials: {
      client_email: CONFIG.GOOGLE_CLIENT_EMAIL,
      private_key: CONFIG.GOOGLE_PRIVATE_KEY,
    },
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
}

// ===================== ĐỌC DANH MỤC SẢN PHẨM =====================
let productCatalog = "";
let lastLoadTime = 0;
const CACHE_DURATION = 30 * 60 * 1000;

async function loadProductCatalog() {
  if (productCatalog && Date.now() - lastLoadTime < CACHE_DURATION) {
    return productCatalog;
  }
  if (!CONFIG.PRODUCT_SPREADSHEET_ID || !CONFIG.GOOGLE_CLIENT_EMAIL) {
    return "";
  }
  try {
    const sheets = google.sheets({ version: "v4", auth: getGoogleAuth() });
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: CONFIG.PRODUCT_SPREADSHEET_ID,
      range: "Trang tính1!A3:I200",
    });
    const rows = res.data.values || [];
    if (rows.length === 0) return "";

    const dataRows = rows.slice(1).filter(r => r && (r[1] || r[2]));
    let catalog = "DANH MỤC SẢN PHẨM & THIẾT BỊ AN TOÀN TRÊN CAO:\n\n";
    let currentNo = "";

    for (const row of dataRows) {
      const no = row[0] || "";
      const itemVN = row[1] || "";
      const productName = row[2] || "";
      const origin = row[3] || "";
      const unitPrice = row[4] || "";
      const unit = row[5] || "";
      const vat = row[6] || "";
      const ghi_chu = row[7] || "";

      if (no && no !== currentNo) {
        currentNo = no;
        catalog += no + '. ' + itemVN + '\n';
        if (productName) catalog += '   Model/Mô tả: ' + productName + '\n';
        if (origin) catalog += '   Xuất xứ: ' + origin + '\n';
        if (unitPrice) catalog += '   Đơn giá (chưa VAT): ' + unitPrice + ' VND/' + (unit || 'cái') + '\n';
        if (vat) catalog += '   VAT: ' + vat + '\n';
        if (ghi_chu) catalog += '   Ghi chú: ' + ghi_chu + '\n';
        catalog += '\n';
      } else if (!no && (itemVN || productName)) {
        if (productName) catalog += '   - ' + productName + '\n';
      }
    }

    productCatalog = catalog;
    lastLoadTime = Date.now();
    console.log(`✅ Loaded ${dataRows.length} product rows from Sheet`);
    return productCatalog;
  } catch (err) {
    console.error("❌ Load products error:", err.message);
    return productCatalog;
  }
}

// ===================== TẠO SYSTEM PROMPT ĐỘNG =====================
async function buildSystemPrompt() {
  const products = await loadProductCatalog();
  return `Bạn là trợ lý tư vấn của Iron Land — Trung tâm đào tạo Rope Access & Rescue và cung cấp thiết bị an toàn trên cao tại Việt Nam.

DANH SÁCH KHÓA HỌC:

1. KHÓA LÀM VIỆC TRÊN CAO (Work at Heights)
   - Thời lượng: 1 ngày | Học phí: 3.500.000 VND/người
   - Kết quả: Chứng chỉ nội bộ Iron Land

2. KHÓA ĐU DÂY TIẾP CẬN CƠ BẢN - Chứng chỉ nội bộ
   - Thời lượng: 3 ngày | Học phí: 6.900.000 VND/người
   - Kết quả: Chứng chỉ nội bộ Iron Land

3. KHÓA ĐU DÂY TIẾP CẬN CƠ BẢN - Chứng chỉ pháp lý
   - Thời lượng: 4 ngày | Học phí: 10.000.000 VND/người
   - Kết quả: Chứng chỉ nhà nước + Thẻ ATVSLĐ Nhóm 3

4. KHÓA ĐU DÂY NÂNG CAO & CỨU HỘ DÂY
   - Thời lượng & học phí: Theo yêu cầu (liên hệ báo giá)

${products ? products : ""}

HƯỚNG DẪN TƯ VẤN:
- Trả lời bằng tiếng Việt, thân thiện, ngắn gọn (tối đa 4-5 câu)
- Tư vấn cả khóa học lẫn thiết bị phù hợp với nhu cầu khách
- Khi khách hỏi sản phẩm: báo đúng tên, xuất xứ, giá có VAT
- Khi khách muốn đặt hàng hoặc đăng ký học: đề nghị để lại SĐT và tên
- Không bịa thêm thông tin ngoài dữ liệu đã cung cấp
- Dùng emoji vừa phải cho thân thiện

QUAN TRỌNG - PHÁT HIỆN SĐT:
Khi khách nhắn có số điện thoại (10 số bắt đầu 0, hoặc +84):
1. Cảm ơn và xác nhận đã nhận
2. Hứa nhân viên liên hệ sớm nhất
3. Thêm dòng cuối CHÍNH XÁC:
[LEAD:SĐT={số điện thoại},TÊN={tên nếu có, không có ghi "Chưa cung cấp"},KHÓA={khóa/sản phẩm quan tâm, không có ghi "Chưa xác định"}]`;
}

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
    `📚 Quan tâm: ${lead.course}\n` +
    `🕐 Thời gian: ${time}\n` +
    `🆔 Facebook ID: \`${fbUserId}\`\n\n` +
    `💡 Lệnh điều khiển bot:\n` +
    `/off ${fbUserId} — tắt bot với khách này\n` +
    `/on ${fbUserId} — bật lại bot`;
  try {
    const res = await fetch(`https://api.telegram.org/bot${CONFIG.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: CONFIG.TELEGRAM_CHAT_ID, text: msg, parse_mode: "Markdown" }),
    });
    const json = await res.json();
    if (json.ok) console.log("✅ Telegram sent");
    else console.error("❌ Telegram:", json.description);
  } catch (err) {
    console.error("❌ Telegram error:", err.message);
  }
}

// ===================== GỬI TELEGRAM TEXT ĐƠN GIẢN =====================
async function sendTelegramText(text) {
  if (!CONFIG.TELEGRAM_BOT_TOKEN || !CONFIG.TELEGRAM_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${CONFIG.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: CONFIG.TELEGRAM_CHAT_ID, text, parse_mode: "Markdown" }),
    });
  } catch (err) {
    console.error("❌ Telegram text error:", err.message);
  }
}

// ===================== GHI GOOGLE SHEETS (LEAD) =====================
async function appendToSheet(lead, fbUserId) {
  if (!CONFIG.SPREADSHEET_ID) return;
  try {
    const sheets = google.sheets({ version: "v4", auth: getGoogleAuth() });
    const time = new Date().toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" });
    await sheets.spreadsheets.values.append({
      spreadsheetId: CONFIG.SPREADSHEET_ID,
      range: "Trang tính1!A:E",
      valueInputOption: "USER_ENTERED",
      resource: { values: [[time, lead.name, lead.phone, lead.course, fbUserId]] },
    });
    console.log("✅ Sheets updated");
  } catch (err) {
    console.error("❌ Sheets error:", err.message);
  }
}

// ===================== GỌI GEMINI API =====================
async function askGemini(userId, userMessage) {
  addToHistory(userId, "user", userMessage);
  const systemPrompt = await buildSystemPrompt();
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${CONFIG.GEMINI_API_KEY}`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: systemPrompt }] },
      contents: getHistory(userId),
      generationConfig: { maxOutputTokens: 600, temperature: 0.7 },
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

// ===================== ĐĂNG KÝ TELEGRAM WEBHOOK =====================
async function setupTelegramWebhook() {
  if (!CONFIG.TELEGRAM_BOT_TOKEN) return;
  // Lấy server URL từ biến môi trường (Render/Railway tự set)
  const serverUrl = process.env.RENDER_EXTERNAL_URL || process.env.RAILWAY_STATIC_URL || process.env.SERVER_URL;
  if (!serverUrl) {
    console.log("⚠️  Không tìm thấy SERVER_URL — bỏ qua tự đăng ký Telegram webhook.");
    console.log("   Tự đăng ký thủ công tại: https://api.telegram.org/bot<TOKEN>/setWebhook?url=<SERVER_URL>/telegram");
    return;
  }
  const webhookUrl = `${serverUrl}/telegram`;
  try {
    const res = await fetch(`https://api.telegram.org/bot${CONFIG.TELEGRAM_BOT_TOKEN}/setWebhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: webhookUrl }),
    });
    const json = await res.json();
    if (json.ok) console.log(`✅ Telegram webhook đã đăng ký: ${webhookUrl}`);
    else console.error("❌ Telegram webhook error:", json.description);
  } catch (err) {
    console.error("❌ Setup webhook error:", err.message);
  }
}

// ===================== WEBHOOK FACEBOOK =====================
app.get("/webhook", (req, res) => {
  const { "hub.mode": mode, "hub.verify_token": token, "hub.challenge": challenge } = req.query;
  if (mode === "subscribe" && token === CONFIG.VERIFY_TOKEN) {
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

      // Bỏ qua tin nhắn do bot tự gửi (echo)
      if (event.message?.is_echo) continue;

      const senderId = event.sender.id;
      let messageText = null;

      if (event.message?.text) {
        messageText = event.message.text;
      } else if (event.postback?.payload) {
        messageText = event.postback.title || event.postback.payload;
      } else if (event.message?.attachments) {
        const type = event.message.attachments[0]?.type;
        if (type === "image") messageText = "Bạn vừa gửi một hình ảnh.";
        else if (type === "audio") messageText = "Bạn vừa gửi tin nhắn thoại.";
        else if (type === "file") messageText = "Bạn vừa gửi một file.";
        else if (type === "video") messageText = "Bạn vừa gửi một video.";
        else continue;
      } else {
        continue;
      }

      // ✋ Kiểm tra bot có đang bị tắt với user này không
      if (!isBotEnabled(senderId)) {
        console.log(`🔕 Bot đang OFF với user ${senderId} — bỏ qua tin nhắn.`);
        continue;
      }

      console.log(`📨 [${senderId}]: ${messageText}`);
      try {
        const rawReply = await askGemini(senderId, messageText);
        const lead = extractLead(rawReply);
        if (lead) {
          console.log(`🎯 Lead:`, lead);
          await Promise.all([sendTelegram(lead, senderId), appendToSheet(lead, senderId)]);
        }
        await sendMessage(senderId, cleanReply(rawReply));
      } catch (err) {
        console.error("❌ Error:", err.message);
        await sendMessage(senderId, "Xin lỗi, hệ thống đang bận. Vui lòng thử lại sau ít phút nhé! 🙏");
      }
    }
  }
});

// ===================== WEBHOOK TELEGRAM (nhận lệnh /on /off /status) =====================
app.post("/telegram", async (req, res) => {
  res.sendStatus(200);
  const msg = req.body?.message;
  if (!msg?.text) return;

  // Chỉ xử lý lệnh từ đúng CHAT_ID (bảo mật)
  if (String(msg.chat.id) !== String(CONFIG.TELEGRAM_CHAT_ID)) {
    console.log(`⚠️  Lệnh từ chat lạ: ${msg.chat.id} — bỏ qua.`);
    return;
  }

  const text = msg.text.trim();
  console.log(`📟 Telegram lệnh: ${text}`);

  // /off <userId> — tắt bot với user đó
  if (text.startsWith("/off ")) {
    const userId = text.replace("/off ", "").trim();
    if (!userId) {
      await sendTelegramText("❌ Thiếu Facebook User ID. Dùng: `/off 123456789`");
      return;
    }
    disableBot(userId);
    await sendTelegramText(`🔕 Đã *TẮT* bot với user \`${userId}\`\nBạn có thể tự reply trong Messenger.\nDùng /on ${userId} để bật lại.`);
    return;
  }

  // /on <userId> — bật lại bot với user đó
  if (text.startsWith("/on ")) {
    const userId = text.replace("/on ", "").trim();
    if (!userId) {
      await sendTelegramText("❌ Thiếu Facebook User ID. Dùng: `/on 123456789`");
      return;
    }
    enableBot(userId);
    await sendTelegramText(`✅ Đã *BẬT* bot với user \`${userId}\`\nBot sẽ tự động trả lời khách từ bây giờ.`);
    return;
  }

  // /status — xem danh sách user đang bị tắt
  if (text === "/status") {
    if (botDisabledUsers.size === 0) {
      await sendTelegramText("✅ Bot đang *BẬT* với tất cả người dùng. Không có ai bị tắt.");
    } else {
      const list = [...botDisabledUsers].map(id => `• \`${id}\``).join("\n");
      await sendTelegramText(`🔕 Bot đang *TẮT* với ${botDisabledUsers.size} user:\n${list}`);
    }
    return;
  }

  // /help — hướng dẫn
  if (text === "/help" || text === "/start") {
    await sendTelegramText(
      `🤖 *Iron Land Bot — Lệnh điều khiển*\n\n` +
      `/off <userID> — Tắt bot, tự reply thủ công\n` +
      `/on <userID>  — Bật lại bot tự động\n` +
      `/status       — Xem user nào đang bị tắt\n\n` +
      `💡 Facebook User ID xuất hiện trong thông báo lead mỗi khi có khách nhắn.`
    );
    return;
  }

  // Lệnh không nhận ra
  await sendTelegramText(`❓ Lệnh không hợp lệ. Nhắn /help để xem hướng dẫn.`);
});

app.get("/", (req, res) => res.send("🚀 Iron Land Bot (Gemini + Telegram + Sheets) đang chạy ✅"));

app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok", timestamp: new Date().toISOString() });
});

// Khởi động
loadProductCatalog().then(async () => {
  await setupTelegramWebhook();
  app.listen(CONFIG.PORT, () => console.log(`🚀 Iron Land Bot chạy tại port ${CONFIG.PORT}`));
});
