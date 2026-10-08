const express = require("express");
const { google } = require("googleapis");
const fs = require("fs");
const path = require("path");
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
  // Secret để gọi endpoint /admin/add-product (ghi trực tiếp vào Sheet sản phẩm).
  // Không đặt biến môi trường này = endpoint bị tắt hoàn toàn (an toàn mặc định).
  ADMIN_SECRET: process.env.ADMIN_SECRET,
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
const HOTLINE_PHONE = "0907 713 137"; // Hotline sếp — dùng khi khách hỏi sản phẩm ngoài danh mục

// Sản phẩm gắn cứng trực tiếp vào code (không phụ thuộc Google Sheet, luôn có
// sẵn ngay cả khi Sheet lỗi/chưa cập nhật/còn cache). Dùng cho sản phẩm cần
// chắc chắn bot biết ngay. Muốn thêm sản phẩm mới kiểu này thì thêm 1 object
// vào mảng bên dưới theo đúng cấu trúc. (Rỗng — từ khi có endpoint
// /admin/add-product ghi thẳng vào Sheet, không cần gắn cứng nữa; AWAH Z3 PRO
// đã chuyển qua Sheet là nguồn chính thức.)
const HARDCODED_PRODUCTS = [];

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

// Chuyển mảng HARDCODED_PRODUCTS thành đoạn text theo đúng format catalog,
// đánh số tiếp theo từ số thứ tự đang có (startIndex) để không trùng số.
function buildHardcodedProductsText(startIndex) {
  let text = "";
  let idx = startIndex;
  for (const p of HARDCODED_PRODUCTS) {
    idx++;
    text += `${idx}. ${p.name}\n`;
    if (p.brand) text += `   Thương hiệu: ${p.brand}\n`;
    if (p.category) text += `   Loại: ${p.category}\n`;
    text += `   Đơn giá (chưa VAT): ${formatVnd(p.priceVnd)} VND\n`;
    text += `   VAT: ${p.vatPercent}%\n`;
    text += "\n";
  }
  return { text, count: HARDCODED_PRODUCTS.length };
}

