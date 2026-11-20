// Lambadina sector bot — runs on Vercel, so it answers 24/7 (phone on or off).
// Telegram calls this function for every message / button tap (a "webhook").
// Each person's choices live in Upstash Redis; the collector on your phone reads
// them from there when it sends new jobs.
//
// Vercel environment variables:
//   BOT_TOKEN       the bot token from @BotFather
//   WEBHOOK_SECRET  any long random text (also given to Telegram in setWebhook)
//   OWNER_ID        optional — your Telegram id, enables /stats
//   KV_REST_API_URL / KV_REST_API_TOKEN   added automatically by the Upstash integration

const TOKEN = process.env.BOT_TOKEN || "";
const SECRET = process.env.WEBHOOK_SECRET || "";
const OWNER = String(process.env.OWNER_ID || "");
const KV_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "";
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "";

const SECTORS = [
  ["banking", "🏦 Banking & Finance"],
  ["construction", "🏗️ Construction & Engineering"],
  ["health", "🏥 Healthcare"],
  ["it", "💻 Technology & IT"],
  ["education", "📚 Education"],
  ["ngo", "🌍 NGO / International"],
  ["gov", "🏛️ Government"],
  ["logistics", "🚚 Logistics & Supply Chain"],
  ["fresh", "🌱 Fresh Graduate"],
  ["exec", "👔 Executive & Management"],
  ["other", "🛍️ Other private-sector jobs"],
  ["scholarship", "🎓 Scholarships & Opportunities"],
];
const LABEL = Object.fromEntries(SECTORS);

