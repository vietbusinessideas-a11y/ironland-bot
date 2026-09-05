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
  // Số phút chờ admin trả lời tiếp trước khi bot tự động trả lời lại
  AUTO_RESUME_MINUTES: parseInt(process.env.AUTO_RESUME_MINUTES || "15", 10),
};

// ===================== TRẠNG THÁI BOT THEO USER =====================
// Set chứa các userId mà bot đang bị TẮT VĨNH VIỄN qua lệnh /off (chỉ /on mới bật lại)
const botDisabledUsers = new Set();

function isBotEnabled(userId) {
  return !botDisabledUsers.has(userId);
}

function disableBot(userId) {
  botDisabledUsers.add(userId);
  autoPaused.delete(userId); // /off ghi đè, không cần theo dõi auto-pause nữa
}

function enableBot(userId) {
  botDisabledUsers.delete(userId);
  autoPaused.delete(userId);
}

// ===================== TỰ ĐỘNG TẠM DỪNG KHI ADMIN TỰ TRẢ LỜI =====================
// userId -> { timer, pending: [tin nhắn khách gửi trong lúc chờ] }
const autoPaused = new Map();

// Ghi nhớ mid của tin nhắn do CHÍNH BOT gửi, để phân biệt với admin trả lời tay
// (Facebook gửi event "echo" cho MỌI tin nhắn Page gửi ra, kể cả của bot lẫn admin)
const sentMids = new Map(); // mid -> timestamp
function rememberSentMid(mid) {
  if (mid) sentMids.set(mid, Date.now());
}
function wasSentByBot(mid) {
  if (mid && sentMids.has(mid)) {
    sentMids.delete(mid);
    return true;
  }
  return false;
}
// Dọn rác định kỳ phòng trường hợp mid không bao giờ nhận lại được echo
setInterval(() => {
  const cutoff = Date.now() - 15 * 60 * 1000;
  for (const [mid, ts] of sentMids) if (ts < cutoff) sentMids.delete(mid);
}, 15 * 60 * 1000);

// Admin vừa tự trả lời thủ công trong Messenger -> tạm dừng bot cho khách này
function handleAdminManualReply(customerId) {
  if (botDisabledUsers.has(customerId)) return; // đã tắt vĩnh viễn rồi, khỏi cần lo
  const existing = autoPaused.get(customerId);
  if (existing?.timer) clearTimeout(existing.timer);
  const wasAlreadyPaused = !!existing;
  autoPaused.set(customerId, { timer: null, pending: [] });
  console.log(`✋ Admin trả lời thủ công cho ${customerId} — tạm dừng bot tự động.`);
  if (!wasAlreadyPaused) {
    sendTelegramText(
      `✋ Phát hiện bạn *tự trả lời* khách \`${customerId}\` trong Messenger — bot đã *tạm dừng* cho khách này.\n` +
      `Nếu khách nhắn tiếp mà bạn không trả lời trong *${CONFIG.AUTO_RESUME_MINUTES} phút*, bot sẽ tự động trả lời lại.`
    );
  }
}