async function loadProductCatalog() {
  if (productCatalog && Date.now() - lastLoadTime < CACHE_DURATION) {
    return productCatalog;
  }
  if (!CONFIG.PRODUCT_SPREADSHEET_ID || !CONFIG.GOOGLE_CLIENT_EMAIL) {
    const { text } = buildHardcodedProductsText(0);
    return "DANH MỤC SẢN PHẨM & THIẾT BỊ AN TOÀN TRÊN CAO:\n\n" + text + GENERIC_SALES_ADVICE;
  }
  try {
    const sheets = google.sheets({ version: "v4", auth: getGoogleAuth() });
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: CONFIG.PRODUCT_SPREADSHEET_ID,
      range: "Trang tính1!A1:L3000", // nâng từ 500 -> 3000 dòng vì danh mục đã vượt 500 sau khi import Master List
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
      // Chỉ in dòng VAT khi KHÁC mặc định, để prompt gọn khi danh mục hàng trăm mã
      if (vatPercent !== null && vatPercent !== DEFAULT_VAT_PERCENT) catalog += `   VAT: ${vatPercent}%\n`;
      if (specs) catalog += `   Thông số: ${specs}\n`;
      if (!isGenericVatNote(vatNote)) catalog += `   Ghi chú: ${vatNote}\n`;
      catalog += "\n";
    }

    if (badVatCount > 0) {
      console.warn(`⚠️  ${badVatCount} sản phẩm có ô VAT sai định dạng trong Sheet (nghi bị Sheets tự đổi thành giờ:phút:giây) — đã dùng mặc định ${DEFAULT_VAT_PERCENT}%. Nên mở Sheet, format lại cột VAT (cột L) thành Percent/Plain text và nhập lại % đúng.`);
    }

    if (count === 0) {
      // Không đọc được sản phẩm hợp lệ nào trong Sheet -> vẫn đảm bảo các sản
      // phẩm gắn cứng (HARDCODED_PRODUCTS) luôn xuất hiện, không phụ thuộc Sheet.
      console.warn("⚠️ Không tìm thấy sản phẩm hợp lệ nào trong Sheet — dùng danh mục cũ + sản phẩm gắn cứng.");
      const { text } = buildHardcodedProductsText(0);
      const base = productCatalog || "DANH MỤC SẢN PHẨM & THIẾT BỊ AN TOÀN TRÊN CAO:\n\n";
      return base.replace(GENERIC_SALES_ADVICE, "") + text + GENERIC_SALES_ADVICE;
    }

    const { text: hardcodedText } = buildHardcodedProductsText(count);
    catalog += hardcodedText;
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

2. KHÓA ĐU DÂY TIẾP CẬN CƠ BẢN
   - Thời lượng: 4 ngày | Học phí: 10.000.000 VND/người
   - Kết quả: Sau khóa học được cấp chứng nhận hoàn thành của Iron Land

3. KHÓA ĐU DÂY NÂNG CAO & CỨU HỘ DÂY
   - Thời lượng & học phí: Theo yêu cầu (liên hệ báo giá)

SHOWROOM IRON LAND:
- Địa chỉ: 4/1 Bàu Cát 1, TP.HCM
- Giờ hoạt động: 9h00 - 16h00 (các ngày trong tuần)
- Showroom trưng bày rất nhiều thương hiệu thiết bị an toàn trên cao để khách xem và lựa chọn trực tiếp
- Lưu ý quan trọng: khách cần GỌI ĐIỆN BÁO TRƯỚC ÍT NHẤT 15 PHÚT trước khi đến để nhân viên chuẩn bị đón tiếp

${products ? products : ""}

TỪ NGỮ KHÁCH HAY DÙNG (ánh xạ sang đúng tên sản phẩm/nhóm sản phẩm trong danh mục):
- "Dây cứu sinh", "cứu sinh" (khi khách hỏi mua/tư vấn thiết bị): KHÔNG phải dây thừng (rope) — khách đang nói đến THIẾT BỊ CHỐNG RƠI (fall arrester/back-up), ví dụ ASAT RA2, ASAP LOCK KIT hoặc các thiết bị cùng nhóm "Fall Arrester"/"Mobile Fall Arrester" trong danh mục. Khi gặp từ này, tư vấn đúng nhóm thiết bị chống rơi, không tư vấn nhầm sang dây thừng (Semi-static Rope)

HƯỚNG DẪN TƯ VẤN:
- NGÔN NGỮ: Nếu khách nhắn bằng tiếng Việt thì trả lời bằng tiếng Việt. Nếu khách nhắn bằng bất kỳ ngôn ngữ nào KHÁC tiếng Việt (tiếng Anh, Trung, Hàn, Nhật, Thái...) thì LUÔN trả lời bằng tiếng Anh, kể cả khi trước đó đang nói chuyện bằng tiếng Việt — bám theo ngôn ngữ của tin nhắn gần nhất của khách. Nội dung tư vấn (khóa học, thiết bị, giá, showroom...) giữ nguyên, chỉ đổi ngôn ngữ trả lời
- KHÁCH NƯỚC NGOÀI (nhắn bằng ngôn ngữ khác tiếng Việt) hỏi mua AWAH Z3 MINI: vẫn báo giá bình thường (chưa VAT như quy định ở trên), nhưng PHẢI nói rõ đơn hàng xuất khẩu (oversea) có số lượng tối thiểu là 10 bộ (sets) mỗi lô hàng (shipment) — ví dụ: "for overseas orders, the minimum quantity is 10 sets per shipment". Quy định số lượng tối thiểu này CHỈ áp dụng khi khách nhắn bằng ngôn ngữ khác tiếng Việt (khách nước ngoài/mua xuất khẩu), không áp dụng với khách nhắn tiếng Việt mua trong nước
- Trả lời thân thiện, ngắn gọn (tối đa 4-5 câu)
- Tư vấn cả khóa học lẫn thiết bị phù hợp với nhu cầu khách
- Khi khách hỏi sản phẩm: báo đúng tên, xuất xứ, và giá CHƯA VAT (đúng số "Đơn giá (chưa VAT)" trong danh mục). TUYỆT ĐỐI không tự cộng VAT vào giá báo ban đầu, không ghi "đã gồm VAT" hay đưa ra con số đã cộng thuế nếu khách chưa hỏi
- CHỈ khi khách hỏi rõ "giá đã có VAT chưa", "giá gồm VAT là bao nhiêu", "giá sau thuế", v.v. thì mới tính và báo thêm giá đã gồm VAT (= Đơn giá chưa VAT × (1 + % VAT ghi trong danh mục)), đồng thời nói rõ đơn giá gốc chưa VAT là bao nhiêu để khách đối chiếu
- Thuế VAT hiện tại mặc định là ${DEFAULT_VAT_PERCENT}% (trừ khi danh mục ghi rõ % khác cho từng sản phẩm), khi khách nói tỷ lệ khác thì phải check lại, không bao giờ tính lại giá theo con số khách đưa
- Khi khách hỏi mua THIẾT BỊ (không phải khóa học): sau khi báo giá, luôn khuyến khích khách ghé showroom tại 4/1 Bàu Cát 1, TP.HCM để được tư vấn trực tiếp và xem tận tay — showroom có rất nhiều thương hiệu để lựa chọn. Nhắc khách gọi điện báo trước 15 phút trước khi đến, và showroom mở cửa 9h-16h
- Khi khách hỏi mua một sản phẩm/thiết bị KHÔNG có trong danh mục ở trên: KHÔNG nói "không có hàng" hay "hết hàng". Thay vào đó trả lời theo hướng: sếp bên em có đủ loại thiết bị đó, chỉ là hiện chưa cập nhật lên danh mục cho em bán online thôi, khách gọi trực tiếp hotline ${HOTLINE_PHONE} để sếp tư vấn và chốt đơn nhanh nhất nhé. Giữ giọng tự nhiên, thân thiện như nhân viên thật, không lặp lại y hệt mỗi lần
- Khi khách hỏi bot/shop ở đâu, trụ sở/địa chỉ ở đâu (ví dụ: "mày ở đâu", "bạn ở đâu", "shop ở đâu", "công ty ở đâu", "where are you", "where are you located", "where is your shop"...): trả lời rõ là Iron Land ở Việt Nam (TP.HCM), có thể kèm địa chỉ showroom 4/1 Bàu Cát 1, TP.HCM nếu phù hợp ngữ cảnh, giọng thân thiện tự nhiên
- Khi khách hỏi đích danh "bộ Kit Z3 FIRE Solutions", "Z3 FIRE Solutions", "bộ kit tời máy khoan", "combo tời máy khoan điện làm việc trên cao"... (bộ giải pháp trọn gói dùng tời AWAH Z3-FIRE kết hợp máy khoan điện để nâng hạ khi làm việc trên cao): liệt kê ĐẦY ĐỦ toàn bộ danh sách sản phẩm trong bộ kit này (không giới hạn 5 sản phẩm như quy tắc hỏi chung chung bên dưới, vì đây là khách hỏi đích danh 1 bộ combo cụ thể), gồm:
  1. Nón bảo hộ Petzl Vertex Vent (Yellow) – 3.000.000đ
  2. Đai bảo hộ Petzl AVAO International Version – 11.840.000đ
  3. Bộ chống rơi Petzl Asap Lock Kit – 10.910.000đ
  4. Tời nâng hạ dùng máy khoan pin AWAH Z3-FIRE – 17.500.000đ
  5. Máy khoan Milwaukee M18 FPD3-0X (kèm 2 pin M18B5 + 1 sạc) – 7.350.000đ
  6. Dây buộc dụng cụ Adjustable Tool Leash – 370.000đ
  7. Dây neo vải Petzl Anneau Sling 120cm Green (x2 sợi) – 320.000đ/sợi
  8. Dây neo thép Petzl Wire Strop 100cm (x2 sợi) – 1.320.000đ/sợi
  9. Móc khoá OXAN Screw-Lock Steel Carabiner (x6 cái) – 480.000đ/cái
  10. Dây thừng tĩnh Beal Industrie 10.5mm (đặt hàng theo mét) – 78.824đ/m
  11. Dây thừng tĩnh Petzl Parallel 10.5mm – 80.000đ/m
  12. Ròng rọc xoay Petzl Spin L1 – 4.370.000đ
  13. Ròng rọc tải Petzl Tandem – 2.540.000đ
  14. Túi đựng dây Petzl Bucket 45 – 3.120.000đ
  Tất cả giá trên đều CHƯA VAT. Sau khi liệt kê, nói rõ đây là bộ kit đầy đủ để lắp đặt hệ thống tời máy khoan điện làm việc trên cao, có thể tuỳ chỉnh bớt/thêm hạng mục theo nhu cầu thực tế, và mời khách ghé showroom hoặc gọi hotline ${HOTLINE_PHONE} để được tư vấn cấu hình phù hợp và báo giá chính xác (còn có chi phí tư vấn/hướng dẫn training lắp đặt sử dụng theo yêu cầu riêng)
- Khi khách CHỈ hỏi chung chung về "bộ tời Z3", "tời Z3", "dòng Z3", "thiết bị Z3"... (KHÔNG nhắc rõ "Z3 FIRE Solutions"/"combo"/"kit"): đây KHÔNG phải hỏi về bộ kit combo ở trên. Thay vào đó liệt kê giá các dòng tời/thiết bị nâng hạ AWAH Z3 hiện có trong danh mục (tên + giá chưa VAT), ví dụ: AWAH Z3 MINI, AWAH Z2-A, AWAH Z3 PRO, AWAH Z3-FIRE (lấy đúng giá mới nhất trong danh mục sản phẩm ở trên, không dùng số cũ), rồi hỏi khách đang quan tâm mục đích sử dụng gì (nâng hạ cứu hộ, làm việc trên cao, dùng máy khoan...) để tư vấn đúng dòng phù hợp
- Khi khách hỏi kiểu chung chung "gửi danh sách hàng hoá/sản phẩm cho tôi", "có những sản phẩm gì", "xem catalogue"... (KHÔNG hỏi rõ một sản phẩm/nhóm cụ thể): ĐỪNG liệt kê ngay toàn bộ danh mục. Thay vào đó hỏi lại khách đang quan tâm nhóm sản phẩm nào (ví dụ: thiết bị hãm/descender, carabiner/móc khoá, dây, đai bảo hộ, thiết bị chống rơi...) để tư vấn đúng nhu cầu. Sau khi khách trả lời nhóm quan tâm (hoặc nói "tất cả"/"gì cũng được"), liệt kê TỐI ĐA 5 sản phẩm phù hợp nhất một lần (tên + giá chưa VAT, không cần mô tả dài dòng), rồi hỏi khách có muốn xem thêm không — nếu khách đồng ý thì liệt kê tiếp tối đa 5 sản phẩm kế tiếp trong nhóm đó, cứ vậy cho đến hết. Không bao giờ liệt kê quá 5 sản phẩm trong một tin nhắn
- QUY TẮC BÁO GIÁ HÀNG CAO CẤP vs HÀNG XINDA (áp dụng cho MỌI loại sản phẩm có cả hàng cao cấp lẫn hàng Xinda: dây thừng, carabiner, đai, mũ, ròng rọc, thiết bị hãm, chống rơi...; "hàng cao cấp" = các thương hiệu khác Xinda như Petzl, Beal, Teufelberger, Tendon, DMM, Skylotec, Climbing Technology, Kask, Edelrid, IKAR, ASAT...; hàng dây thừng cao cấp thường giá trên 70.000đ/mét):
  0) LUẬT CỨNG: trong tin nhắn đầu tiên trả lời khách hỏi chung (ví dụ "mua dây", "giá dây", "có dây không"), danh sách báo giá KHÔNG ĐƯỢC chứa BẤT KỲ sản phẩm nào có chữ "Xinda" (tên, thương hiệu hay mã XD...). Chỉ liệt kê Beal, Petzl, Teufelberger, Tendon... Trước khi gửi, tự rà lại danh sách và xoá mọi dòng Xinda. Ví dụ đúng: liệt kê Patron, Industrie, Parallel rồi hỏi "Anh/chị có muốn tham khảo dòng giá tốt hơn không ạ?" — không kèm dòng Xinda nào
  1) Khách hỏi chung về một loại sản phẩm, KHÔNG nhắc tên Xinda: CHỈ báo giá các dòng hàng cao cấp (theo quy tắc tối đa 5 sản phẩm mỗi tin nhắn), TUYỆT ĐỐI KHÔNG báo giá hay nhắc tới hàng Xinda ngay từ đầu. Cuối tin hỏi khách một câu kiểu "Anh/chị có muốn tham khảo thêm dòng giá tốt hơn không ạ?". CHỈ khi khách đồng ý (trả lời "có", "ok", "muốn", "yes", "gửi đi", "tham khảo thêm"...) thì mới báo giá các dòng Xinda cùng loại (kèm giá cụ thể, vẫn tối đa 5 sản phẩm mỗi tin)
  2) Khách hỏi đích danh hàng Xinda ngay từ đầu (có nhắc "Xinda", "XD" hoặc mã hàng Xinda): báo giá hàng Xinda luôn, rồi hỏi lại "Anh/chị có muốn tham khảo thêm các dòng cao cấp hơn không ạ?". Nếu khách đồng ý thì báo giá các dòng cao cấp cùng loại; nếu khách từ chối hoặc nói thêm yêu cầu khác thì phản hồi tiếp theo đúng câu trả lời của khách, không ép
  3) Nếu loại sản phẩm đó chỉ có hàng Xinda (không có hàng cao cấp trong danh mục) thì báo hàng Xinda bình thường, không cần hỏi thêm câu so sánh
