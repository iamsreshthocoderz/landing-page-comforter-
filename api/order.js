// api/order.js — Vercel serverless function
// Turkey Comforter এক-ক্লিক অর্ডার: পেজের /api/order থেকে অর্ডার নিয়ে
// Telegram bot দিয়ে মালিকের কাছে পাঠায়।
//
// নিরাপত্তা:
// - TELEGRAM_BOT_TOKEN ও TELEGRAM_CHAT_ID শুধু Vercel-এর Environment
//   Variable থেকে পড়া হয় (process.env)। এই ফাইলে, পেজে, বা চ্যাটে
//   token / chat ID কখনো লেখা হয় না।
// - সিরিয়াল নম্বর: server-ই দেয় — Upstash Redis-এর counter থেকে
//   (survey project-এর মতোই, key "decoratore-order-seq")। প্রথম অর্ডার
//   DW-1001, তারপর DW-1002, DW-1003... সব customer-এর জন্য একই ধারা,
//   কারণ counter server-এ এক জায়গায় থাকে। Upstash-এর env var
//   (UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN, বা পুরনো
//   KV_REST_API_URL / KV_REST_API_TOKEN) না থাকলে time-based নম্বর
//   দিয়ে অর্ডার তবুও Telegram-এ যায় — অর্ডার কখনো আটকায় না।
// - গ্রাহকের নাম/ঠিকানা পরিষ্কার (sanitize) করা হয় — নতুন লাইন বা
//   কন্ট্রোল অক্ষর দিয়ে ভুয়া "সর্বমোট" লাইন ঢোকানো যায় না।
// - ভুল হলে শুধু সাধারণ { ok:false } ফেরত যায় — Telegram-এর আসল
//   error বা token কখনো ফাঁস হয় না।

const PRICE = 2490; // অফার দাম (৳২,৪৯০) — ডেলিভারি ফ্রি (৳০)
const CODES = ["01", "02", "03", "05", "06", "07", "08", "09", "12", "13", "17", "18", "19", "20"];
const CODE_NAMES = {
  "01": "ম্যাজেন্টা কারুকাজ", "02": "আকাশি নীল ফুল", "03": "হলুদ পালক পাতা",
  "05": "টিল-হলুদ কারুকাজ", "06": "গোলাপি বড় ফুল", "07": "নীল-গোলাপি ম্যাপল পাতা",
  "08": "মেরুন জবা ফুল", "09": "কোরাল জবা ফুল", "12": "নেভি-গোল্ড রয়্যাল",
  "13": "গোলাপি হার্ট", "17": "সাদা ছোট ফুল", "18": "নীল-সোনালি পালক পাতা",
  "19": "কালো শরৎ পাতা", "20": "সাদা-নীল ডেইজি"
};

function clean(s, max) {
  return String(s == null ? "" : s)
    .replace(/[\x00-\x1F\x7F]+/g, " ") // নতুন লাইন / কন্ট্রোল অক্ষর বাদ
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function bnNum(n) {
  const d = { "0": "০", "1": "১", "2": "২", "3": "৩", "4": "৪", "5": "৫", "6": "৬", "7": "৭", "8": "৮", "9": "৯" };
  return String(n).replace(/[0-9]/g, (c) => d[c]);
}

function money(n) {
  return "৳" + bnNum(n.toLocaleString("en-US"));
}

// সিরিয়াল counter (Upstash Redis, survey project-এর মতোই):
// key "decoratore-order-seq" — INCR প্রতিবার ১ করে বাড়িয়ে নতুন মান
// ফেরত দেয়, তাই দুইজন একসাথে অর্ডার করলেও নম্বর আলাদা হয়।
// প্রথম অর্ডার: INCR → 1 → DW-1001।
const SEQ_KEY = "decoratore-order-seq";

async function nextSeq() {
  var url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  var token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  try {
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, 5000);
    var resp;
    try {
      resp = await fetch(url.replace(/\/+$/, "") + "/incr/" + SEQ_KEY, {
        headers: { Authorization: "Bearer " + token },
        signal: ctrl.signal
      });
    } finally { clearTimeout(timer); }
    var data = null;
    try { data = await resp.json(); } catch (e) { data = null; }
    if (data && typeof data.result === "number") return data.result;
    return null;
  } catch (e) { return null; }
}

function fallbackNo() {
  var t = Date.now().toString();
  var r = Math.floor(Math.random() * 90 + 10);
  return "DW-" + t.slice(-6) + r;
}

async function nextOrderNo() {
  var n = await nextSeq();
  if (n !== null) return "DW-" + (1000 + n);
  return fallbackNo();
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok: false, error: "method_not_allowed" });
  }

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    // server এখনো সাজানো হয়নি (Vercel-এ env var বসানো বাকি)
    return res.status(500).json({ ok: false, error: "server_not_configured" });
  }

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch (e) { body = null; }
  }
  if (!body || typeof body !== "object") {
    return res.status(400).json({ ok: false, error: "invalid_order" });
  }

  const name = clean(body.name, 60);
  const phone = clean(body.phone, 15);
  const address = clean(body.address, 400);
  const area = body.area === "outside" ? "outside" : "inside";
  const code = String(body.code || "");
  const qty = Number(body.qty);
  const total = Number(body.total);

  // যাচাই: সব ঘর আছে, qty ১–১০, code আসল ১৪টার একটি, total = qty × ৳২,৪৯০
  // (পেজের পাঠানো orderNo আর যাচাই করা হয় না — সিরিয়াল নম্বর server-ই দেয়।)
  const valid =
    name.length >= 3 &&
    /^01\d{9}$/.test(phone) &&
    address.length >= 8 &&
    CODES.indexOf(code) !== -1 &&
    Number.isInteger(qty) && qty >= 1 && qty <= 10 &&
    total === qty * PRICE;
  if (!valid) {
    return res.status(400).json({ ok: false, error: "invalid_order" });
  }

  // সিরিয়াল নম্বর server থেকে: DW-1001, DW-1002, DW-1003...
  const orderNo = await nextOrderNo();

  const text = [
    "🛒 নতুন অর্ডার — Order #" + orderNo,
    "Comfort Code: " + code + " (" + CODE_NAMES[code] + ")",
    "পরিমাণ: " + bnNum(qty) + "টি",
    "সর্বমোট: " + money(total) + " (ডেলিভারি ফ্রি)",
    "নাম: " + name,
    "মোবাইল: " + phone,
    "ঠিকানা: " + address,
    "এলাকা: " + (area === "inside" ? "ঢাকার ভিতরে" : "ঢাকার বাইরে")
  ].join("\n");

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10000);
    let resp;
    try {
      resp = await fetch("https://api.telegram.org/bot" + token + "/sendMessage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: text }),
        signal: ctrl.signal
      });
    } finally {
      clearTimeout(timer);
    }
    let data = null;
    try { data = await resp.json(); } catch (e) { data = null; }
    if (resp.ok && data && data.ok === true) {
      return res.status(200).json({ ok: true, orderNo: orderNo });
    }
    // Telegram পাঠাতে পারেনি — কারণটা গ্রাহকের কাছে ফাঁস করা হয় না
    return res.status(502).json({ ok: false, error: "send_failed" });
  } catch (e) {
    return res.status(502).json({ ok: false, error: "send_failed" });
  }
};