// Hết thời gian chờ mà admin không trả lời tiếp -> bot tự động trả lời các tin nhắn đang chờ
async function resumeAfterSilence(userId) {
  const paused = autoPaused.get(userId);
  autoPaused.delete(userId);
  if (!paused || paused.pending.length === 0) return;
  console.log(`⏰ Admin im lặng ${CONFIG.AUTO_RESUME_MINUTES} phút — bot tiếp tục trả lời ${userId}.`);
  const combinedText = paused.pending.join("\n");
  try {
    const rawReply = await askGemini(userId, combinedText);
    const lead = extractLead(rawReply);
    if (lead) {
      await Promise.all([sendTelegram(lead, userId), appendToSheet(lead, userId)]);
    }
    await sendMessage(userId, cleanReply(rawReply));
    await sendTelegramText(`⏰ Không thấy bạn trả lời trong ${CONFIG.AUTO_RESUME_MINUTES} phút — bot đã *tự động trả lời tiếp* cho khách \`${userId}\`.`);
  } catch (err) {
    console.error("❌ Resume error:", err.message);
  }
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
// Cấu trúc sheet "danh sach hang hoa": A=SKU, B=Product Name, C=Brand,
// D=Category, E=Price (excluded VAT), F=Knowledge (mô tả dài, có boilerplate
// lặp lại ở mọi dòng), G-K=trống, L=VAT.
let productCatalog = "";
let lastLoadTime = 0;
const CACHE_DURATION = 30 * 60 * 1000;
const DEFAULT_VAT_PERCENT = 8; // dùng khi ô VAT trong Sheet trống hoặc sai định dạng

// Các đoạn tư vấn này lặp lại GIỐNG HỆT NHAU ở cột "Knowledge" của mọi sản phẩm
// trong Sheet -> đưa vào system prompt MỘT LẦN duy nhất thay vì lặp lại theo
// từng dòng sản phẩm, để tránh prompt phình to khi danh mục có thêm hàng.
const GENERIC_SALES_ADVICE = `
LƯU Ý CHUNG KHI TƯ VẤN THIẾT BỊ AN TOÀN TRÊN CAO (áp dụng mọi sản phẩm bên trên):
- Phục vụ Rope Access, Work at Height hoặc Rescue tùy model.
- Phù hợp cho nhà máy, điện gió, bảo trì công nghiệp, cứu hộ.
- Có thể kết hợp với các thiết bị cùng danh mục để tạo hệ thống làm việc hoàn chỉnh.
- Luôn kiểm tra tải trọng, tiêu chuẩn và khả năng tương thích dây trước khi tư vấn.
- Ưu tiên đề xuất sản phẩm theo đúng mục đích sử dụng thực tế của khách; có thể đề xuất
  sản phẩm tương đương hoặc cao cấp hơn nếu khách cần tải trọng lớn hơn.
- Mặc định thiết bị có đầy đủ CO, CQ và hoá đơn VAT (trừ khi có ghi chú riêng khác ở từng sản phẩm).
- Nếu là thiết bị chống rơi/descender, có thể so sánh Sirius, Spark, RD2; nếu là thiết bị
  trợ lực leo dây, có thể so sánh các dòng AWAH Z3.
`;

const KNOWLEDGE_SECTION_LABELS = [
  "SẢN PHẨM:", "THƯƠNG HIỆU:", "NHÓM SẢN PHẨM:", "THÔNG SỐ KỸ THUẬT:",
  "LỢI ÍCH CHÍNH:", "TƯ VẤN BÁN HÀNG:", "CÂU HỎI THƯỜNG GẶP:", "SO SÁNH VÀ GỢI Ý:",
];

// Cắt ra đúng phần nội dung giữa 2 nhãn trong cột "Knowledge"
function extractKnowledgeSection(text, startLabel) {
  if (!text) return "";
  const startIdx = text.indexOf(startLabel);
  if (startIdx === -1) return "";
  let sliceEnd = text.length;
  for (const label of KNOWLEDGE_SECTION_LABELS) {
    if (label === startLabel) continue;
    const idx = text.indexOf(label, startIdx + startLabel.length);
    if (idx !== -1 && idx < sliceEnd) sliceEnd = idx;
  }
  return text.slice(startIdx + startLabel.length, sliceEnd).replace(/\s+/g, " ").trim();
}

// Chỉ giữ lại phần riêng của từng sản phẩm: thông số kỹ thuật + ghi chú CO/CQ/VAT
// (nếu ghi chú khác câu mặc định — ví dụ có khuyến mãi/tính năng đặc biệt)
function parseKnowledge(raw) {
  const specs = extractKnowledgeSection(raw, "THÔNG SỐ KỸ THUẬT:");
  const faqBlock = extractKnowledgeSection(raw, "CÂU HỎI THƯỜNG GẶP:");
  const match = faqBlock.match(/Có CO, CQ và hóa đơn VAT không\?\s*A:\s*(.*)$/i);
  const vatNote = match ? match[1].trim() : "";
  return { specs, vatNote };
}

function isGenericVatNote(note) {
  if (!note) return true;
  return note.replace(/\s+/g, " ").trim().toLowerCase() === "hàng đầy đủ co, cq và hoá đơn vat";
}

// Đọc % VAT một cách an toàn — nếu ô bị Google Sheets tự đổi định dạng thành
// giờ:phút:giây (lỗi từng gặp) hoặc bất kỳ giá trị không hợp lệ nào, trả về
// null để dùng mặc định thay vì đẩy rác ra cho khách.
function parseVatPercent(raw) {
  if (!raw) return null;
  const text = String(raw).trim();
  // Chỉ chấp nhận CHÍNH XÁC dạng số thuần hoặc số + "%" (vd "8", "8%", "8.5%").
  // Dùng match toàn chuỗi (^...$) để loại các giá trị lỗi kiểu "1:55:12" —
  // parseFloat thông thường sẽ đọc nhầm chuỗi đó thành 1 vì nó dừng ở dấu ":".
  const fullMatch = text.match(/^(\d+(?:[.,]\d+)?)\s*%?$/);
  if (!fullMatch) return null;
  const num = parseFloat(fullMatch[1].replace(",", "."));
  if (isNaN(num) || num <= 0 || num > 100) return null;
  return num;
}

function formatVnd(raw) {
  const n = parseFloat(String(raw).replace(/,/g, ""));
  if (isNaN(n)) return String(raw).trim();
  return Math.round(n).toLocaleString("vi-VN");
}

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
      range: "Trang tính1!A1:L500",
    });
    const rows = res.data.values || [];
    if (rows.length < 2) return productCatalog;

    // Dò dòng tiêu đề thật (mặc định dòng 1) để không lệ thuộc cứng vào số dòng
    let headerIdx = rows.findIndex(r => (r[0] || "").trim().toUpperCase() === "SKU");
    if (headerIdx === -1) headerIdx = 0;
    const dataRows = rows.slice(headerIdx + 1);

    let catalog = "DANH MỤC SẢN PHẨM & THIẾT BỊ AN TOÀN TRÊN CAO:\n\n";
    let count = 0;
    let badVatCount = 0;

    for (const row of dataRows) {
      const sku = (row[0] || "").trim();
      const name = (row[1] || "").trim();
      const brand = (row[2] || "").trim();
      const category = (row[3] || "").trim();
      const priceRaw = row[4];
      const knowledge = row[5] || "";
      const vatRaw = row[11]; // cột L

      // Bỏ qua dòng mẫu/trống chưa điền (vd SKU "-", chưa có tên hoặc giá)
      if (!name || !priceRaw) continue;

      const { specs, vatNote } = parseKnowledge(knowledge);
      const vatPercent = parseVatPercent(vatRaw);
      if (vatRaw && vatPercent === null) badVatCount++;

      count++;
      catalog += `${count}. ${name}\n`;
      if (brand) catalog += `   Thương hiệu: ${brand}\n`;
      if (category) catalog += `   Loại: ${category}\n`;
      if (sku && sku !== "-") catalog += `   SKU: ${sku}\n`;
      catalog += `   Đơn giá (chưa VAT): ${formatVnd(priceRaw)} VND\n`;
      catalog += `   VAT: ${vatPercent !== null ? vatPercent + "%" : DEFAULT_VAT_PERCENT + "% (mặc định)"}\n`;
      if (specs) catalog += `   Thông số: ${specs}\n`;
      if (!isGenericVatNote(vatNote)) catalog += `   Ghi chú: ${vatNote}\n`;
      catalog += "\n";
    }

    if (badVatCount > 0) {
      console.warn(`⚠️  ${badVatCount} sản phẩm có ô VAT sai định dạng trong Sheet (nghi bị Sheets tự đổi thành giờ:phút:giây) — đã dùng mặc định ${DEFAULT_VAT_PERCENT}%. Nên mở Sheet, format lại cột VAT (cột L) thành Percent/Plain text và nhập lại % đúng.`);
    }

    if (count === 0) {
      // Không đọc được sản phẩm hợp lệ nào -> giữ nguyên catalog cũ, không ghi
      // đè bằng danh mục rỗng, và không cập nhật lastLoadTime để lần gọi sau
      // thử tải lại ngay (không phải đợi hết 30 phút cache).
      console.warn("⚠️ Không tìm thấy sản phẩm hợp lệ nào trong Sheet — giữ nguyên catalog cũ.");
      return productCatalog;
    }

    catalog += GENERIC_SALES_ADVICE;
    productCatalog = catalog;
    lastLoadTime = Date.now();
    console.log(`✅ Loaded ${count} product rows from Sheet (${badVatCount} lỗi định dạng VAT)`);
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
   - Thời lượng: 4 ngày | Học phí: 9.900.000 VND/người
   - Kết quả: Chứng chỉ nhà nước + Thẻ ATVSLĐ Nhóm 3