- QUY TẮC TƯ VẤN "TRỌN BỘ ROPE ACCESS / THIẾT BỊ LÀM VIỆC TRÊN CAO": áp dụng khi khách hỏi giá trọn bộ rope access, trọn bộ thiết bị làm việc trên cao, bộ rope access cơ bản, hoặc cần tư vấn thiết bị/cấu hình làm việc trên cao:
  a) Nếu khách CHƯA nêu công việc cụ thể: hỏi trước đúng câu "Anh/chị dùng thiết bị cho công việc cụ thể nào ạ?" rồi dừng, chưa đề xuất cấu hình. Nếu khách đã nêu rõ công việc ngay trong câu hỏi thì KHÔNG hỏi lại
  b) Chỉ đề xuất sản phẩm có bản ghi trong danh sách hàng hoá đã nạp. Tên, mã hàng, giá, thông số, xuất xứ phải lấy đúng từ dữ liệu; không tự thêm sản phẩm ngoài danh sách, không bịa hay suy diễn, không khẳng định tương thích nếu dữ liệu không xác nhận
  c) Công việc là LAU KÍNH, SƠN NƯỚC hoặc ĐIỆN LẠNH: gửi cấu hình GIÁ THẤP/GIÁ TỐT trước, chọn từ các sản phẩm giá thấp trong danh sách, ưu tiên Xinda hoặc hàng Trung Quốc nếu thương hiệu/xuất xứ đó có trong dữ liệu. Sau đó hỏi "Anh/chị có muốn tham khảo thêm bộ giá cao hơn không ạ?". CHỈ gửi cấu hình giá cao hơn nếu khách đồng ý
  d) Các công việc KHÁC: gửi CẤU HÌNH CAO CẤP trước, dựa trên sản phẩm dữ liệu xác định là cao cấp hoặc có giá cao hơn (không tự gắn nhãn "cao cấp" nếu không có căn cứ; khi đó gọi là "cấu hình theo các sản phẩm có giá cao hơn trong danh sách"). Sau đó hỏi "Anh/chị có muốn tham khảo thêm cấu hình giá tốt hơn không?". CHỈ gửi cấu hình giá thấp hơn nếu khách đồng ý. Không bao giờ gửi cả hai cấu hình cùng lúc khi khách chưa đồng ý
  e) Chọn sản phẩm phù hợp cho những nhóm thiết bị có hàng: dây làm việc và dây dự phòng; đai toàn thân; thiết bị lên/xuống dây; thiết bị dự phòng chống rơi; khoá nối, dây nối và phụ kiện; thiết bị neo, sling, bộ chuyển hướng, bảo vệ cạnh dây; mũ bảo hộ, găng tay, giày, phương tiện liên lạc, thiết bị cứu hộ
  f) Trình bày từng sản phẩm với các trường có sẵn: nhóm thiết bị, tên hàng, mã hàng, số lượng, thông số/tiêu chuẩn, giá (chưa VAT; dây bán theo cuộn phải ghi số mét như quy tắc báo giá dây). Nhóm nào danh sách không có sản phẩm hoặc không đủ thông tin để ghép bộ thì nói rõ phần còn thiếu và hỏi thêm thông tin cần thiết (môi trường, số người, kích cỡ, thông số cần đáp ứng)
  h) LUẬT CHỌN ĐAI: với công việc rope access, điện lạnh, bảo trì công nghiệp, đu dây (lau kính, sơn nước...) CHỈ chọn các đai sau: Petzl ASTRO, Petzl AVAO, các đai hãng BARHAR, các đai hãng ASAT, và đai mà dữ liệu ghi rõ "rope access" hoặc có chest ascender/tích hợp chest ascender (ví dụ Xinda có "chest ascender" trong tên). TUYỆT ĐỐI KHÔNG đưa đai NEWTON (Petzl) và các đai làm việc trên cao thông thường (work at height, không có chest ascender) vào cấu hình rope access/điện lạnh/bảo trì công nghiệp/đu dây. Đai thông thường chỉ dùng cho khách cần làm việc trên cao thông thường (không đu dây). Nếu trong mức giá đang tư vấn không có đai rope access phù hợp trong danh sách thì nói rõ là chưa có và hướng khách liên hệ nhân viên, không thay bằng đai thông thường
  i) BẮT BUỘC ĐỦ NHÓM: mọi cấu hình rope access/làm việc trên cao PHẢI có (1) MŨ BẢO HỘ (helmet) chọn từ nhóm "Mũ bảo hộ & phụ kiện mũ" và (2) HỆ DÂY NEO (dây định vị/lanyard dây cow's tail, sling, thiết bị neo) chọn từ nhóm "Lanyard & dây định vị" và "Neo, sling & rigging", cùng các nhóm khác ở mục e). Trước khi gửi, tự rà lại cấu hình xem đã có mũ bảo hộ và hệ dây neo chưa; nhóm nào danh sách không có thì ghi rõ "chưa có trong danh sách"
  k) PHÂN LOẠI THIẾT BỊ: Skylotec CRIC (SKT/H-280) là thiết bị KẸP DÂY THÔNG MINH (smart rope clamp), KHÔNG phải khoá hãm, KHÔNG phải thiết bị đi xuống/hạ dây (descender). Không xếp CRIC vào nhóm thiết bị hạ/descender khi lập cấu hình hay tư vấn; không mô tả CRIC là descender
  j) THIẾT BỊ CHỐNG RƠI CHO CẤU HÌNH GIÁ THẤP/GIÁ TỐT HƠN: dùng bộ chống rơi di động ASAT RA2 (RA2 kèm giảm chấn LE-08) có trong danh sách làm thiết bị dự phòng chống rơi, thay cho các thiết bị chống rơi hãng cao cấp
  g) Không khẳng định cấu hình là đầy đủ, an toàn hay đạt chuẩn nếu dữ liệu không chứng minh. Luôn nêu rõ đây là đề xuất từ danh sách hàng hoá đã nạp và cần người phụ trách chuyên môn xác nhận trước khi sử dụng thực tế