// ---------- storage ----------
async function kv(cmd) {
  const r = await fetch(KV_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${KV_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(cmd),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error);
  return j.result;
}
async function getRec(id, from) {
  let rec = null;
  try { const raw = await kv(["HGET", "subs", String(id)]); rec = raw ? JSON.parse(raw) : null; } catch (e) { console.error("getRec", e); }
  rec = rec || { sectors: [], all: false, paused: false, blocked: false, joined: new Date().toISOString(), saved: [] };
  if (from && from.first_name) rec.name = String(from.first_name).slice(0, 40);
  rec.blocked = false;
  return rec;
}
const saveRec = (id, rec) => kv(["HSET", "subs", String(id), JSON.stringify(rec)]);

// ---------- telegram ----------
async function tg(method, body) {
  const r = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  return r.json();
}
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const send = (chat_id, text, extra = {}) =>
  tg("sendMessage", { chat_id, text, parse_mode: "HTML", disable_web_page_preview: true, ...extra });

// ---------- menu ----------
function selectedLabels(rec) {
  if (rec.all) return "All sectors";
  const l = SECTORS.filter(([k]) => (rec.sectors || []).includes(k)).map(([, t]) => t);
  return l.length ? l.join("\n") : "none yet";
}
function menuText(rec) {
  const state = rec.paused ? "  (updates paused)" : "";
  return "🎯 <b>Choose your job sectors</b>\nየሚፈልጉትን የሥራ ዘርፎች ይምረጡ\n\n" +
    "Tap to select or unselect. New matching jobs will be sent to you here, privately.\n\n" +
    `<b>Your choice${state}:</b>\n${esc(selectedLabels(rec))}`;
}
function menuMarkup(rec) {
  const sel = new Set(rec.sectors || []);
  const rows = SECTORS.map(([k, t]) => [{ text: (sel.has(k) ? "✅ " : "☐ ") + t, callback_data: "s:" + k }]);
  rows.push([{ text: (rec.all ? "✅ " : "☐ ") + "All sectors", callback_data: "all" }]);
  rows.push([
    { text: rec.paused ? "🔕 Resume updates" : "🔔 Pause updates", callback_data: "pause" },
    { text: "💾 Done", callback_data: "done" },
  ]);
  return { inline_keyboard: rows };
}
function toggleSector(rec, key) {
  if (!LABEL[key]) return;
  if (rec.all) { rec.all = false; rec.sectors = [key]; return; }
  const sel = [...(rec.sectors || [])];
  const i = sel.indexOf(key);
  if (i >= 0) sel.splice(i, 1); else sel.push(key);
  rec.sectors = sel;
}

// ---------- bookmarks ----------
async function saveBookmark(chat, rec, shortId) {
  let info = null;
  try { const raw = await kv(["HGET", "bm", shortId]); info = raw ? JSON.parse(raw) : null; } catch (e) { console.error(e); }
  if (!info) return send(chat, "😕 I couldn't find that job any more. Open the channel and tap 🔖 on a newer post.");
  rec.saved = rec.saved || [];
  if (rec.saved.some((x) => x.id === shortId))
    return send(chat, `🔖 Already saved:\n<b>${esc(info.title)}</b>\n${esc(info.post)}\n\nSee them all: /saved`);
  rec.saved.unshift({ id: shortId, ...info });
  rec.saved = rec.saved.slice(0, 50);
  return send(chat, `🔖 <b>Saved!</b>\n<b>${esc(info.title)}</b>\n` +
    (info.deadline ? `📅 Deadline: ${esc(info.deadline)}\n` : "") + `${esc(info.post)}\n\nSee all your bookmarks: /saved`);
}
function showBookmarks(chat, rec) {
  const saved = rec.saved || [];
  if (!saved.length) return send(chat, "🔖 You have no bookmarks yet. Tap 🔖 Bookmark under any job in the channel.");
  const lines = ["🔖 <b>Your bookmarks</b>\n"];
  saved.slice(0, 20).forEach((x, i) =>
    lines.push(`${i + 1}. ${esc(x.title)}${x.deadline ? " — 📅 " + esc(x.deadline) : ""}\n${esc(x.post)}`));
  lines.push("\nClear them with /clearsaved");
  return send(chat, lines.join("\n\n"));
}

// ---------- handlers ----------
async function onMessage(m) {
  if (!m.from || m.from.is_bot || !m.chat || m.chat.type !== "private") return;
  const text = (m.text || "").trim();
  const parts = text.split(/\s+/);
  const cmd = text.startsWith("/") ? parts[0].split("@")[0].toLowerCase() : "";
  const payload = cmd === "/start" ? (parts[1] || "") : "";
  const chat = m.chat.id;
  const rec = await getRec(m.from.id, m.from);

  if (payload.startsWith("b_")) {
    await saveBookmark(chat, rec, payload.slice(2));
  } else if (cmd === "/saved") {
    await showBookmarks(chat, rec); return;
  } else if (cmd === "/clearsaved") {
    rec.saved = []; await send(chat, "🗑️ Your bookmarks are cleared.");
  } else if (["/start", "/sectors", "/menu", "/choose"].includes(cmd)) {
    if (cmd === "/start") rec.paused = false;
    await send(chat, menuText(rec), { reply_markup: menuMarkup(rec) });
  } else if (cmd === "/mysectors") {
    await send(chat, `<b>Your choice:</b>\n${esc(selectedLabels(rec))}\n\nChange it with /sectors.`);
  } else if (cmd === "/stop") {
    rec.paused = true; await send(chat, "🔕 Paused. You won't get new jobs until you send /resume.");
  } else if (cmd === "/resume") {
    rec.paused = false; await send(chat, "🔔 Updates are back on. Change your sectors any time with /sectors.");
  } else if (cmd === "/stats" && OWNER && String(m.from.id) === OWNER) {
    const all = await kv(["HGETALL", "subs"]); const recs = [];
    for (let i = 1; i < (all || []).length; i += 2) { try { recs.push(JSON.parse(all[i])); } catch (e) {} }
    const active = recs.filter((r) => !r.blocked && !r.paused);
    const lines = [`👥 ${recs.length} people, ${active.length} active`];
    for (const [k, t] of SECTORS) lines.push(`${t}: ${active.filter((r) => r.all || (r.sectors || []).includes(k)).length}`);
    await send(chat, esc(lines.join("\n")));
  } else if (cmd === "/help") {
    await send(chat, "/sectors – choose your job sectors\n/mysectors – see your choice\n/saved – your bookmarked jobs\n/stop – pause updates\n/resume – turn updates back on");
  } else {
    await send(chat, "Use /sectors to choose which jobs you want to receive.");
  }
  await saveRec(m.from.id, rec);
}

async function onCallback(q) {
  const data = q.data || "";
  const chat = q.message && q.message.chat.id;
  const mid = q.message && q.message.message_id;
  const rec = await getRec(q.from.id, q.from);
  const ans = (text, alert) => tg("answerCallbackQuery", { callback_query_id: q.id, ...(text ? { text, show_alert: !!alert } : {}) });

  if (data.startsWith("s:")) toggleSector(rec, data.slice(2));
  else if (data === "all") { rec.all = !rec.all; if (rec.all) rec.sectors = []; }
  else if (data === "pause") rec.paused = !rec.paused;
  else if (data === "done") {
    await saveRec(q.from.id, rec);
    if (!rec.all && !(rec.sectors || []).length) return ans("Pick at least one sector first.", true);
    await tg("editMessageText", { chat_id: chat, message_id: mid, parse_mode: "HTML",
      text: `✅ <b>Saved!</b>\n\nYou'll receive new jobs for:\n${esc(selectedLabels(rec))}\n\n⚙️ Change any time: /sectors\n🔕 Pause: /stop` });
    return ans("Saved ✅");
  }
  await saveRec(q.from.id, rec);
  await tg("editMessageText", { chat_id: chat, message_id: mid, text: menuText(rec), parse_mode: "HTML", reply_markup: menuMarkup(rec) });
  return ans();
}

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(200).send("Lambadina bot is running ✅");
  if (SECRET && req.headers["x-telegram-bot-api-secret-token"] !== SECRET) return res.status(401).send("no");
  try {
    const u = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
    if (u.message) await onMessage(u.message);
    else if (u.callback_query) await onCallback(u.callback_query);
  } catch (e) { console.error("bot error", e); }
  return res.status(200).send("ok");
};
module.exports._test = { toggleSector, menuMarkup, menuText };