4. KHÓA ĐU DÂY NÂNG CAO & CỨU HỘ DÂY
   - Thời lượng & học phí: Theo yêu cầu (liên hệ báo giá)

${products ? products : ""}

HƯỚNG DẪN TƯ VẤN:
- Trả lời bằng tiếng Việt, thân thiện, ngắn gọn (tối đa 4-5 câu)
- Tư vấn cả khóa học lẫn thiết bị phù hợp với nhu cầu khách
- Khi khách hỏi sản phẩm: báo đúng tên, xuất xứ, và giá CHƯA VAT (đúng số "Đơn giá (chưa VAT)" trong danh mục). TUYỆT ĐỐI không tự cộng VAT vào giá báo ban đầu, không ghi "đã gồm VAT" hay đưa ra con số đã cộng thuế nếu khách chưa hỏi
- CHỈ khi khách hỏi rõ "giá đã có VAT chưa", "giá gồm VAT là bao nhiêu", "giá sau thuế", v.v. thì mới tính và báo thêm giá đã gồm VAT (= Đơn giá chưa VAT × (1 + % VAT ghi trong danh mục)), đồng thời nói rõ đơn giá gốc chưa VAT là bao nhiêu để khách đối chiếu
- Thuế VAT hiện tại mặc định là ${DEFAULT_VAT_PERCENT}% (trừ khi danh mục ghi rõ % khác cho từng sản phẩm), khi khách nói tỷ lệ khác thì phải check lại, không bao giờ tính lại giá theo con số khách đưa
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
    else rememberSentMid(json.message_id);
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

      // Facebook gửi "echo" cho MỌI tin nhắn Page gửi ra (cả bot lẫn admin gõ tay)
      if (event.message?.is_echo) {
        const mid = event.message.mid;
        if (!wasSentByBot(mid)) {
          // mid này không phải do bot gửi -> admin vừa tự trả lời thủ công
          const customerId = event.recipient?.id;
          if (customerId) handleAdminManualReply(customerId);
        }
        continue;
      }

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

      // ✋ Kiểm tra bot có đang bị tắt vĩnh viễn (/off) với user này không
      if (!isBotEnabled(senderId)) {
        console.log(`🔕 Bot đang OFF với user ${senderId} — bỏ qua tin nhắn.`);
        continue;
      }

      // ⏸️ Bot đang tạm dừng vì admin vừa tự trả lời — đợi thêm AUTO_RESUME_MINUTES
      // rồi mới tự động trả lời (gộp các tin nhắn khách gửi trong lúc chờ)
      const paused = autoPaused.get(senderId);
      if (paused) {
        console.log(`⏸️  [${senderId}] đang tạm dừng (admin vừa trả lời) — xếp hàng chờ.`);
        paused.pending.push(messageText);
        if (paused.timer) clearTimeout(paused.timer);
        paused.timer = setTimeout(() => resumeAfterSilence(senderId), CONFIG.AUTO_RESUME_MINUTES * 60 * 1000);
        autoPaused.set(senderId, paused);
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

  // /status — xem danh sách user đang bị tắt (vĩnh viễn hoặc tạm dừng)
  if (text === "/status") {
    let msgOut = "";
    if (botDisabledUsers.size === 0) {
      msgOut += "✅ Không có user nào bị tắt vĩnh viễn (/off).\n";
    } else {
      const list = [...botDisabledUsers].map(id => `• \`${id}\``).join("\n");
      msgOut += `🔕 Đang *TẮT vĩnh viễn* (${botDisabledUsers.size}):\n${list}\n`;
    }
    if (autoPaused.size === 0) {
      msgOut += "\n✅ Không có user nào đang tạm dừng do admin trả lời tay.";
    } else {
      const list = [...autoPaused.entries()]
        .map(([id, p]) => `• \`${id}\` (${p.pending.length} tin đang chờ)`)
        .join("\n");
      msgOut += `\n⏸️ Đang *tạm dừng* (${autoPaused.size}), tự bật lại sau ${CONFIG.AUTO_RESUME_MINUTES} phút nếu bạn không trả lời tiếp:\n${list}`;
    }
    await sendTelegramText(msgOut);
    return;
  }

  // /help — hướng dẫn
  if (text === "/help" || text === "/start") {
    await sendTelegramText(
      `🤖 *Iron Land Bot — Lệnh điều khiển*\n\n` +
      `/off <userID> — Tắt bot vĩnh viễn, tự reply thủ công\n` +
      `/on <userID>  — Bật lại bot tự động\n` +
      `/status       — Xem user nào đang bị tắt / tạm dừng\n\n` +
      `💡 Bot tự nhận biết khi bạn trả lời tay trong Messenger và *tự tạm dừng* cho khách đó.\n` +
      `Nếu khách nhắn tiếp mà bạn không trả lời trong ${CONFIG.AUTO_RESUME_MINUTES} phút, bot tự động trả lời lại (không cần /on).\n` +
      `Facebook User ID xuất hiện trong thông báo lead mỗi khi có khách nhắn.`
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