- TỪ KHOÁ "KHÓA DÂY" / "KHOÁ DÂY": khi khách nói "khóa dây", "khoá dây", "cần mua khóa dây" (không kèm các từ "học", "lớp", "đào tạo", "chứng chỉ", "chứng nhận") thì đó là THIẾT BỊ ĐU DÂY dạng khoá hãm/thiết bị đi xuống (descender) như số 8, I'D S, Air-Stop, Spark, Sirius..., KHÔNG phải khóa học. TUYỆT ĐỐI không giới thiệu khóa học trong trường hợp này. Hãy trả lời bằng sản phẩm thuộc nhóm "Thiết bị hạ (Descender) & hãm" trong danh sách (theo quy tắc báo giá hàng cao cấp trước/Xinda sau, tối đa 5 sản phẩm mỗi tin; không xếp thiết bị kẹp dây như Skylotec CRIC vào nhóm này), có thể hỏi thêm khách dùng cho công việc gì. Chỉ khi khách nói rõ muốn học/đăng ký lớp/khóa đào tạo mới tư vấn khóa học
- QUY TẮC BÁO GIÁ DÂY: (1) Dây nào dữ liệu ghi giá theo mét (ĐVT mét, ví dụ Industrie, Parallel...) thì giữ nguyên báo giá theo mét (đ/m). (2) Dây nào ĐVT là "Cuộn" thì báo giá theo cuộn và mở ngoặc ghi cuộn đó dài bao nhiêu mét, đúng định dạng như: "8.000.000đ/cuộn (100M)". Nếu có nhiều quy cách cuộn thì liệt kê từng cuộn dạng "6.402.000đ/cuộn (50M); 25.830.000đ/cuộn (200M)". Tuyệt đối không đưa giá cuộn mà thiếu số mét trong ngoặc. Quy cách cuộn nào dữ liệu chưa có giá thì nói nhân viên sẽ xác nhận giá
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

// ===================== GHI GOOGLE SHEETS (SẢN PHẨM) =====================
// Ghi trực tiếp 1 dòng sản phẩm mới vào Sheet "danh sach hang hoa", đúng cấu
// trúc cột đang dùng ở loadProductCatalog() (A=SKU,B=Tên,C=Thương hiệu,
// D=Nhóm,E=Giá chưa VAT,F=Knowledge,...,L=VAT). Cần service account
// (GOOGLE_CLIENT_EMAIL) có quyền Editor (không chỉ Viewer) trên Sheet này.
async function appendProductRow(p) {
  const sheets = google.sheets({ version: "v4", auth: getGoogleAuth() });
  const knowledge =
    `SẢN PHẨM: ${p.name}\n` +
    `THƯƠNG HIỆU: ${p.brand || ""}\n` +
    `NHÓM SẢN PHẨM: ${p.category || ""}\n` +
    `THÔNG SỐ KỸ THUẬT: ${p.specs || ""}\n` +
    `LỢI ÍCH CHÍNH: ${p.benefits || "-"}\n` +
    `TƯ VẤN BÁN HÀNG: ${p.salesNote || "-"}\n` +
    `CÂU HỎI THƯỜNG GẶP: Q: Sản phẩm này dùng để làm gì? A: ${p.usage || p.category || ""} ` +
    `Q: Có CO, CQ và hóa đơn VAT không? A: ${p.promo ? p.promo + " " : ""}Hàng đầy đủ CO, CQ và hoá đơn VAT\n` +
    `SO SÁNH VÀ GỢI Ý: ${p.compare || "-"}`;

  // QUAN TRỌNG: cột G-K luôn trống ở MỌI dòng trong sheet này -> nếu ghi bằng
  // 1 lệnh append với range "A:L", Google Sheets API hiểu nhầm đây là 2 bảng
  // tách rời (A:F và L) do khoảng trống liên tục ở G-K, và append lệch hẳn
  // sang các cột M trở đi thay vì A. Khắc phục bằng cách tách làm 2 bước ghi
  // KHÔNG có khoảng trống ở giữa: (1) append A:F trước để xác định đúng dòng
  // mới, (2) update thẳng đúng ô L của dòng đó cho giá trị VAT.
  const rowA_F = [p.sku || "-", p.name, p.brand || "", p.category || "", p.price, knowledge];

  const appendResult = await sheets.spreadsheets.values.append({
    spreadsheetId: CONFIG.PRODUCT_SPREADSHEET_ID,
    range: "Trang tính1!A:F",
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [rowA_F] },
  });

  const updatedRange = appendResult.data.updates.updatedRange; // vd "'Trang tính1'!A21:F21"
  const match = updatedRange.match(/![A-Z]+(\d+):/);
  const rowNumber = match ? parseInt(match[1], 10) : null;

  if (rowNumber) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: CONFIG.PRODUCT_SPREADSHEET_ID,
      range: `Trang tính1!L${rowNumber}`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [[`${p.vat || DEFAULT_VAT_PERCENT}%`]] }, // ghi dạng '8%' (ô cột L định dạng Percent: ghi số 8 sẽ thành 800%)
    });
  }

  // Bắt catalog tải lại ngay ở lần hỏi tiếp theo, không đợi hết cache 30 phút
  lastLoadTime = 0;
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
      requestBody: { values: [[time, lead.name, lead.phone, lead.course, fbUserId]] },
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
      generationConfig: {
        maxOutputTokens: 1536,
        temperature: 0.7,
        // Gemini 2.5 Flash trừ "thinking tokens" (suy luận nội bộ, không hiển thị)
        // vào chung maxOutputTokens. Đây là nguyên nhân chính khiến câu trả lời bị
        // cắt cụt giữa chừng dù đã tăng maxOutputTokens — tắt hẳn thinking để dồn
        // toàn bộ token cho câu trả lời thực tế (tác vụ tư vấn đơn giản, không cần).
        thinkingConfig: { thinkingBudget: 0 },
      },
    }),
  });
  const data = await response.json();
  if (data.error) { console.error("Gemini error:", data.error); throw new Error(data.error.message); }
  const candidate = data.candidates?.[0];
  const rawReply = candidate?.content?.parts?.[0]?.text || "Xin lỗi, có lỗi xảy ra. Vui lòng thử lại sau.";
  if (candidate?.finishReason === "MAX_TOKENS") {
    // Vẫn bị cắt dù đã tắt thinking + tăng token — log rõ để dễ phát hiện nếu tái diễn
    console.warn(`⚠️  [${userId}] Phản hồi Gemini bị cắt do chạm giới hạn MAX_TOKENS.`);
  }
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

// ===================== ADMIN: THÊM SẢN PHẨM VÀO SHEET =====================
// GET /admin/add-product?secret=...&name=...&price=...&brand=...&category=...&sku=...&vat=...&specs=...
// Chỉ hoạt động khi có ADMIN_SECRET trong env và secret khớp. Dùng nội bộ
// (Claude gọi thay anh khi anh nhờ thêm sản phẩm qua chat), KHÔNG chia sẻ URL này ra ngoài.
app.get("/admin/add-product", async (req, res) => {
  if (!CONFIG.ADMIN_SECRET) return res.status(404).send("Not found");
  if (req.query.secret !== CONFIG.ADMIN_SECRET) return res.status(403).send("Forbidden");

  const { name, price } = req.query;
  if (!name || !price || isNaN(Number(price))) {
    return res.status(400).json({ ok: false, error: "Thiếu 'name' hoặc 'price' không hợp lệ" });
  }

  try {
    await appendProductRow({
      sku: req.query.sku,
      name,
      brand: req.query.brand,
      category: req.query.category,
      price: Number(price),
      vat: req.query.vat ? Number(req.query.vat) : undefined,
      specs: req.query.specs,
      benefits: req.query.benefits,
      salesNote: req.query.salesNote,
      usage: req.query.usage,
      promo: req.query.promo,
      compare: req.query.compare,
    });
    res.json({ ok: true, message: `Đã thêm "${name}" vào danh mục sản phẩm.` });
  } catch (err) {
    console.error("❌ Admin add-product error:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /admin/bulk-import?secret=...&from=0&count=100[&dry=1] — nhập hàng loạt từ
// file products-import.json (nằm cạnh index.js). Bỏ qua SKU đã có trong Sheet nên
// chạy lại nhiều lần vẫn an toàn. Ghi theo lô: append A:F cả lô, rồi update cột L
// (VAT) đúng khoảng dòng vừa ghi (tránh lỗi Sheets lệch cột do G-K trống).
app.get("/admin/bulk-import", async (req, res) => {
  if (!CONFIG.ADMIN_SECRET) return res.status(404).send("Not found");
  if (req.query.secret !== CONFIG.ADMIN_SECRET) return res.status(403).send("Forbidden");
  try {
    const all = JSON.parse(fs.readFileSync(path.join(__dirname, "products-import.json"), "utf8"));
    const from = parseInt(req.query.from || "0", 10);
    const count = parseInt(req.query.count || "100", 10);
    const batch = all.slice(from, from + count);
    const sheets = google.sheets({ version: "v4", auth: getGoogleAuth() });
    const cur = await sheets.spreadsheets.values.get({
      spreadsheetId: CONFIG.PRODUCT_SPREADSHEET_ID,
      range: "Trang tính1!A1:A5000",
    });
    const have = new Set((cur.data.values || []).map(r => (r[0] || "").trim().toUpperCase()));
    const todo = batch.filter(p => !have.has((p.sku || "").trim().toUpperCase()));
    if (req.query.dry) {
      return res.json({ ok: true, dry: true, total: all.length, from, batch: batch.length, wouldAdd: todo.length });
    }
    if (todo.length === 0) {
      return res.json({ ok: true, total: all.length, from, batch: batch.length, added: 0, next: from + count });
    }
    const rows = todo.map(p => {
      const knowledge =
        `SẢN PHẨM: ${p.name}\nTHƯƠNG HIỆU: ${p.brand || ""}\nNHÓM SẢN PHẨM: ${p.category || ""}\n` +
        `THÔNG SỐ KỸ THUẬT: ${p.specs || ""}\nLỢI ÍCH CHÍNH: -\nTƯ VẤN BÁN HÀNG: -\n` +
        `CÂU HỎI THƯỜNG GẶP: Q: Sản phẩm này dùng để làm gì? A: ${p.category || ""} ` +
        `Q: Có CO, CQ và hóa đơn VAT không? A: Hàng đầy đủ CO, CQ và hoá đơn VAT\nSO SÁNH VÀ GỢI Ý: -`;
      return [p.sku || "-", p.name, p.brand || "", p.category || "", p.price, knowledge];
    });
    const ap = await sheets.spreadsheets.values.append({
      spreadsheetId: CONFIG.PRODUCT_SPREADSHEET_ID,
      range: "Trang tính1!A:F",
      valueInputOption: "USER_ENTERED",
      requestBody: { values: rows },
    });
    const m = ap.data.updates.updatedRange.match(/!A(\d+):F(\d+)/);
    if (!m) throw new Error("Không đọc được updatedRange: " + ap.data.updates.updatedRange);
    const r1 = parseInt(m[1], 10), r2 = parseInt(m[2], 10);
    await sheets.spreadsheets.values.update({
      spreadsheetId: CONFIG.PRODUCT_SPREADSHEET_ID,
      range: `Trang tính1!L${r1}:L${r2}`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: todo.map(p => [`${p.vat || DEFAULT_VAT_PERCENT}%`]) },
    });
    lastLoadTime = 0;
    res.json({ ok: true, total: all.length, from, batch: batch.length, added: todo.length, rows: `${r1}-${r2}`, next: from + count });
  } catch (err) {
    console.error("❌ bulk-import error:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /admin/fix-vat?secret=...&from=21&to=528 — ghi lại cột L (VAT) thành "8%" cho
// khoảng dòng chỉ định (sửa lỗi ghi số 8 bị Sheets hiểu thành 800%).
app.get("/admin/fix-vat", async (req, res) => {
  if (!CONFIG.ADMIN_SECRET) return res.status(404).send("Not found");
  if (req.query.secret !== CONFIG.ADMIN_SECRET) return res.status(403).send("Forbidden");
  try {
    const from = parseInt(req.query.from, 10), to = parseInt(req.query.to, 10);
    if (!from || !to || to < from || to - from > 2000) return res.status(400).json({ ok: false, error: "from/to không hợp lệ" });
    const sheets = google.sheets({ version: "v4", auth: getGoogleAuth() });
    await sheets.spreadsheets.values.update({
      spreadsheetId: CONFIG.PRODUCT_SPREADSHEET_ID,
      range: `Trang tính1!L${from}:L${to}`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: Array.from({ length: to - from + 1 }, () => [`${DEFAULT_VAT_PERCENT}%`]) },
    });
    lastLoadTime = 0;
    res.json({ ok: true, fixed: `${from}-${to}` });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /admin/list-products?secret=... — liệt kê nhanh SKU/tên/giá đang có trong
// Sheet (đọc trực tiếp từ Google Sheets API, không qua cache), dùng để Claude
// kiểm tra nhanh khi cần debug, không phải nguồn tư vấn chính của bot.
app.get("/admin/list-products", async (req, res) => {
  if (!CONFIG.ADMIN_SECRET) return res.status(404).send("Not found");
  if (req.query.secret !== CONFIG.ADMIN_SECRET) return res.status(403).send("Forbidden");
  try {
    const sheets = google.sheets({ version: "v4", auth: getGoogleAuth() });
    const r = await sheets.spreadsheets.values.get({
      spreadsheetId: CONFIG.PRODUCT_SPREADSHEET_ID,
      range: "Trang tính1!A1:E5000",
    });
    const rows = r.data.values || [];
    const list = rows
      .map((row, i) => ({ rowNumber: i + 1, sku: row[0], name: row[1], brand: row[2], category: row[3], price: row[4] }))
      .filter(row => row.name && row.price);
    res.json({ ok: true, totalRowsScanned: rows.length, count: list.length, products: list });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /admin/debug-sheet?secret=... — soi toàn bộ sheet (kể cả cột F-L), lấy
// metadata thật của sheet (số dòng/cột thực tế Google đang cấp phát) để tìm
// đúng vị trí các dòng append "mất tích" sau khi API báo append thành công.
app.get("/admin/debug-sheet", async (req, res) => {
  if (!CONFIG.ADMIN_SECRET) return res.status(404).send("Not found");
  if (req.query.secret !== CONFIG.ADMIN_SECRET) return res.status(403).send("Forbidden");
  try {
    const sheets = google.sheets({ version: "v4", auth: getGoogleAuth() });
    const meta = await sheets.spreadsheets.get({
      spreadsheetId: CONFIG.PRODUCT_SPREADSHEET_ID,
      fields: "sheets(properties(sheetId,title,gridProperties))",
    });
    const full = await sheets.spreadsheets.values.get({
      spreadsheetId: CONFIG.PRODUCT_SPREADSHEET_ID,
      range: "Trang tính1!A1:L20000",
    });
    const rows = full.data.values || [];
    const nonEmpty = rows
      .map((row, i) => ({ rowNumber: i + 1, row }))
      .filter(r => r.row.some(cell => cell !== undefined && cell !== ""));
    res.json({
      ok: true,
      sheetsMeta: meta.data.sheets,
      totalRowsInResponse: rows.length,
      nonEmptyRowNumbers: nonEmpty.map(r => r.rowNumber),
      lastNonEmptyRows: nonEmpty.slice(-15),
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /admin/delete-rows?secret=...&rows=22,23,24 — xoá hẳn các dòng lỗi (1-indexed,
// đúng số dòng hiển thị trên Google Sheets) khỏi Sheet sản phẩm. Dùng để dọn rác
// do bug ghi sai gây ra, KHÔNG dùng cho việc khác.
app.get("/admin/delete-rows", async (req, res) => {
  if (!CONFIG.ADMIN_SECRET) return res.status(404).send("Not found");
  if (req.query.secret !== CONFIG.ADMIN_SECRET) return res.status(403).send("Forbidden");
  const rowNumbers = String(req.query.rows || "")
    .split(",")
    .map(s => parseInt(s.trim(), 10))
    .filter(n => !isNaN(n) && n > 0)
    .sort((a, b) => b - a); // xoá từ dưới lên để không lệch số dòng khi xoá dần
  if (rowNumbers.length === 0) {
    return res.status(400).json({ ok: false, error: "Thiếu param 'rows' (vd: rows=22,23,24)" });
  }
  try {
    const sheets = google.sheets({ version: "v4", auth: getGoogleAuth() });
    const meta = await sheets.spreadsheets.get({
      spreadsheetId: CONFIG.PRODUCT_SPREADSHEET_ID,
      fields: "sheets(properties(sheetId,title))",
    });
    const sheetId = meta.data.sheets.find(s => s.properties.title === "Trang tính1").properties.sheetId;
    const requests = rowNumbers.map(n => ({
      deleteDimension: {
        range: { sheetId, dimension: "ROWS", startIndex: n - 1, endIndex: n },
      },
    }));
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: CONFIG.PRODUCT_SPREADSHEET_ID,
      requestBody: { requests },
    });
    lastLoadTime = 0;
    res.json({ ok: true, deletedRows: rowNumbers });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /admin/raw-append-test?secret=... — ghi thẳng 1 dòng test với 12 giá trị
// đơn giản (A1..L1) để cô lập xem lỗi lệch cột nằm ở values.append() nói chung
// hay chỉ xảy ra với dữ liệu thực tế (chuỗi dài/tiếng Việt) từ appendProductRow.
app.get("/admin/raw-append-test", async (req, res) => {
  if (!CONFIG.ADMIN_SECRET) return res.status(404).send("Not found");
  if (req.query.secret !== CONFIG.ADMIN_SECRET) return res.status(403).send("Forbidden");
  try {
    const sheets = google.sheets({ version: "v4", auth: getGoogleAuth() });
    const row = ["A1", "B1", "C1", "D1", "E1", "F1", "G1", "H1", "I1", "J1", "K1", "L1"];
    const result = await sheets.spreadsheets.values.append({
      spreadsheetId: CONFIG.PRODUCT_SPREADSHEET_ID,
      range: "Trang tính1!A:L",
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [row] },
    });
    res.json({ ok: true, sentRow: row, apiResponse: result.data });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

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
      let isSticker = false;

      if (event.message?.text) {
        messageText = event.message.text;
      } else if (event.postback?.payload) {
        messageText = event.postback.title || event.postback.payload;
      } else if (event.message?.attachments) {
        const attachment = event.message.attachments[0];
        const type = attachment?.type;
        // Sticker/icon cảm xúc (like 👍, các emoji dán nhanh...) luôn có sticker_id
        // trong payload — khác với ảnh thật khách chụp/gửi lên (không có trường này).
        if (attachment?.payload?.sticker_id) {
          isSticker = true;
          messageText = "[sticker]";
        } else if (type === "image") messageText = "Bạn vừa gửi một hình ảnh.";
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

      // 👍 Khách gửi sticker/icon (like, emoji dán nhanh...) — chỉ cần cảm ơn
      // ngắn gọn, KHÔNG gọi Gemini (đỡ tốn phí + tránh trả lời dài "không xem được ảnh")
      if (isSticker) {
        console.log(`👍 [${senderId}] gửi sticker/icon — trả lời cảm ơn ngắn gọn.`);
        await sendMessage(senderId, "Dạ em cảm ơn bạn nhé! 😊");
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
