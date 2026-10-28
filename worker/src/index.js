/**
 * PFE Hard-Label NLP — Telegram bot (Cloudflare Worker)
 *
 * - Webhook  : commands, persistent menu keyboard and inline buttons. Every
 *              command and button answers, even when data is missing.
 * - Cron     : one tick every 30 minutes; the bot writes first following
 *              SCHEDULE (plan of the day, English breaks, triage, AI-security
 *              news, evening review). A late tick still delivers a slot.
 * - Alerts   : critical or exploited flaws touching AI software are pushed as
 *              soon as the pipeline reports them (held during quiet hours).
 * - Pipeline : GitHub Actions pulls the decisions queued here (/api/events),
 *              acknowledges them once saved, and posts its run summary.
 * - Reader   : the PDF reader (site/reader.html, also a Telegram mini app)
 *              fetches PDFs through /reader/pdf and gets each page in French
 *              from /reader/translate. Pages are cached in KV: the pipeline
 *              translates papers ahead of time (/api/translations) and, when
 *              the worker has its own GEMINI_API_KEY, any page is translated
 *              on demand; otherwise the paper is queued for the next run.
 *              Library PDFs work for everyone; any other URL needs the paired
 *              account (Telegram initData or a signed token from /lecteur).
 *
 * Data comes from the static site (data/bot.json, data/learning.json).
 * Decisions are queued in KV and applied by the Python pipeline through the
 * audited PRISMA functions — the bot never edits the research database itself.
 *
 * Secrets: TELEGRAM_BOT_TOKEN, TELEGRAM_PAIRING_CODE, optional PIPELINE_SECRET
 *          (defaults to the pairing code, already shared with GitHub),
 *          optional TELEGRAM_WEBHOOK_SECRET (overrides the BOT_WEBHOOK_SECRET var)
 *          and GEMINI_API_KEY (free key, needed by the reader's translation).
 * Vars: SITE_URL. KV binding: PFE_STATE.
 */

import { geminiTranslate, translationHash, translationKey } from "./translate.js";

const VERSION = "3.1.0";
const DEFAULT_SITE = "https://pfe-hla.pages.dev";
const BOT_HANDLE = "PFE_MN_bot";
const DECIDED_TTL = 4 * 24 * 3600; // hide a decided paper until the pipeline syncs it
const VOCAB_TTL = 20 * 3600;
const SHOWN_TTL = 8 * 3600; // successive English breaks show different words
const NEWS_TTL = 10 * 24 * 3600;
const ALERT_TTL = 10 * 24 * 3600;
const CACHE_SECONDS = 120;

// Africa/Algiers is UTC+1 all year (no daylight saving time).
const LOCAL_OFFSET_MINUTES = 60;
const SCHEDULE = [
  { slot: "morning", at: 8 * 60, setting: "morning", label: "Matin 08:00 (plan du jour + leçon)" },
  { slot: "english1", at: 10 * 60, setting: "english", label: "Anglais 10:00 et 15:30 (2 mots)" },
  { slot: "midday", at: 13 * 60, setting: "midday", label: "Midi 13:00 (session de tri)" },
  { slot: "english2", at: 15 * 60 + 30, setting: "english", label: "" },
  { slot: "news", at: 18 * 60, setting: "news", label: "Actus sécurité IA 18:00" },
  { slot: "evening", at: 20 * 60, setting: "evening", label: "Soir 20:00 (quiz + mots)" },
];
const CATCH_UP_MINUTES = 150; // a delayed tick still sends the slot, never hours later
const QUIET_FROM = 23 * 60; // alerts wait for 07:00
const QUIET_TO = 7 * 60;

const READER_TOKEN_DAYS = 120;
const READER_MAX_BLOCKS = 160;
const READER_MAX_CHARS = 24000;
const READER_WANTED_MAX = 30;
// Anonymous visitors (public site) share the free quota: per-instance limits.
const READER_ANON_PER_HOUR = 90;
const READER_ANON_GLOBAL_PER_HOUR = 400;
// Open-access hosts a visitor may read without the pairing (plus every PDF of the library).
const READER_PUBLIC_HOSTS = new Set([
  "arxiv.org",
  "export.arxiv.org",
  "aclanthology.org",
  "openreview.net",
  "proceedings.neurips.cc",
  "papers.nips.cc",
  "proceedings.mlr.press",
  "ojs.aaai.org",
  "www.ijcai.org",
  "ijcai.org",
  "openaccess.thecvf.com",
  "www.usenix.org",
  "www.ndss-symposium.org",
  "www.mdpi.com",
]);
const READER_ORIGINS = [
  /^https:\/\/([a-z0-9-]+\.)?pfe-hla\.pages\.dev$/,
  /^https:\/\/mvsss97\.github\.io$/,
  /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/,
];

const EXCLUSION_LABELS = {
  E1: "Pas du texte (image, son…)",
  E2: "Hors attaques/robustesse NLP",
  E3: "Avant 2018",
  E4: "Pas en anglais",
  E5: "Pas une étude scientifique",
  E6: "Hors sujet après lecture",
  E7: "Texte intégral introuvable",
  E8: "Doublon",
};
const CODES_BY_STAGE = {
  s: ["E1", "E2", "E3", "E4", "E5", "E8"], // title/abstract and veille
  f: ["E1", "E2", "E5", "E6", "E7", "E8"], // full text
  d: ["E1", "E2", "E5", "E6", "E8"], // final decision
};
const STAGE_LABELS = {
  ta: "Tri titre/résumé · PRISMA formel",
  veille: "Veille · avant la recherche formelle",
  ft: "Éligibilité sur texte intégral",
  final: "Décision finale d'inclusion",
};

const MENU_KEYBOARD = {
  keyboard: [
    [{ text: "📥 Trier" }, { text: "📄 Fiches" }],
    [{ text: "🧠 Apprendre" }, { text: "🇬🇧 Anglais" }],
    [{ text: "📰 Actus sécu" }, { text: "🎓 Encadrant" }],
    [{ text: "📖 Lecteur PDF" }, { text: "📊 PRISMA" }],
    [{ text: "✍️ Rédaction" }, { text: "📱 App" }],
    [{ text: "🗓 Plan du jour" }, { text: "☰ Menu" }],
  ],
  resize_keyboard: true,
  is_persistent: true,
};
const TEXT_ALIASES = {
  "📥 trier": "/tri",
  "📄 fiches": "/fiches",
  "🧠 apprendre": "/apprendre",
  "🇬🇧 anglais": "/anglais",
  "📰 actus sécu": "/actus",
  "🎓 encadrant": "/encadrant",
  "📖 lecteur pdf": "/lecteur",
  "📱 app": "/app",
  "📊 prisma": "/prisma",
  "✍️ rédaction": "/redaction",
  "🗓 plan du jour": "/plan",
  "☰ menu": "/menu",
};
const BOT_COMMANDS = [
  ["menu", "Menu principal"],
  ["aujourdhui", "Ma journée PFE (plan + tâches)"],
  ["tri", "Trier les articles (PRISMA) avec l'IA"],
  ["fiches", "Fiches de lecture écrites par les agents"],
  ["encadrant", "Articles conseillés par l'encadrant"],
  ["these", "Plan de lecture de la thèse de l'encadrant"],
  ["actus", "Actus sécurité IA : failles, dépôts, incidents"],
  ["lecteur", "Lire un PDF traduit en français (même mise en page)"],
  ["app", "Ouvrir le tableau de bord dans Telegram"],
  ["prisma", "Compteurs PRISMA"],
  ["anglais", "Mots d'anglais à réviser"],
  ["apprendre", "Leçon du jour (maths → NLP → attaques)"],
  ["quiz", "Quiz de la leçon"],
  ["redaction", "Étapes de la rédaction du mémoire"],
  ["plan", "Plan de la semaine"],
  ["agents", "État des agents IA"],
  ["chercher", "Chercher un article : /chercher mot"],
  ["site", "Ouvrir le tableau de bord"],
  ["reglages", "Notifications automatiques"],
  ["aide", "Aide"],
];
const COMMAND_ALIASES = {
  "/start": "/start",
  "/menu": "/menu",
  "/help": "/aide",
  "/aide": "/aide",
  "/today": "/aujourdhui",
  "/aujourdhui": "/aujourdhui",
  "/papers": "/tri",
  "/tri": "/tri",
  "/more": "/tri",
  "/fiches": "/fiches",
  "/stats": "/prisma",
  "/prisma": "/prisma",
  "/words": "/anglais",
  "/anglais": "/anglais",
  "/learn": "/apprendre",
  "/apprendre": "/apprendre",
  "/quiz": "/quiz",
  "/redaction": "/redaction",
  "/plan": "/plan",
  "/agents": "/agents",
  "/search": "/chercher",
  "/chercher": "/chercher",
  "/site": "/site",
  "/reglages": "/reglages",
  "/settings": "/reglages",
  "/actus": "/actus",
  "/news": "/actus",
  "/securite": "/actus",
  "/encadrant": "/encadrant",
  "/supervisor": "/encadrant",
  "/these": "/these",
  "/thesis": "/these",
  "/questions": "/questions",
  "/lecteur": "/lecteur",
  "/reader": "/lecteur",
  "/lire": "/lecteur",
  "/app": "/app",
};

const KIND_LABELS = {
  vulnerability: "🔓 Faille",
  repo: "🧪 Dépôt",
  incident: "⚠️ Incident IA",
  article: "📰 Article",
  paper: "📄 Recherche",
};
const KIND_FILTERS = [
  ["all", "Tout"],
  ["vulnerability", "🔓 Failles"],
  ["repo", "🧪 Dépôts"],
  ["incident", "⚠️ Incidents"],
  ["article", "📰 Presse"],
  ["paper", "📄 Recherche"],
];
const SOURCE_LABELS = {
  github: "GitHub",
  gitlab: "GitLab",
  ghsa: "GitHub Advisory",
  nvd: "NVD (NIST)",
  kev: "CISA KEV · exploitée",
  thehackernews: "The Hacker News",
  bleepingcomputer: "BleepingComputer",
  securityweek: "SecurityWeek",
  aiid: "AI Incident Database",
  arxiv: "arXiv cs.CR",
};
const SEVERITY_RANK = { alert: 0, notable: 1, info: 2 };
const READING_ICONS = { sheet: "✅", queued: "⏳", no_pdf: "📕", error: "⚠️", not_queued: "▫️" };

// ─── Small utilities ────────────────────────────────────────────────────────

function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function safeUrl(value) {
  const url = String(value ?? "").trim();
  return /^https?:\/\/[^\s"<>]+$/i.test(url) ? url : "";
}

function link(url, text) {
  const safe = safeUrl(url);
  return safe ? `<a href="${esc(safe)}">${esc(text)}</a>` : esc(text);
}

// Messages are built from whole lines: never cut inside an HTML tag.
function fitLines(lines, max = 3900) {
  const kept = [];
  let size = 0;
  for (const line of lines) {
    if (size + line.length + 1 > max) break;
    kept.push(line);
    size += line.length + 1;
  }
  return kept.join("\n");
}

function cut(value, max) {
  const text = String(value ?? "").trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

function hashTerm(term) {
  // FNV-1a 32 bits: stable short id for callback data.
  let hash = 0x811c9dc5;
  for (const char of String(term).toLowerCase()) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function safeEqual(left, right) {
  const a = String(left ?? "");
  const b = String(right ?? "");
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0 && a.length > 0;
}

function siteUrl(env) {
  return String(env.SITE_URL || DEFAULT_SITE).replace(/\/+$/, "");
}

function readerUrl(env, key = "") {
  return `${siteUrl(env)}/reader.html${key ? `?k=${encodeURIComponent(key)}` : ""}`;
}

// Opens inside Telegram (mini app): no download, no other app.
function readerButton(env, key, label = "📖 Lire le PDF (FR / EN)") {
  return { text: label, web_app: { url: readerUrl(env, key) } };
}

function pipelineSecret(env) {
  return env.PIPELINE_SECRET || env.TELEGRAM_PAIRING_CODE || "";
}

function webhookSecret(env) {
  return env.TELEGRAM_WEBHOOK_SECRET || env.BOT_WEBHOOK_SECRET || "";
}

function algiersNow(nowMs = Date.now()) {
  return new Date(nowMs + LOCAL_OFFSET_MINUTES * 60 * 1000);
}

function todayKey(nowMs = Date.now()) {
  return algiersNow(nowMs).toISOString().slice(0, 10);
}

function localMinutes(nowMs = Date.now()) {
  const local = algiersNow(nowMs);
  return local.getUTCHours() * 60 + local.getUTCMinutes();
}

function isQuiet(minutes) {
  return minutes >= QUIET_FROM || minutes < QUIET_TO;
}

function hhmm(minutes) {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ─── Telegram API ───────────────────────────────────────────────────────────

async function tg(env, method, body = {}) {
  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!data.ok) throw new Error(`Telegram ${method}: ${data.description}`);
  return data.result;
}

function send(env, chatId, text, extra = {}) {
  return tg(env, "sendMessage", {
    chat_id: chatId,
    text: cut(text, 4096),
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
    ...extra,
  });
}

async function edit(env, chatId, messageId, text, extra = {}) {
  try {
    return await tg(env, "editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text: cut(text, 4096),
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      ...extra,
    });
  } catch (error) {
    if (!String(error.message).includes("not modified")) throw error;
    return null;
  }
}

async function editButtons(env, chatId, messageId, replyMarkup) {
  try {
    await tg(env, "editMessageReplyMarkup", {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: replyMarkup,
    });
  } catch (error) {
    if (!String(error.message).includes("not modified")) throw error;
  }
}

function answer(env, callbackId, text = "", showAlert = false) {
  return tg(env, "answerCallbackQuery", {
    callback_query_id: callbackId,
    text: cut(text, 200),
    show_alert: showAlert,
  }).catch(() => null);
}

// ─── KV state ───────────────────────────────────────────────────────────────

async function kvGet(env, key, fallback = null) {
  if (!env.PFE_STATE) return fallback;
  const value = await env.PFE_STATE.get(key, "json");
  return value ?? fallback;
}

async function kvPut(env, key, value, ttl) {
  if (!env.PFE_STATE) return;
  const options = ttl ? { expirationTtl: Math.max(60, ttl) } : undefined;
  await env.PFE_STATE.put(key, JSON.stringify(value), options);
}

async function getChat(env) {
  if (!env.PFE_STATE) return null;
  const value = await env.PFE_STATE.get("authorized_chat_id");
  return value ? Number.parseInt(value, 10) : null;
}

const DEFAULT_SETTINGS = {
  morning: true,
  english: true,
  midday: true,
  news: true,
  evening: true,
  alerts: true,
  agents: true,
  pausedUntil: null,
};

async function getSettings(env) {
  return { ...DEFAULT_SETTINGS, ...(await kvGet(env, "settings", {})) };
}

function isPaused(settings, nowMs = Date.now()) {
  return Boolean(settings.pausedUntil && settings.pausedUntil > new Date(nowMs).toISOString());
}

async function queueEvent(env, event) {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await kvPut(env, `evt:${id}`, { id, ...event, at: new Date().toISOString() });
  return id;
}

async function listKeys(env, prefix) {
  if (!env.PFE_STATE) return [];
  const names = [];
  let cursor;
  do {
    const page = await env.PFE_STATE.list({ prefix, cursor });
    names.push(...page.keys.map((key) => key.name));
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return names;
}

// Recently decided papers / reviewed words live in ONE key each: KV list() is
// eventually consistent, a plain get() after a put() in the same place is not.
async function recentMap(env, name) {
  const now = Date.now();
  const map = await kvGet(env, name, {});
  return Object.fromEntries(Object.entries(map).filter(([, expires]) => expires > now));
}

async function remember(env, name, id, ttlSeconds) {
  const map = await recentMap(env, name);
  map[id] = Date.now() + ttlSeconds * 1000;
  await kvPut(env, name, map);
}

async function decidedKeys(env) {
  return new Set(Object.keys(await recentMap(env, "recent:decided")));
}

// ─── Site data (cached) ─────────────────────────────────────────────────────

const memoryCache = new Map();

async function loadData(env, file) {
  const url = `${siteUrl(env)}/data/${file}`;
  const cached = memoryCache.get(url);
  if (cached && Date.now() - cached.at < CACHE_SECONDS * 1000) return cached.data;
  try {
    const response = await fetch(url, { headers: { "User-Agent": `PFE-HLA-Bot/${VERSION}` } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    memoryCache.set(url, { at: Date.now(), data });
    return data;
  } catch (_error) {
    return cached?.data ?? null;
  }
}

async function botData(env) {
  const data = await loadData(env, "bot.json");
  if (data) return data;
  // First deployment, before the pipeline produced bot.json: degrade gracefully.
  const state = await loadData(env, "state.json");
  if (!state) return null;
  return {
    site: siteUrl(env),
    prisma: state.prisma || {},
    protocol: state.protocol || null,
    agents: {},
    news24h: {},
    library: { total: (state.papers || []).length, pending: 0 },
    queue: (state.papers || [])
      .filter((paper) => paper.status === "identified")
      .slice(0, 40)
      .map((paper) => ({
        key: paper.key || String(paper.id),
        title: paper.title,
        year: paper.year,
        venue: paper.venue,
        abstract: cut(paper.abstract, 600),
        url: paper.url,
        stage: paper.inFormalReview ? "ta" : "veille",
        ai: null,
      })),
    sheets: [],
    vocabulary: (state.vocabulary || []).map((word) => ({
      term: word.term,
      fr: word.translation,
      def: word.definition,
      ex: word.example,
      syn: word.synonyms || [],
      due: word.dueAt,
      reps: word.repetitions,
    })),
  };
}

const unavailable = "⚠️ Les données du tableau de bord sont momentanément indisponibles. Réessaie dans quelques minutes.";

// ─── Learning helpers ───────────────────────────────────────────────────────

function flattenLessons(learning) {
  const lessons = [];
  for (const module of learning?.modules || []) {
    for (const lesson of module.lessons || []) lessons.push({ ...lesson, module });
  }
  return lessons;
}

async function learnState(env) {
  return { current: 0, done: [], ...(await kvGet(env, "learn:state", {})) };
}

function currentWeek(learning) {
  const start = new Date(`${learning?.startDate || "2026-10-06"}T00:00:00Z`);
  const days = Math.floor((algiersNow() - start) / 86400000);
  return Math.min(Math.max(Math.floor(days / 7) + 1, 1), 16);
}

function roadmapEntry(learning, week) {
  return (learning?.roadmap || []).find((item) => week >= item.from && week <= item.to) || null;
}

// ─── Message builders ───────────────────────────────────────────────────────

function aiLine(ai) {
  if (!ai) return "🤖 IA : pas encore analysé par les agents.";
  const verdict = {
    include: "✅ garder",
    exclude: `❌ exclure (${ai.code || "?"} · ${EXCLUSION_LABELS[ai.code] || "motif"})`,
    uncertain: "🤔 incertain",
  }[ai.decision] || ai.decision;
  const confidence = Math.round((ai.confidence || 0) * 100);
  return `🤖 IA : <b>${verdict}</b> · pertinence ${ai.relevance ?? "?"}/5 · confiance ${confidence}%\n<i>${esc(cut(ai.rationale, 280))}</i>`;
}

// English first, French just below (the student reads both).
function paperText(item, data, position) {
  const lines = [`📄 <b>${esc(item.title)}</b>`];
  if (item.titleFr) lines.push(`🇫🇷 <i>${esc(item.titleFr)}</i>`);
  lines.push(
    `${esc(item.year || "année ?")} · ${esc(cut(item.venue || "source ?", 80))}`,
    `🏷 ${STAGE_LABELS[item.stage] || "À trier"}${position ? ` · ${position}` : ""}`,
    "",
    item.abstract ? `🇬🇧 <i>${esc(cut(item.abstract, 650))}</i>` : "<i>(résumé absent)</i>",
  );
  if (item.abstractFr) lines.push("", `🇫🇷 <b>Résumé :</b> ${esc(cut(item.abstractFr, 700))}`);
  else if (item.abstract) lines.push("", "🇫🇷 <i>Traduction du résumé au prochain passage des agents.</i>");
  lines.push("", aiLine(item.ai));
  if (safeUrl(item.url)) lines.push(`🔗 ${link(item.url, "Source")}`);
  if (item.hasSheet) lines.push(`📘 <a href="${esc(data.site || "")}/#fiches/${esc(item.key)}">Fiche de lecture IA</a>`);
  return lines.join("\n");
}

function paperButtons(item, data, env = null) {
  const key = item.key;
  const sheetUrl = `${data.site || DEFAULT_SITE}/#fiches/${key}`;
  const reader = env && item.pdf ? [[readerButton(env, key)]] : [];
  if (item.stage === "ft") {
    return {
      inline_keyboard: [
        [
          { text: "✅ Éligible", callback_data: `f:i:${key}` },
          { text: "❌ Exclure…", callback_data: `f:x:${key}` },
        ],
        [{ text: "📘 Lire la fiche", url: sheetUrl }, { text: "➡️ Suivant", callback_data: `s:n:${key}` }],
        ...reader,
      ],
    };
  }
  if (item.stage === "final") {
    return {
      inline_keyboard: [
        [
          { text: "⭐ Inclure", callback_data: `d:k:${key}` },
          { text: "❌ Rejeter…", callback_data: `d:x:${key}` },
        ],
        [{ text: "📘 Lire la fiche", url: sheetUrl }, { text: "➡️ Suivant", callback_data: `s:n:${key}` }],
        ...reader,
      ],
    };
  }
  const rows = [
    [
      { text: "✅ Garder", callback_data: `s:i:${key}` },
      { text: "❌ Exclure…", callback_data: `s:x:${key}` },
    ],
    [
      { text: "🤔 Incertain", callback_data: `s:u:${key}` },
      { text: "⏭ Plus tard", callback_data: `s:l:${key}` },
    ],
  ];
  const extra = [];
  if (item.ai) extra.push({ text: "🤖 Comme l'IA", callback_data: `s:a:${key}` });
  extra.push({ text: "🤖 Fiche en priorité", callback_data: `r:${key}` });
  rows.push(extra, ...reader);
  return { inline_keyboard: rows };
}

function codeButtons(prefix, key) {
  const codes = CODES_BY_STAGE[prefix] || CODES_BY_STAGE.s;
  const rows = [];
  for (let i = 0; i < codes.length; i += 2) {
    rows.push(
      codes.slice(i, i + 2).map((code) => ({
        text: `${code} · ${EXCLUSION_LABELS[code]}`,
        callback_data: `${prefix}:x:${key}:${code}`,
      })),
    );
  }
  rows.push([{ text: "↩️ Retour", callback_data: `c:${prefix}:${key}` }]);
  return { inline_keyboard: rows };
}

async function nextPaper(env, data, skipKey = null) {
  const decided = await decidedKeys(env);
  const queue = (data?.queue || []).filter((item) => !decided.has(item.key) && item.key !== skipKey);
  return { item: queue[0] || null, remaining: queue.length };
}

async function sendNextPaper(env, chatId, { skipKey = null, intro = "" } = {}) {
  const data = await botData(env);
  if (!data) return send(env, chatId, unavailable);
  const { item, remaining } = await nextPaper(env, data, skipKey);
  if (!item) {
    return send(
      env,
      chatId,
      `${intro}🎉 <b>Rien à trier pour l'instant.</b>\nLes agents cherchent de nouveaux articles deux fois par jour ; je te préviens dès qu'il y en a.`,
      { reply_markup: { inline_keyboard: [[{ text: "📄 Voir les fiches", callback_data: "m:fiches" }]] } },
    );
  }
  const text = `${intro}${paperText(item, data, `${remaining} en attente`)}`;
  return send(env, chatId, text, { reply_markup: paperButtons(item, data, env) });
}

function findItem(data, key) {
  return (data?.queue || []).find((item) => item.key === key) || null;
}

// ─── Commands ───────────────────────────────────────────────────────────────

async function cmdHelp(env, chatId) {
  const lines = BOT_COMMANDS.map(([command, description]) => `/${command} — ${esc(description)}`);
  await send(
    env,
    chatId,
    "📚 <b>Ton assistant PFE</b>\n\n" +
      "Je t'écris moi-même chaque jour :\n" +
      "☀️ 08:00 plan du jour · 🇬🇧 10:00 et 15:30 pause anglais · 📥 13:00 tri\n" +
      "📰 18:00 actus sécurité IA · 🌙 20:00 bilan (quiz + mots)\n" +
      "🚨 et tout de suite en cas de faille grave liée à l'IA (sauf la nuit, 23:00–07:00).\n" +
      "📖 Le lecteur PDF traduit les articles en français en gardant la mise en page : /lecteur\n" +
      "Tout se règle dans /reglages.\n\n" +
      "Tu peux aussi utiliser les boutons du clavier ou ces commandes :\n\n" +
      lines.join("\n"),
    { reply_markup: MENU_KEYBOARD },
  );
}

async function cmdMenu(env, chatId) {
  const site = siteUrl(env);
  await send(env, chatId, "☰ <b>Menu principal</b>\nQue veux-tu faire ?", {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "📥 Trier des articles", callback_data: "m:tri" },
          { text: "📄 Fiches de lecture", callback_data: "m:fiches" },
        ],
        [
          { text: "🧠 Leçon du jour", callback_data: "m:apprendre" },
          { text: "🇬🇧 Mots d'anglais", callback_data: "m:anglais" },
        ],
        [
          { text: "🎓 Encadrant", callback_data: "m:encadrant" },
          { text: "📘 Thèse", callback_data: "m:these" },
        ],
        [
          { text: "📰 Actus sécurité IA", callback_data: "m:actus" },
          { text: "📊 PRISMA", callback_data: "m:prisma" },
        ],
        [
          { text: "📖 Lecteur PDF (FR)", callback_data: "m:lecteur" },
          { text: "✍️ Rédaction", callback_data: "m:redaction" },
        ],
        [{ text: "📱 Ouvrir l'app dans Telegram", web_app: { url: `${site}/` } }],
        [
          { text: "🗓 Plan du jour", callback_data: "m:plan" },
          { text: "🤖 Agents IA", callback_data: "m:agents" },
        ],
        [
          { text: "⚙️ Réglages", callback_data: "m:reglages" },
          { text: "🌐 Site", url: site },
        ],
      ],
    },
  });
}

async function cmdPrisma(env, chatId) {
  const data = await botData(env);
  if (!data) return send(env, chatId, unavailable);
  const p = data.prisma || {};
  const protocol = data.protocol
    ? `Protocole <b>${esc(data.protocol.version)}</b> · ${data.protocol.status === "validated" ? "✅ validé" : "⏳ provisoire (à valider avec l'encadrant)"}`
    : "⏳ Protocole pas encore figé : la recherche formelle n'a pas commencé.";
  const text = [
    "📊 <b>PRISMA 2020</b>",
    protocol,
    "",
    `📥 Identifiés : <b>${p.identified ?? 0}</b>`,
    `🔄 Doublons retirés : ${p.duplicates_removed ?? 0}`,
    `🧾 Références uniques : ${p.unique_records ?? 0}`,
    `🔍 Triés (titre/résumé) : ${p.screened ?? 0} · exclus : ${p.excluded_title_abstract ?? 0}`,
    `📄 Textes intégraux recherchés : ${p.reports_sought ?? 0} · non récupérés : ${p.reports_not_retrieved ?? 0}`,
    `📖 Évalués : ${p.reports_assessed ?? 0} · exclus : ${p.excluded_full_text ?? 0}`,
    `✅ <b>Inclus : ${p.included ?? 0}</b>`,
    "",
    `⏳ À trier : <b>${p.pending_screening ?? 0}</b> · décisions finales en attente : ${p.pending_decision ?? 0}`,
    `📚 Bibliothèque totale (veille comprise) : ${data.library?.total ?? "?"}`,
  ].join("\n");
  await send(env, chatId, text, {
    reply_markup: {
      inline_keyboard: [
        [{ text: "📥 Trier maintenant", callback_data: "m:tri" }],
        [{ text: "🌐 Diagramme PRISMA", url: `${siteUrl(env)}/#prisma` }],
      ],
    },
  });
}

async function cmdFiches(env, chatId) {
  const data = await botData(env);
  if (!data) return send(env, chatId, unavailable);
  const sheets = data.sheets || [];
  if (!sheets.length) {
    const waiting = data.agents?.readingQueue ? ` (${data.agents.readingQueue} article(s) en file de lecture)` : "";
    return send(
      env,
      chatId,
      `📄 <b>Pas encore de fiche de lecture</b>${waiting}.\n\nGarde un article avec ✅ ou touche « 📖 Lire en priorité » : l'agent lecteur télécharge le PDF, le lit en entier et écrit la fiche au prochain passage.`,
      { reply_markup: { inline_keyboard: [[{ text: "📥 Trier des articles", callback_data: "m:tri" }]] } },
    );
  }
  const lines = sheets.slice(0, 8).map((sheet) => {
    const checks = sheet.checks || {};
    const verified = `✓${checks.exact_quote ?? 0} ≈${checks.value_only ?? 0} ✗${checks.not_found ?? 0}`;
    return `• <a href="${esc(data.site)}/#fiches/${esc(sheet.key)}">${esc(cut(sheet.title, 90))}</a> (${esc(sheet.year || "?")})\n  pertinence ${sheet.relevance ?? "?"}/5 · citations ${verified}\n  <i>${esc(cut(sheet.summary, 220))}</i>`;
  });
  await send(
    env,
    chatId,
    `📄 <b>Fiches de lecture (${sheets.length})</b>\n✓ = phrase retrouvée mot pour mot dans le PDF, ≈ = valeur seule, ✗ = introuvable (à vérifier).\n📖 = lire l'article traduit en français, même mise en page.\n\n${lines.join("\n\n")}`,
    {
      reply_markup: {
        inline_keyboard: [
          ...sheets
            .filter((sheet) => sheet.pdf)
            .slice(0, 4)
            .map((sheet) => [readerButton(env, sheet.key, `📖 ${cut(sheet.title, 40)}`)]),
          [{ text: "🌐 Toutes les fiches + comparatif", url: `${siteUrl(env)}/#fiches` }],
        ],
      },
    },
  );
}

async function sendWordFront(env, chatId, word, index, total) {
  const hash = hashTerm(word.term);
  await send(
    env,
    chatId,
    `🇬🇧 <b>${esc(word.term)}</b>  (${index}/${total})\nQue veut dire ce mot ? Réfléchis 5 secondes, puis regarde la réponse.`,
    { reply_markup: { inline_keyboard: [[{ text: "👀 Voir la réponse", callback_data: `w:s:${hash}` }]] } },
  );
}

async function cmdAnglais(env, chatId, count = 3, { intro = null } = {}) {
  const data = await botData(env);
  if (!data || !(data.vocabulary || []).length) {
    return send(env, chatId, "🇬🇧 Pas de vocabulaire disponible pour le moment.");
  }
  const reviewed = new Set(Object.keys(await recentMap(env, "recent:vocab")));
  const shown = await recentMap(env, "recent:shown");
  const now = new Date().toISOString();
  const pool = data.vocabulary.filter((word) => !reviewed.has(hashTerm(word.term)));
  // Words shown in the last hours wait, so each English break brings new ones.
  const unseen = pool.filter((word) => !shown[hashTerm(word.term)]);
  const candidates = unseen.length >= count ? unseen : pool;
  let selection = candidates
    .filter((word) => !word.due || word.due <= now)
    .sort((a, b) => String(a.due).localeCompare(String(b.due)) || (a.reps || 0) - (b.reps || 0))
    .slice(0, count);
  let header = intro || "🇬🇧 <b>Mots à réviser aujourd'hui</b> (répétition espacée)";
  if (!selection.length) {
    selection = [...candidates].sort(() => Math.random() - 0.5).slice(0, count);
    header = intro || "🇬🇧 <b>Révision libre</b> — aucun mot n'est dû aujourd'hui, bravo !";
  }
  if (!selection.length) return send(env, chatId, "🇬🇧 Tous les mots ont été révisés récemment. Reviens demain !");
  for (const word of selection) shown[hashTerm(word.term)] = Date.now() + SHOWN_TTL * 1000;
  await kvPut(env, "recent:shown", shown);
  await send(env, chatId, header);
  for (const [index, word] of selection.entries()) {
    await sendWordFront(env, chatId, word, index + 1, selection.length);
  }
}

function lessonText(lesson, position, total) {
  const terms = (lesson.terms || []).map(([en, fr]) => `• <b>${esc(en)}</b> = ${esc(fr)}`).join("\n");
  return [
    `${esc(lesson.module?.emoji || "🧠")} <b>${esc(lesson.module?.title || "Module")}</b> · leçon ${position}/${total}`,
    `<b>${esc(lesson.title)}</b>`,
    "",
    esc(lesson.content),
    lesson.example ? `\n💡 <i>${esc(lesson.example)}</i>` : "",
    terms ? `\n🇬🇧 Mots à retenir :\n${terms}` : "",
  ].join("\n");
}

async function cmdApprendre(env, chatId, { index = null } = {}) {
  const learning = await loadData(env, "learning.json");
  const lessons = flattenLessons(learning);
  if (!lessons.length) return send(env, chatId, unavailable);
  const state = await learnState(env);
  const position = Math.min(Math.max(index ?? state.current ?? 0, 0), lessons.length - 1);
  if (position !== state.current) await kvPut(env, "learn:state", { ...state, current: position });
  const lesson = lessons[position];
  const done = new Set(state.done || []);
  await send(env, chatId, lessonText(lesson, position + 1, lessons.length) + (done.has(lesson.id) ? "\n\n✅ Leçon déjà validée." : ""), {
    reply_markup: {
      inline_keyboard: [
        [{ text: "📝 Faire le quiz", callback_data: `q:${lesson.id}` }],
        [
          { text: "⏮ Précédente", callback_data: `l:p` },
          { text: "⏭ Suivante", callback_data: `l:n` },
        ],
        [{ text: "📚 Tous les modules", callback_data: "l:m" }, { text: "🌐 Cours complet", url: `${siteUrl(env)}/learning.html#${lesson.id}` }],
      ],
    },
  });
}

async function cmdModules(env, chatId) {
  const learning = await loadData(env, "learning.json");
  const state = await learnState(env);
  const done = new Set(state.done || []);
  const rows = (learning?.modules || []).map((module) => {
    const total = (module.lessons || []).length;
    const finished = (module.lessons || []).filter((lesson) => done.has(lesson.id)).length;
    return [{ text: `${module.emoji || "📘"} ${module.title} (${finished}/${total})`, callback_data: `l:o:${module.id}` }];
  });
  await send(env, chatId, "📚 <b>Parcours d'apprentissage</b>\nDe zéro jusqu'à ton sujet de PFE. Choisis un module :", {
    reply_markup: { inline_keyboard: rows },
  });
}

async function sendQuiz(env, chatId, lessonId) {
  const learning = await loadData(env, "learning.json");
  const lessons = flattenLessons(learning);
  const lesson = lessons.find((item) => item.id === lessonId) || lessons[(await learnState(env)).current || 0];
  if (!lesson?.quiz) return send(env, chatId, "📝 Pas de quiz pour cette leçon.");
  const rows = lesson.quiz.options.map((option, index) => [
    { text: `${String.fromCharCode(65 + index)}. ${cut(option, 60)}`, callback_data: `q:${lesson.id}:${index}` },
  ]);
  await send(env, chatId, `📝 <b>Quiz · ${esc(lesson.title)}</b>\n\n${esc(lesson.quiz.question)}`, {
    reply_markup: { inline_keyboard: rows },
  });
}

async function cmdRedaction(env, chatId, stepId = null) {
  const learning = await loadData(env, "learning.json");
  const steps = learning?.redaction || [];
  if (!steps.length) return send(env, chatId, unavailable);
  const week = currentWeek(learning);
  if (stepId) {
    const step = steps.find((item) => item.id === stepId);
    if (!step) return send(env, chatId, "Étape inconnue.");
    const text = [
      `✍️ <b>${esc(step.title)}</b>`,
      `🗓 ${esc(step.when)}`,
      "",
      esc(step.goal),
      "",
      "<b>À faire :</b>",
      ...(step.checklist || []).map((item) => `☐ ${esc(item)}`),
      step.tip ? `\n💡 <i>${esc(step.tip)}</i>` : "",
    ].join("\n");
    return send(env, chatId, text, {
      reply_markup: { inline_keyboard: [[{ text: "🌐 Guide de rédaction complet", url: `${siteUrl(env)}/#redaction` }]] },
    });
  }
  const current = steps.find((step) => week >= step.from && week <= step.to);
  const rows = steps.map((step) => [
    { text: `${step === current ? "👉 " : ""}${step.title}`, callback_data: `r:s:${step.id}` },
  ]);
  await send(
    env,
    chatId,
    `✍️ <b>Rédaction scientifique du mémoire</b>\nSemaine ${week}/16. ${current ? `Étape du moment : <b>${esc(current.title)}</b>.` : ""}\nTouche une étape pour voir quoi faire :`,
    { reply_markup: { inline_keyboard: rows } },
  );
}

async function cmdPlan(env, chatId) {
  const [learning, data, state] = await Promise.all([loadData(env, "learning.json"), botData(env), learnState(env)]);
  const week = currentWeek(learning);
  const entry = roadmapEntry(learning, week);
  const lessons = flattenLessons(learning);
  const lesson = lessons[Math.min(state.current || 0, Math.max(lessons.length - 1, 0))];
  const pending = data?.library?.pending ?? data?.queue?.length ?? 0;
  const text = [
    `🗓 <b>Semaine ${week}/16</b>${entry ? ` — ${esc(entry.goal)}` : ""}`,
    entry ? `🎯 Critère de sortie : <i>${esc(entry.exit)}</i>` : "",
    "",
    "<b>Aujourd'hui (≈ 30 min) :</b>",
    `1. 📥 Trier ${Math.min(pending, 10)} article(s) (${pending} en attente)`,
    lesson ? `2. 🧠 Leçon : ${esc(lesson.title)}` : "2. 🧠 Leçon du jour",
    "3. 🇬🇧 Réviser 3 mots d'anglais",
    ...(entry?.tasks || []).map((task, index) => `${index + 4}. ${esc(task)}`),
  ]
    .filter(Boolean)
    .join("\n");
  await send(env, chatId, text, {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "📥 Trier", callback_data: "m:tri" },
          { text: "🧠 Leçon", callback_data: "m:apprendre" },
          { text: "🇬🇧 Mots", callback_data: "m:anglais" },
        ],
        [{ text: "✍️ Étape de rédaction", callback_data: "m:redaction" }],
      ],
    },
  });
}

async function cmdAgents(env, chatId) {
  const [data, last] = await Promise.all([botData(env), kvGet(env, "pipeline:last", null)]);
  const agents = data?.agents || {};
  const lines = [
    "🤖 <b>Agents IA (Gemini gratuit, dans GitHub Actions)</b>",
    "2 passages complets par jour (~06:15 et ~15:45) + 6 passages légers pour les actus.",
    "",
    "• <b>Collecteur</b> : cherche les nouveaux articles (OpenAlex + arXiv)",
    "• <b>Trieur</b> : pré-trie titres/résumés selon tes critères PRISMA",
    "• <b>Lecteur</b> : télécharge le PDF, le lit en entier, écrit une fiche et vérifie ses citations (les articles de l'encadrant passent en premier)",
    "• <b>Synthèse</b> : compare les fiches et prépare l'état de l'art",
    "• <b>Veilleur</b> : surveille failles, dépôts GitHub/GitLab et incidents IA, et les résume en français",
    "",
    `📊 Articles pré-triés par l'IA : ${agents.screenedPapers ?? 0}`,
    `📘 Fiches écrites : ${agents.sheets ?? 0} · en file de lecture : ${agents.readingQueue ?? 0}`,
    `🕐 Dernier passage réussi : ${agents.lastSuccessAt ? esc(agents.lastSuccessAt.replace("T", " ").slice(0, 16)) + " UTC" : "jamais"}`,
  ];
  if (last?.agentsSkipped) {
    lines.push(
      "",
      "⚠️ <b>Agents IA en pause</b> : la clé Gemini n'est pas encore dans les secrets GitHub.",
      "Sur ton PC, dans le dossier du projet : <code>powershell -ExecutionPolicy Bypass -File scripts\\setup-secrets.ps1</code>",
    );
  }
  if (last?.runUrl) lines.push("", `<a href="${esc(last.runUrl)}">Voir le dernier passage</a>`);
  await send(env, chatId, lines.join("\n"), {
    reply_markup: { inline_keyboard: [[{ text: "🌐 Page Agents", url: `${siteUrl(env)}/#agents` }]] },
  });
}

async function cmdSearch(env, chatId, query) {
  if (!query || query.trim().length < 2) return send(env, chatId, "🔍 Écris par exemple : <code>/chercher hard label</code>");
  const state = await loadData(env, "state.json");
  if (!state) return send(env, chatId, unavailable);
  const needle = query.toLowerCase().trim();
  const matches = (state.papers || [])
    .filter((paper) => `${paper.title} ${paper.abstract}`.toLowerCase().includes(needle))
    .slice(0, 8);
  if (!matches.length) return send(env, chatId, `🔍 Aucun résultat pour « ${esc(query)} ».`);
  const lines = matches.map((paper) => {
    const link = paper.url ? ` — <a href="${esc(paper.url)}">source</a>` : "";
    return `• [${esc(paper.year || "?")}] ${esc(cut(paper.title, 90))} <i>(${esc(paper.status)})</i>${link}`;
  });
  await send(env, chatId, `🔍 <b>${matches.length} résultat(s) pour « ${esc(query)} »</b>\n\n${lines.join("\n")}`);
}

async function cmdSettings(env, chatId, messageId = null) {
  const settings = await getSettings(env);
  const mark = (value) => (value ? "✅" : "⬜️");
  const paused = isPaused(settings);
  const text = `⚙️ <b>Notifications automatiques</b>${paused ? `\n⏸ En pause jusqu'au ${esc(settings.pausedUntil.slice(0, 16).replace("T", " "))} UTC` : ""}\nTouche pour activer/désactiver :`;
  const rows = SCHEDULE.filter((entry) => entry.label).map((entry) => [
    { text: `${mark(settings[entry.setting])} ${entry.label}`, callback_data: `set:${entry.setting}` },
  ]);
  const markup = {
    inline_keyboard: [
      ...rows,
      [{ text: `${mark(settings.alerts)} 🚨 Alertes failles IA graves (immédiat)`, callback_data: "set:alerts" }],
      [{ text: `${mark(settings.agents)} Rapports des agents IA`, callback_data: "set:agents" }],
      [{ text: paused ? "▶️ Reprendre maintenant" : "⏸ Pause 24 h", callback_data: "set:pause" }],
    ],
  };
  if (messageId) return edit(env, chatId, messageId, text, { reply_markup: markup });
  return send(env, chatId, text, { reply_markup: markup });
}

// ─── AI-security news and alerts ───────────────────────────────────────────

function newsLine(item) {
  const icon = item.severity === "alert" ? "🚨" : item.severity === "notable" ? "🔸" : "▫️";
  const extra = item.stars ? ` ⭐${item.stars}` : item.cvss ? ` · CVSS ${item.cvss}` : "";
  const source = SOURCE_LABELS[item.source] || item.source || "";
  const summary = item.summary ? `\n<i>${esc(cut(item.summary, 230))}</i>${item.fr ? "" : " 🇬🇧"}` : "";
  const titleFr = item.titleFr ? `\n🇫🇷 ${esc(cut(item.titleFr, 160))}` : "";
  return `${icon} ${KIND_LABELS[item.kind] || "•"}${extra} · ${esc(source)}\n${link(item.url, cut(item.title, 150))}${titleFr}${summary}\n`;
}

function newsButtons(env, active = "all") {
  const filters = KIND_FILTERS.map(([kind, label]) => ({
    text: `${kind === active ? "• " : ""}${label}`,
    callback_data: `n:${kind}`,
  }));
  return {
    inline_keyboard: [
      filters.slice(0, 3),
      filters.slice(3),
      [{ text: "🌐 Toutes les actus sur le site", url: `${siteUrl(env)}/#actus` }],
    ],
  };
}

async function cmdActus(env, chatId, kind = "all", messageId = null) {
  const data = await botData(env);
  if (!data) return send(env, chatId, unavailable);
  const items = (data.securityNews || [])
    .filter((item) => kind === "all" || item.kind === kind)
    .sort((a, b) => String(b.at || "").localeCompare(String(a.at || "")))
    .slice(0, 8);
  const label = (KIND_FILTERS.find(([value]) => value === kind) || KIND_FILTERS[0])[1];
  const header = [
    `📰 <b>Actus sécurité IA</b> · ${esc(label)}`,
    "🚨 alerte · 🔸 important · ▫️ à connaître · 🇬🇧 résumé pas encore traduit",
    "",
  ];
  const body = items.length
    ? items.map(newsLine)
    : ["Rien dans cette catégorie pour l'instant. Le veilleur passe 8 fois par jour."];
  const text = fitLines([...header, ...body]);
  if (messageId) return edit(env, chatId, messageId, text, { reply_markup: newsButtons(env, kind) });
  return send(env, chatId, text, { reply_markup: newsButtons(env, kind) });
}

async function newsDigest(env, chatId, nowMs = Date.now()) {
  const data = await botData(env);
  const seen = await recentMap(env, "recent:news");
  const since = new Date(nowMs - 36 * 3600 * 1000).toISOString().slice(0, 19);
  const fresh = (data?.securityNews || [])
    .filter((item) => item.key && !seen[hashTerm(item.key)] && String(item.collectedAt || "").slice(0, 19) >= since)
    .sort(
      (a, b) =>
        (SEVERITY_RANK[a.severity] ?? 3) - (SEVERITY_RANK[b.severity] ?? 3) ||
        String(b.at || "").localeCompare(String(a.at || "")),
    )
    .slice(0, 7);
  if (!fresh.length) {
    return send(env, chatId, "📰 <b>Actus sécurité IA</b>\nRien de nouveau de marquant depuis hier. L'historique : /actus", {
      reply_markup: { inline_keyboard: [[{ text: "📰 Voir les actus", callback_data: "n:all" }]] },
    });
  }
  for (const item of fresh) seen[hashTerm(item.key)] = Date.now() + NEWS_TTL * 1000;
  await kvPut(env, "recent:news", seen);
  const text = fitLines([
    `📰 <b>Actus sécurité IA du jour</b> (${fresh.length})`,
    "Failles, nouveaux dépôts GitHub/GitLab, incidents IA, presse et recherche.",
    "",
    ...fresh.map(newsLine),
  ]);
  return send(env, chatId, text, { reply_markup: newsButtons(env) });
}

function alertText(alerts) {
  const lines = [`🚨 <b>Alerte sécurité IA</b>${alerts.length > 1 ? ` (${alerts.length})` : ""}`, ""];
  for (const alert of alerts.slice(0, 5)) {
    lines.push(`<b>${esc(cut(alert.title, 180))}</b>`);
    if (alert.titleFr) lines.push(`🇫🇷 <b>${esc(cut(alert.titleFr, 180))}</b>`);
    lines.push(`${KIND_LABELS[alert.kind] || "•"} · ${esc(SOURCE_LABELS[alert.source] || alert.source || "")}`);
    if (alert.summary) lines.push(`<i>${esc(cut(alert.summary, 300))}</i>`);
    if (safeUrl(alert.url)) lines.push(`🔗 ${link(alert.url, "Détails")}`);
    lines.push("");
  }
  lines.push("Pourquoi une alerte : faille critique, ou activement exploitée, qui touche un logiciel d'IA.");
  return fitLines(lines);
}

async function queueAlerts(env, alerts) {
  const seen = await recentMap(env, "recent:alerts");
  const pending = await kvGet(env, "alerts:pending", []);
  const known = new Set([...Object.keys(seen), ...pending.map((alert) => hashTerm(alert.key))]);
  const fresh = [];
  for (const alert of alerts) {
    const id = hashTerm(alert.key);
    if (known.has(id)) continue;
    known.add(id);
    fresh.push({
      key: String(alert.key),
      kind: String(alert.kind || ""),
      source: String(alert.source || ""),
      title: cut(alert.title, 200),
      titleFr: cut(alert.titleFr, 200),
      summary: cut(alert.summary, 400),
      url: safeUrl(alert.url),
    });
  }
  if (fresh.length) await kvPut(env, "alerts:pending", [...pending, ...fresh].slice(-10), 3 * 24 * 3600);
  return fresh.length;
}

async function flushAlerts(env, { chatId = null, settings = null, nowMs = Date.now() } = {}) {
  const pending = await kvGet(env, "alerts:pending", []);
  if (!pending.length) return false;
  const chat = chatId ?? (await getChat(env));
  const config = settings ?? (await getSettings(env));
  // At most once: forget the queue first, so a failing send never repeats.
  await kvPut(env, "alerts:pending", []);
  const seen = await recentMap(env, "recent:alerts");
  for (const alert of pending) seen[hashTerm(alert.key)] = Date.now() + ALERT_TTL * 1000;
  await kvPut(env, "recent:alerts", seen);
  if (!chat || !config.alerts || isPaused(config, nowMs)) return false;
  await send(env, chat, alertText(pending), {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "📰 Toutes les actus", callback_data: "n:all" },
          { text: "🔕 Couper les alertes", callback_data: "set:alerts" },
        ],
      ],
    },
  });
  return true;
}

// ─── PDF reader (mini app) ─────────────────────────────────────────────────

const encoder = new TextEncoder();

function hex(bytes) {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function hmacSha256(key, message) {
  const cryptoKey = await crypto.subtle.importKey("raw", typeof key === "string" ? encoder.encode(key) : key, { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(message)));
}

/** Signed reader token for a computer browser: `${expiry}.${signature}`. */
async function readerToken(env, nowMs = Date.now()) {
  const expiry = Math.floor(nowMs / 1000) + READER_TOKEN_DAYS * 86400;
  return `${expiry}.${hex(await hmacSha256(env.TELEGRAM_BOT_TOKEN, `reader:${expiry}`)).slice(0, 40)}`;
}

async function verifyReaderToken(env, token) {
  const [expiry, signature] = String(token || "").split(".");
  if (!expiry || !signature || Number(expiry) < Date.now() / 1000) return false;
  return safeEqual(signature, hex(await hmacSha256(env.TELEGRAM_BOT_TOKEN, `reader:${expiry}`)).slice(0, 40));
}

/** Telegram mini-app launch data, checked with the bot token (core.telegram.org/bots/webapps). */
async function verifyInitData(env, initData) {
  const params = new URLSearchParams(String(initData || ""));
  const hash = params.get("hash");
  if (!hash) return null;
  params.delete("hash");
  const check = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secret = await hmacSha256("WebAppData", env.TELEGRAM_BOT_TOKEN);
  if (!safeEqual(hex(await hmacSha256(secret, check)), hash)) return null;
  if (!(Date.now() / 1000 - Number(params.get("auth_date") || 0) < 7 * 86400)) return null;
  try {
    return JSON.parse(params.get("user") || "{}").id ?? null;
  } catch (_error) {
    return null;
  }
}

async function readerAuthorized(request, env) {
  if (!env.TELEGRAM_BOT_TOKEN) return false;
  const header = request.headers.get("Authorization") || "";
  if (header.startsWith("Bearer ")) return verifyReaderToken(env, header.slice(7));
  if (header.startsWith("tma ")) {
    const userId = await verifyInitData(env, header.slice(4));
    const chat = await getChat(env);
    return Boolean(userId && chat && Number(userId) === chat);
  }
  return false;
}

function corsHeaders(request) {
  const origin = request.headers.get("Origin") || "";
  if (!READER_ORIGINS.some((pattern) => pattern.test(origin))) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function readerJson(request, data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(request) },
  });
}

// Per-instance counters (reset every hour) protecting the free Gemini quota.
const anonymousUse = { hour: -1, total: 0, byAddress: new Map() };

function allowAnonymousCall(request) {
  const hour = Math.floor(Date.now() / 3600000);
  if (anonymousUse.hour !== hour) {
    anonymousUse.hour = hour;
    anonymousUse.total = 0;
    anonymousUse.byAddress.clear();
  }
  const address = request.headers.get("CF-Connecting-IP") || "unknown";
  const used = anonymousUse.byAddress.get(address) || 0;
  if (used >= READER_ANON_PER_HOUR || anonymousUse.total >= READER_ANON_GLOBAL_PER_HOUR) return false;
  anonymousUse.byAddress.set(address, used + 1);
  anonymousUse.total += 1;
  return true;
}

async function libraryPdfs(env) {
  const index = await loadData(env, "reader.json");
  return new Set(Object.values(index?.papers || {}).map((paper) => paper.pdf).filter(Boolean));
}

async function publicPdf(env, target) {
  let host = "";
  try {
    host = new URL(target).hostname.toLowerCase();
  } catch (_error) {
    return false;
  }
  return READER_PUBLIC_HOSTS.has(host) || (await libraryPdfs(env)).has(target);
}

/** Remember a paper the student opened, so the next pipeline run translates it. */
async function rememberWanted(env, doc) {
  const url = safeUrl(doc?.url);
  if (!url) return false;
  const wanted = await kvGet(env, "reader:wanted", {});
  if (wanted[url]) return true;
  wanted[url] = { key: cut(doc.key, 40), title: cut(doc.title, 200), at: new Date().toISOString() };
  const urls = Object.keys(wanted).sort((a, b) => String(wanted[b].at).localeCompare(String(wanted[a].at)));
  for (const old of urls.slice(READER_WANTED_MAX)) delete wanted[old];
  await kvPut(env, "reader:wanted", wanted);
  return true;
}

async function readerTranslate(request, env, authorized) {
  const payload = await request.json().catch(() => null);
  const texts = Array.isArray(payload?.texts) ? payload.texts.map((text) => String(text ?? "")) : null;
  if (!texts || !texts.length) return readerJson(request, { ok: false, error: "no texts" }, 400);
  if (texts.length > READER_MAX_BLOCKS || texts.join("").length > READER_MAX_CHARS) {
    return readerJson(request, { ok: false, error: "page too large" }, 413);
  }
  const cacheKey = translationKey(await translationHash(texts));
  const cached = await kvGet(env, cacheKey, null);
  if (cached) return readerJson(request, { ok: true, cached: true, ...cached });
  const doc = payload?.doc || {};
  const queue = async () => {
    const queued = await rememberWanted(env, doc);
    return readerJson(request, { ok: false, queued, error: queued ? "queued" : "no-url" }, 202);
  };
  // Without its own key, the worker hands the paper to the next pipeline run.
  if (!env.GEMINI_API_KEY) return queue();
  if (!authorized && !allowAnonymousCall(request)) return queue();
  try {
    const result = await geminiTranslate(env.GEMINI_API_KEY, texts);
    await kvPut(env, cacheKey, result);
    return readerJson(request, { ok: true, cached: false, ...result });
  } catch (error) {
    await rememberWanted(env, doc);
    return readerJson(request, { ok: false, error: String(error.message || error) }, 502);
  }
}

async function readerPdf(request, env, url, authorized) {
  const target = safeUrl(url.searchParams.get("url"));
  if (!target) return readerJson(request, { ok: false, error: "bad url" }, 400);
  if (!authorized && !(await publicPdf(env, target))) {
    return readerJson(request, { ok: false, error: "not-public" }, 403);
  }
  let response;
  try {
    response = await fetch(target, {
      headers: { "User-Agent": `Mozilla/5.0 (compatible; PFE-HLA-Reader/${VERSION})`, Accept: "application/pdf,*/*" },
      redirect: "follow",
    });
  } catch (error) {
    return readerJson(request, { ok: false, error: `unreachable: ${error.message}` }, 502);
  }
  if (!response.ok) return readerJson(request, { ok: false, error: `HTTP ${response.status}` }, 502);
  const type = response.headers.get("Content-Type") || "";
  if (!/pdf|octet-stream/i.test(type)) return readerJson(request, { ok: false, error: `not a PDF (${type || "unknown type"})` }, 415);
  return new Response(response.body, {
    headers: { "Content-Type": "application/pdf", "Cache-Control": "private, max-age=3600", ...corsHeaders(request) },
  });
}

async function handleReader(request, env, url) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(request) });
  const authorized = await readerAuthorized(request, env);
  if (url.pathname === "/reader/status") {
    return readerJson(request, { ok: true, translate: Boolean(env.GEMINI_API_KEY), authorized, version: VERSION });
  }
  if (url.pathname === "/reader/pdf" && request.method === "GET") return readerPdf(request, env, url, authorized);
  if (url.pathname === "/reader/translate" && request.method === "POST") return readerTranslate(request, env, authorized);
  return readerJson(request, { ok: false, error: "not found" }, 404);
}

// ─── Translations made ahead of time by the pipeline ───────────────────────

async function apiTranslationsState(env) {
  return json({ wanted: await kvGet(env, "reader:wanted", {}), done: await kvGet(env, "reader:done", {}) });
}

async function apiTranslationsMissing(request, env) {
  const body = await request.json().catch(() => ({}));
  const hashes = (Array.isArray(body.hashes) ? body.hashes : []).filter((hash) => /^[0-9a-f]{64}$/.test(hash)).slice(0, 200);
  const missing = [];
  for (const hash of hashes) {
    if (!(await kvGet(env, translationKey(hash), null))) missing.push(hash);
  }
  return json({ missing });
}

async function apiTranslationsStore(request, env) {
  const body = await request.json().catch(() => ({}));
  let stored = 0;
  for (const entry of (Array.isArray(body.entries) ? body.entries : []).slice(0, 50)) {
    if (!/^[0-9a-f]{64}$/.test(String(entry?.hash)) || !Array.isArray(entry.fr)) continue;
    const fr = entry.fr.map((value) => (typeof value === "string" ? value : null));
    await kvPut(env, translationKey(entry.hash), { fr, model: String(entry.model || "pipeline") });
    stored += 1;
  }
  const finished = (Array.isArray(body.done) ? body.done : []).map(safeUrl).filter(Boolean);
  if (finished.length) {
    const wanted = await kvGet(env, "reader:wanted", {});
    const done = await kvGet(env, "reader:done", {});
    for (const url of finished) {
      delete wanted[url];
      done[url] = new Date().toISOString();
    }
    await kvPut(env, "reader:wanted", wanted);
    await kvPut(env, "reader:done", done);
  }
  return json({ ok: true, stored, done: finished.length });
}

async function cmdLecteur(env, chatId) {
  const token = await readerToken(env);
  const lines = [
    "📖 <b>Lecteur PDF bilingue</b>",
    "Il ouvre l'article ici, dans Telegram, et traduit chaque page en français <b>sans changer la mise en page</b> (figures, colonnes et formules restent à leur place).",
    "• Boutons en haut : 🇬🇧 original · 🇫🇷 français · 🇬🇧|🇫🇷 les deux côte à côte.",
    "• Touche un paragraphe traduit pour revoir l'anglais.",
    "• Les agents traduisent à l'avance les articles de ton encadrant et ceux que tu ouvres : rien à taper.",
    "• Les traductions sont gardées : la 2ᵉ ouverture est instantanée.",
    "",
    "Les boutons « 📖 Lire » apparaissent sur les cartes d'articles, les fiches et la liste de l'encadrant ; sur le site, les articles de la bibliothèque s'ouvrent directement.",
    "💻 Pour lire un lien qui n'est pas dans la bibliothèque sur l'ordinateur : « Activer sur ce navigateur » (valable 4 mois).",
    "⚠️ Le texte des pages est envoyé à Gemini (offre gratuite de Google) pour la traduction : n'y ouvre pas de document confidentiel.",
  ];
  return send(env, chatId, lines.join("\n"), {
    reply_markup: {
      inline_keyboard: [
        [readerButton(env, "", "📖 Ouvrir le lecteur (URL ou fichier)")],
        [{ text: "💻 Activer sur ce navigateur", url: `${readerUrl(env)}#t=${token}` }],
      ],
    },
  });
}

// ─── Supervisor material ───────────────────────────────────────────────────

async function cmdEncadrant(env, chatId) {
  const data = await botData(env);
  if (!data) return send(env, chatId, unavailable);
  const supervisor = data.supervisor;
  const site = data.site || siteUrl(env);
  const readable = (supervisor?.items || []).filter((item) => item.priority === 1 && item.pdf).slice(0, 6);
  const readerRows = [];
  for (let index = 0; index < readable.length; index += 2) {
    readerRows.push(readable.slice(index, index + 2).map((item) => readerButton(env, item.key, `📖 ${cut(item.short, 22)}`)));
  }
  const buttons = {
    inline_keyboard: [
      ...readerRows,
      [
        { text: "📘 Plan de lecture de la thèse", callback_data: "m:these" },
        { text: "❓ Questions à poser", callback_data: "m:questions" },
      ],
      [
        { text: "🧭 Leçons hard-label", callback_data: "l:o:hardlabel" },
        { text: "🌐 Page Encadrant", url: `${siteUrl(env)}/#encadrant` },
      ],
    ],
  };
  if (!supervisor?.total) {
    return send(env, chatId, "🎓 La liste d'articles de ton encadrant sera importée au prochain passage des agents.", { reply_markup: buttons });
  }
  const items = (supervisor.items || []).filter((item) => item.priority === 1);
  const lines = [
    "🎓 <b>Articles conseillés par ton encadrant</b>",
    `${supervisor.total} articles · ✅ ${supervisor.sheets} fiche(s) · ⏳ ${supervisor.queued} en lecture · 📕 ${supervisor.noPdf} sans PDF libre`,
    "",
    "<b>Priorité 1 — à lire et discuter avec lui :</b>",
    ...items.map((item) => {
      const name = item.reading === "sheet" ? link(`${site}/#fiches/${item.key}`, item.short) : `<b>${esc(item.short)}</b>`;
      return `${READING_ICONS[item.reading] || "▫️"} ${name} (${esc(item.year || "?")}) — ${esc(cut(item.title, 70))}`;
    }),
    "",
    "✅ fiche prête · ⏳ l'agent lecteur s'en occupe · 📕 PDF non libre : demande-le à l'encadrant ou à la bibliothèque",
  ];
  return send(env, chatId, fitLines(lines), { reply_markup: buttons });
}

async function cmdThese(env, chatId, messageId = null) {
  const learning = await loadData(env, "learning.json");
  const plan = learning?.supervisor?.thesisPlan || [];
  if (!plan.length) return send(env, chatId, unavailable);
  const done = new Set(await kvGet(env, "these:done", []));
  const lines = [
    "📘 <b>Lire la thèse de ton encadrant</b>",
    esc(learning.supervisor.thesisNote || ""),
    `Progression : <b>${plan.filter((step) => done.has(step.id)).length}/${plan.length}</b>`,
    "",
    ...plan.map((step, index) => `${done.has(step.id) ? "✅" : "☐"} <b>${index + 1}. ${esc(step.title)}</b> (${esc(step.pages || "")})\n    🎯 ${esc(step.goal)}`),
  ];
  const markup = {
    inline_keyboard: [
      ...plan.map((step, index) => [
        { text: `${done.has(step.id) ? "✅" : "☐"} ${index + 1}. ${cut(step.title, 45)}`, callback_data: `t:${step.id}` },
      ]),
      [{ text: "🧠 Leçons sur la thèse", callback_data: "l:o:these" }],
    ],
  };
  if (messageId) return edit(env, chatId, messageId, fitLines(lines), { reply_markup: markup });
  return send(env, chatId, fitLines(lines), { reply_markup: markup });
}

async function cmdQuestions(env, chatId) {
  const learning = await loadData(env, "learning.json");
  const questions = learning?.supervisor?.questions || [];
  if (!questions.length) return send(env, chatId, unavailable);
  return send(
    env,
    chatId,
    fitLines([
      "❓ <b>Questions à poser à ton encadrant</b>",
      "Note ses réponses : elles fixent le cadre du PFE.",
      "",
      ...questions.map((question, index) => `${index + 1}. ${esc(question)}`),
    ]),
    { reply_markup: { inline_keyboard: [[{ text: "🎓 Articles de l'encadrant", callback_data: "m:encadrant" }]] } },
  );
}

async function cmdToday(env, chatId, { greeting = "📅 <b>Ta journée PFE</b>" } = {}) {
  const [data, learning, state] = await Promise.all([botData(env), loadData(env, "learning.json"), learnState(env)]);
  const week = currentWeek(learning);
  const entry = roadmapEntry(learning, week);
  const lessons = flattenLessons(learning);
  const lesson = lessons[Math.min(state.current || 0, Math.max(lessons.length - 1, 0))];
  const pending = data?.library?.pending ?? 0;
  const news = data?.news24h || {};
  const now = new Date().toISOString();
  const dueWords = (data?.vocabulary || []).filter((word) => !word.due || word.due <= now).length;
  const supervisor = data?.supervisor;
  const alerts = (data?.securityNews || []).filter((item) => item.severity === "alert").length;
  const lines = [
    greeting,
    `Semaine ${week}/16${entry ? ` — ${esc(entry.goal)}` : ""}`,
    "",
    news.papers || news.sheets
      ? `🆕 Dernières 24 h : ${news.papers || 0} nouvel(s) article(s), ${news.sheets || 0} nouvelle(s) fiche(s).`
      : "🆕 Pas de nouveauté des agents depuis hier.",
    `📥 ${pending} article(s) attendent ton tri.`,
    supervisor?.total ? `🎓 Liste de l'encadrant : ${supervisor.sheets}/${supervisor.total} fiche(s) prête(s).` : "",
    lesson ? `🧠 Leçon du jour : <b>${esc(lesson.title)}</b>` : "",
    `🇬🇧 ${dueWords} mot(s) à réviser (pauses anglais à 10:00 et 15:30).`,
    alerts ? `🚨 ${alerts} alerte(s) sécurité IA récente(s) : /actus` : "📰 Actus sécurité IA à 18:00.",
  ].filter(Boolean);
  await send(env, chatId, lines.join("\n"), {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "📥 Trier", callback_data: "m:tri" },
          { text: "🧠 Leçon", callback_data: "m:apprendre" },
        ],
        [
          { text: "🇬🇧 Mots", callback_data: "m:anglais" },
          { text: "📄 Fiches", callback_data: "m:fiches" },
        ],
        [
          { text: "🎓 Encadrant", callback_data: "m:encadrant" },
          { text: "🗓 Plan de la semaine", callback_data: "m:plan" },
        ],
      ],
    },
  });
}

async function runCommand(env, chatId, command, args = "") {
  switch (command) {
    case "/aide":
      return cmdHelp(env, chatId);
    case "/menu":
      return cmdMenu(env, chatId);
    case "/aujourdhui":
      return cmdToday(env, chatId);
    case "/tri":
      return sendNextPaper(env, chatId);
    case "/fiches":
      return cmdFiches(env, chatId);
    case "/prisma":
      return cmdPrisma(env, chatId);
    case "/anglais":
      return cmdAnglais(env, chatId);
    case "/apprendre":
      return cmdApprendre(env, chatId);
    case "/quiz":
      return sendQuiz(env, chatId, null);
    case "/redaction":
      return cmdRedaction(env, chatId);
    case "/plan":
      return cmdPlan(env, chatId);
    case "/agents":
      return cmdAgents(env, chatId);
    case "/chercher":
      return cmdSearch(env, chatId, args);
    case "/site":
      return send(env, chatId, `🌐 <a href="${esc(siteUrl(env))}">Ouvrir le tableau de bord PFE</a>`);
    case "/reglages":
      return cmdSettings(env, chatId);
    case "/actus":
      return cmdActus(env, chatId);
    case "/encadrant":
      return cmdEncadrant(env, chatId);
    case "/these":
      return cmdThese(env, chatId);
    case "/questions":
      return cmdQuestions(env, chatId);
    case "/lecteur":
      return cmdLecteur(env, chatId);
    case "/app":
      return send(env, chatId, "📱 <b>Le tableau de bord dans Telegram</b>\nTouche le bouton : le site s'ouvre ici, sans quitter Telegram.", {
        reply_markup: { inline_keyboard: [[{ text: "📱 Ouvrir l'app", web_app: { url: `${siteUrl(env)}/` } }]] },
      });
    default:
      return send(env, chatId, "🤔 Je n'ai pas compris. Voici le menu :", { reply_markup: MENU_KEYBOARD }).then(() =>
        cmdMenu(env, chatId),
      );
  }
}

// ─── Pairing ────────────────────────────────────────────────────────────────

async function handleStart(env, chatId, text) {
  const existing = await getChat(env);
  if (existing) {
    if (existing === chatId) {
      await send(env, chatId, "👋 Re-bonjour ! Le clavier en bas te donne accès à tout.", { reply_markup: MENU_KEYBOARD });
      return cmdToday(env, chatId);
    }
    return send(env, chatId, "⛔ Ce bot est déjà associé à un autre compte.");
  }
  const supplied = text.trim().split(/\s+/).slice(1).join(" ");
  const expected = env.TELEGRAM_PAIRING_CODE || "";
  if (expected.length < 8 || !safeEqual(supplied, expected)) {
    return send(env, chatId, "🔑 Envoie <code>/start TON_CODE</code> pour associer ce bot à ton compte.");
  }
  await env.PFE_STATE.put("authorized_chat_id", String(chatId));
  await send(env, chatId, "✅ Appareil associé ! Supprime le message qui contenait le code.", { reply_markup: MENU_KEYBOARD });
  return cmdHelp(env, chatId);
}

// ─── Callbacks ──────────────────────────────────────────────────────────────

function decisionLabel(prefix, action, code) {
  if (action === "x") return `❌ Exclu (${code} · ${EXCLUSION_LABELS[code] || "motif"})`;
  if (prefix === "d") return "⭐ Inclus dans la revue";
  if (prefix === "f") return "✅ Éligible (texte intégral)";
  return { i: "✅ Gardé", u: "🤔 Marqué incertain", l: "⏭ Reporté" }[action] || "Enregistré";
}

async function recordPaperDecision(env, callback, prefix, action, key, code = null) {
  const chatId = callback.message.chat.id;
  const messageId = callback.message.message_id;
  let event;
  if (prefix === "d") {
    event = { type: "final", key, decision: action === "k" ? "keep" : "reject", code: action === "x" ? code : null };
  } else {
    const decision = { i: "include", x: "exclude", u: "uncertain", l: "later" }[action];
    event = { type: "screen", key, decision, code: action === "x" ? code : null };
  }
  await queueEvent(env, event);
  await remember(env, "recent:decided", key, DECIDED_TTL);
  const label = decisionLabel(prefix, action === "k" ? "i" : action, code);
  await answer(env, callback.id, `${label}. Appliqué au prochain passage des agents.`);
  const original = callback.message.text ? esc(cut(callback.message.text, 3000)) : "";
  await edit(env, chatId, messageId, `${original}\n\n<b>${label}</b> — sera appliqué au prochain passage des agents.`, {
    reply_markup: { inline_keyboard: [] },
  });
  await sendNextPaper(env, chatId, { skipKey: key });
}

async function handleCallback(env, callback) {
  const chatId = callback.message?.chat?.id;
  const messageId = callback.message?.message_id;
  const data = String(callback.data || "");
  const parts = data.split(":");

  // Menu shortcuts
  if (parts[0] === "m") {
    await answer(env, callback.id);
    return runCommand(env, chatId, `/${parts[1]}`);
  }

  // Paper decisions: s (title/abstract or veille), f (full text), d (final)
  if (["s", "f", "d"].includes(parts[0])) {
    const [prefix, action, key, code] = parts;
    if (action === "n") {
      await answer(env, callback.id, "Article suivant");
      await editButtons(env, chatId, messageId, { inline_keyboard: [] });
      return sendNextPaper(env, chatId, { skipKey: key });
    }
    if (action === "x" && !code) {
      await answer(env, callback.id, "Choisis le motif d'exclusion");
      return editButtons(env, chatId, messageId, codeButtons(prefix, key));
    }
    if (action === "x" && !(CODES_BY_STAGE[prefix] || []).includes(code)) {
      return answer(env, callback.id, "Motif non autorisé à cette étape", true);
    }
    if (action === "a") {
      const item = findItem(await botData(env), key);
      if (!item?.ai) return answer(env, callback.id, "Pas de suggestion IA pour cet article", true);
      const ai = item.ai;
      if (ai.decision === "exclude" && CODES_BY_STAGE.s.includes(ai.code)) {
        return recordPaperDecision(env, callback, "s", "x", key, ai.code);
      }
      return recordPaperDecision(env, callback, "s", ai.decision === "include" ? "i" : "u", key);
    }
    if (["i", "x", "u", "l", "k"].includes(action)) {
      return recordPaperDecision(env, callback, prefix, action, key, code || null);
    }
    return answer(env, callback.id, "Action inconnue");
  }

  // Back from exclusion codes to the decision buttons
  if (parts[0] === "c") {
    const [, prefix, key] = parts;
    const botState = await botData(env);
    const item = findItem(botState, key) || { key, stage: prefix === "f" ? "ft" : prefix === "d" ? "final" : "veille" };
    await answer(env, callback.id);
    return editButtons(env, chatId, messageId, paperButtons(item, botState || {}, env));
  }

  // Ask the reader agent to read a paper first
  if (parts[0] === "r" && parts.length === 2) {
    await queueEvent(env, { type: "read", key: parts[1] });
    await answer(env, callback.id, "📖 Ajouté en tête de la file de lecture des agents");
    return send(env, chatId, "📖 C'est noté : l'agent lecteur lira cet article en priorité au prochain passage et je t'enverrai sa fiche.");
  }

  // Writing steps
  if (parts[0] === "r" && parts[1] === "s") {
    await answer(env, callback.id);
    return cmdRedaction(env, chatId, parts[2]);
  }

  // Vocabulary: show answer, then grade
  if (parts[0] === "w") {
    const botState = await botData(env);
    const word = (botState?.vocabulary || []).find((item) => hashTerm(item.term) === parts[2]);
    if (!word) return answer(env, callback.id, "Mot introuvable (liste mise à jour)", true);
    if (parts[1] === "s") {
      await answer(env, callback.id);
      // English definition and example, each followed by its French version.
      const lines = [`🇬🇧 <b>${esc(word.term)}</b> = <b>${esc(word.fr)}</b>`, "", `🇬🇧 ${esc(word.def)}`];
      if (word.defFr) lines.push(`🇫🇷 ${esc(word.defFr)}`);
      if ((word.syn || []).length) lines.push(`Synonymes : ${esc(word.syn.join(", "))}`);
      lines.push("", `🇬🇧 <i>« ${esc(word.ex)} »</i>`);
      if (word.exFr) lines.push(`🇫🇷 <i>« ${esc(word.exFr)} »</i>`);
      lines.push("", "Tu le savais ?");
      return edit(
        env,
        chatId,
        messageId,
        lines.join("\n"),
        {
          reply_markup: {
            inline_keyboard: [
              [
                { text: "😕 Oublié", callback_data: `w:q:${parts[2]}:1` },
                { text: "😐 Difficile", callback_data: `w:q:${parts[2]}:3` },
              ],
              [
                { text: "🙂 Bien", callback_data: `w:q:${parts[2]}:4` },
                { text: "😎 Facile", callback_data: `w:q:${parts[2]}:5` },
              ],
            ],
          },
        },
      );
    }
    if (parts[1] === "q") {
      const quality = Number.parseInt(parts[3], 10);
      await queueEvent(env, { type: "vocab", term: word.term, quality });
      await remember(env, "recent:vocab", parts[2], VOCAB_TTL);
      const next = quality >= 4 ? "Je te le redemanderai dans quelques jours." : "Je te le redemanderai bientôt.";
      await answer(env, callback.id, "Noté ✅");
      return editButtons(env, chatId, messageId, { inline_keyboard: [[{ text: `✔︎ ${next}`, callback_data: "noop" }]] });
    }
  }

  // Lessons
  if (parts[0] === "l") {
    await answer(env, callback.id);
    const state = await learnState(env);
    if (parts[1] === "n") return cmdApprendre(env, chatId, { index: (state.current || 0) + 1 });
    if (parts[1] === "p") return cmdApprendre(env, chatId, { index: (state.current || 0) - 1 });
    if (parts[1] === "m") return cmdModules(env, chatId);
    if (parts[1] === "o") {
      const learning = await loadData(env, "learning.json");
      const lessons = flattenLessons(learning);
      const done = new Set(state.done || []);
      const inModule = lessons.map((lesson, index) => ({ lesson, index })).filter(({ lesson }) => lesson.module.id === parts[2]);
      const target = inModule.find(({ lesson }) => !done.has(lesson.id)) || inModule[0];
      return cmdApprendre(env, chatId, { index: target ? target.index : 0 });
    }
  }

  // Quiz
  if (parts[0] === "q") {
    if (parts.length === 2) {
      await answer(env, callback.id);
      return sendQuiz(env, chatId, parts[1]);
    }
    const learning = await loadData(env, "learning.json");
    const lessons = flattenLessons(learning);
    const index = lessons.findIndex((lesson) => lesson.id === parts[1]);
    const lesson = lessons[index];
    if (!lesson?.quiz) return answer(env, callback.id, "Quiz introuvable", true);
    const choice = Number.parseInt(parts[2], 10);
    const correct = choice === lesson.quiz.answer;
    const state = await learnState(env);
    if (correct) {
      const done = Array.from(new Set([...(state.done || []), lesson.id]));
      const current = index === state.current ? Math.min(index + 1, lessons.length - 1) : state.current;
      await kvPut(env, "learn:state", { ...state, done, current });
    }
    await answer(env, callback.id, correct ? "✅ Bonne réponse !" : "❌ Pas tout à fait");
    const right = lesson.quiz.options[lesson.quiz.answer];
    await edit(
      env,
      chatId,
      messageId,
      `📝 <b>${esc(lesson.quiz.question)}</b>\n\n${correct ? "✅ <b>Bravo !</b>" : `❌ La bonne réponse était : <b>${esc(right)}</b>`}\n${esc(lesson.quiz.explain || "")}`,
      {
        reply_markup: {
          inline_keyboard: correct
            ? [[{ text: "⏭ Leçon suivante", callback_data: "m:apprendre" }]]
            : [[{ text: "🔁 Réessayer", callback_data: `q:${lesson.id}` }, { text: "📖 Relire la leçon", callback_data: "m:apprendre" }]],
        },
      },
    );
    return null;
  }

  // News filters (edit the list in place)
  if (parts[0] === "n") {
    const kind = KIND_FILTERS.some(([value]) => value === parts[1]) ? parts[1] : "all";
    await answer(env, callback.id);
    const fromNews = String(callback.message?.text || "").startsWith("📰 Actus sécurité IA ·");
    return cmdActus(env, chatId, kind, fromNews ? messageId : null);
  }

  // Thesis reading plan: tick a part as read
  if (parts[0] === "t" && parts[1]) {
    const done = new Set(await kvGet(env, "these:done", []));
    if (done.has(parts[1])) done.delete(parts[1]);
    else done.add(parts[1]);
    await kvPut(env, "these:done", [...done]);
    await answer(env, callback.id, done.has(parts[1]) ? "✅ Partie lue" : "Partie à relire");
    return cmdThese(env, chatId, messageId);
  }

  // Settings toggles
  if (parts[0] === "set") {
    const settings = await getSettings(env);
    if (parts[1] === "pause") {
      settings.pausedUntil = isPaused(settings) ? null : new Date(Date.now() + 24 * 3600 * 1000).toISOString();
    } else if (parts[1] in DEFAULT_SETTINGS) {
      settings[parts[1]] = !settings[parts[1]];
    }
    await kvPut(env, "settings", settings);
    await answer(env, callback.id, "Réglage enregistré");
    const fromSettings = String(callback.message?.text || "").startsWith("⚙️");
    return cmdSettings(env, chatId, fromSettings ? messageId : null);
  }

  return answer(env, callback.id, data === "noop" ? "" : "Action inconnue");
}

// ─── Scheduled pushes ───────────────────────────────────────────────────────

const ENGLISH_BREAK = "🇬🇧 <b>Pause anglais</b> (1 minute) — devine le sens, puis touche « Voir la réponse ».";

async function deliverSlot(env, chatId, slot, nowMs) {
  if (slot === "morning") {
    return cmdToday(env, chatId, { greeting: "☀️ <b>Bonjour !</b> Voici ta journée PFE." });
  }
  if (slot === "english1" || slot === "english2") return cmdAnglais(env, chatId, 2, { intro: ENGLISH_BREAK });
  if (slot === "midday") {
    const data = await botData(env);
    const { item } = data ? await nextPaper(env, data) : { item: null };
    if (item) {
      return sendNextPaper(env, chatId, { intro: "🕐 <b>Session de tri (5 minutes)</b>\nDécide article par article ; l'IA te donne son avis.\n\n" });
    }
    return cmdEncadrant(env, chatId);
  }
  if (slot === "news") return newsDigest(env, chatId, nowMs);
  if (slot === "evening") {
    const learning = await loadData(env, "learning.json");
    const lessons = flattenLessons(learning);
    const state = await learnState(env);
    const lesson = lessons[Math.min(state.current || 0, Math.max(lessons.length - 1, 0))];
    await send(env, chatId, "🌙 <b>Bilan du soir</b> — 5 minutes pour ancrer ce que tu as vu aujourd'hui.");
    if (lesson && !(state.done || []).includes(lesson.id)) await sendQuiz(env, chatId, lesson.id);
    return cmdAnglais(env, chatId, 3);
  }
  return null;
}

/** Send one slot of SCHEDULE, at most once per day. Returns true when sent. */
async function scheduledPush(env, slot, { nowMs = Date.now(), chatId = null, settings = null } = {}) {
  const entry = SCHEDULE.find((item) => item.slot === slot);
  if (!entry) return false;
  const chat = chatId ?? (await getChat(env));
  if (!chat) return false;
  const config = settings ?? (await getSettings(env));
  if (isPaused(config, nowMs) || !config[entry.setting]) return false;
  const sentKey = `sent:${slot}:${todayKey(nowMs)}`;
  if (await kvGet(env, sentKey, null)) return false;
  // Mark first: a failing Telegram call must not repeat the push every 30 minutes.
  await kvPut(env, sentKey, true, 36 * 3600);
  await deliverSlot(env, chat, slot, nowMs);
  return true;
}

/** Cron tick (every 30 minutes): due slots, then alerts held during the night. */
async function tick(env, nowMs = Date.now()) {
  const minutes = localMinutes(nowMs);
  const due = SCHEDULE.filter((entry) => minutes >= entry.at && minutes < entry.at + CATCH_UP_MINUTES);
  const quiet = isQuiet(minutes);
  if (!due.length && quiet) return [];
  const chatId = await getChat(env);
  if (!chatId) return [];
  const settings = await getSettings(env);
  const sent = [];
  if (!quiet && (await flushAlerts(env, { chatId, settings, nowMs }))) sent.push("alerts");
  for (const entry of due) {
    if (await scheduledPush(env, entry.slot, { nowMs, chatId, settings })) sent.push(entry.slot);
  }
  return sent;
}

// ─── Pipeline API (GitHub Actions) ──────────────────────────────────────────

function authorizedPipeline(request, env) {
  const header = request.headers.get("Authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  const secret = pipelineSecret(env);
  return secret.length >= 8 && safeEqual(token, secret);
}

async function apiEvents(env) {
  const names = await listKeys(env, "evt:");
  const events = [];
  for (const name of names) {
    const value = await kvGet(env, name, null);
    if (value) events.push(value);
  }
  return json({ events });
}

async function apiAck(request, env) {
  const body = await request.json().catch(() => ({}));
  const ids = Array.isArray(body.ids) ? body.ids.filter((id) => typeof id === "string").slice(0, 1000) : [];
  await Promise.all(ids.map((id) => env.PFE_STATE.delete(`evt:${id}`)));
  return json({ deleted: ids.length });
}

async function apiPipeline(request, env) {
  const summary = await request.json().catch(() => null);
  if (!summary || typeof summary !== "object") return json({ ok: false }, 400);
  const alerts = (Array.isArray(summary.alerts) ? summary.alerts : [])
    .filter((alert) => alert && typeof alert.key === "string" && alert.key && alert.title)
    .slice(0, 10);
  await kvPut(env, "pipeline:last", { ...summary, alerts: alerts.length });
  memoryCache.clear(); // the site was just redeployed
  const chatId = await getChat(env);
  const settings = await getSettings(env);
  let alerted = false;
  if (alerts.length && (await queueAlerts(env, alerts)) && !isQuiet(localMinutes())) {
    alerted = await flushAlerts(env, { chatId, settings });
  }
  if (!chatId || !settings.agents || summary.light) return json({ ok: true, notified: false, alerted });
  const sheets = Array.isArray(summary.sheets) ? summary.sheets : [];
  const site = siteUrl(env);
  const lines = [];
  if (sheets.length || summary.synthesis) {
    lines.push("🤖 <b>Les agents ont fini leur passage</b>");
    if (summary.newPapers) lines.push(`🆕 ${summary.newPapers} nouvel(s) article(s) collecté(s)`);
    if (summary.suggestions) lines.push(`🔍 ${summary.suggestions} article(s) pré-trié(s) par l'IA`);
    for (const sheet of sheets.slice(0, 5)) {
      lines.push(`📘 Nouvelle fiche : <a href="${esc(site)}/#fiches/${esc(sheet.key)}">${esc(cut(sheet.title, 90))}</a>`);
    }
    if (summary.synthesis) lines.push(`🧩 Comparatif et état de l'art mis à jour : <a href="${esc(site)}/#comparatif">voir</a>`);
  }
  const today = todayKey();
  if (summary.agentsSkipped && !(await kvGet(env, `notified:skip:${today}`, null))) {
    lines.push(
      lines.length ? "" : "🤖 <b>Passage du pipeline terminé</b>",
      `🆕 ${summary.newPapers || 0} nouvel(s) article(s) collecté(s).`,
      "⚠️ Les agents IA (tri, lecture, synthèse) attendent la clé Gemini dans les secrets GitHub.",
      "Sur ton PC, dans le dossier du projet, lance une seule fois :",
      "<code>powershell -ExecutionPolicy Bypass -File scripts\\setup-secrets.ps1</code>",
    );
    await kvPut(env, `notified:skip:${today}`, true, 36 * 3600);
  }
  if (summary.agentErrors && !(await kvGet(env, `notified:err:${today}`, null))) {
    lines.push(`⚠️ ${summary.agentErrors} tâche(s) d'agent en erreur — je réessaierai au prochain passage.`);
    await kvPut(env, `notified:err:${today}`, true, 36 * 3600);
  }
  if (!lines.length) return json({ ok: true, notified: false, alerted });
  await send(env, chatId, lines.filter((line) => line !== undefined).join("\n"), {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "📄 Fiches", callback_data: "m:fiches" },
          { text: "📥 Trier", callback_data: "m:tri" },
        ],
      ],
    },
  });
  return json({ ok: true, notified: true, alerted });
}

async function setup(request, env) {
  const url = new URL(request.url);
  const webhook = `${url.origin}/webhook`;
  const result = await tg(env, "setWebhook", {
    url: webhook,
    secret_token: webhookSecret(env) || undefined,
    allowed_updates: ["message", "callback_query"],
  });
  await tg(env, "setMyCommands", {
    commands: BOT_COMMANDS.map(([command, description]) => ({ command, description })),
    language_code: "",
  });
  await tg(env, "setChatMenuButton", { menu_button: { type: "commands" } });
  return json({ ok: true, webhook, result, commands: BOT_COMMANDS.length, version: VERSION });
}

// ─── Update routing ─────────────────────────────────────────────────────────

async function processUpdate(env, update) {
  if (!env.TELEGRAM_BOT_TOKEN) return;
  const authorized = await getChat(env);

  if (update.callback_query) {
    const callback = update.callback_query;
    const chatId = callback.message?.chat?.id;
    if (!chatId || authorized !== chatId) return answer(env, callback.id, "🔒 Non autorisé", true);
    try {
      await handleCallback(env, callback);
    } catch (error) {
      console.error("callback error", error);
      await answer(env, callback.id, "⚠️ Erreur, réessaie dans un instant", true);
      await send(env, chatId, `⚠️ Petite erreur technique : <code>${esc(cut(error.message, 200))}</code>\nRéessaie, ou utilise /menu.`).catch(() => null);
    }
    return;
  }

  const message = update.message;
  if (!message || message.chat?.type !== "private") return;
  const chatId = message.chat.id;
  const text = String(message.text || "").trim();
  if (!text) return;

  if (text.startsWith("/start")) return handleStart(env, chatId, text);
  if (authorized === null || authorized !== chatId) {
    return send(env, chatId, "🔒 Bot privé. Envoie <code>/start TON_CODE</code> pour t'associer.");
  }

  let command;
  let args = "";
  if (text.startsWith("/")) {
    const first = text.split(/\s+/)[0].toLowerCase().replace(/@\w+$/, "");
    command = COMMAND_ALIASES[first] || first;
    args = text.slice(text.split(/\s+/)[0].length).trim();
  } else {
    command = TEXT_ALIASES[text.toLowerCase()] || null;
    if (!command) {
      // Free text: treat it as a library search, the most useful default.
      return text.length >= 3 ? cmdSearch(env, chatId, text) : runCommand(env, chatId, "/menu");
    }
  }
  try {
    await runCommand(env, chatId, command, args);
  } catch (error) {
    console.error("command error", error);
    await send(env, chatId, `⚠️ Petite erreur technique : <code>${esc(cut(error.message, 200))}</code>\nRéessaie, ou utilise /menu.`).catch(() => null);
  }
}

// ─── Entry points ───────────────────────────────────────────────────────────

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/" || url.pathname === "/health") {
      return json({
        ok: true,
        bot: BOT_HANDLE,
        version: VERSION,
        schedule: SCHEDULE.map((entry) => `${hhmm(entry.at)} ${entry.slot}`),
      });
    }

    if (url.pathname === "/webhook" && request.method === "POST") {
      const expected = webhookSecret(env);
      if (expected && !safeEqual(request.headers.get("X-Telegram-Bot-Api-Secret-Token"), expected)) {
        return new Response("Unauthorized", { status: 403 });
      }
      const update = await request.json().catch(() => null);
      if (update) ctx.waitUntil(processUpdate(env, update).catch((error) => console.error("update error", error)));
      return new Response("OK"); // always acknowledge quickly to Telegram
    }

    if (url.pathname.startsWith("/reader/")) return handleReader(request, env, url);

    if (url.pathname.startsWith("/api/")) {
      if (!authorizedPipeline(request, env)) return json({ ok: false, error: "unauthorized" }, 403);
      if (url.pathname === "/api/events" && request.method === "GET") return apiEvents(env);
      if (url.pathname === "/api/events/ack" && request.method === "POST") return apiAck(request, env);
      if (url.pathname === "/api/pipeline" && request.method === "POST") return apiPipeline(request, env);
      if (url.pathname === "/api/translations/state" && request.method === "GET") return apiTranslationsState(env);
      if (url.pathname === "/api/translations/missing" && request.method === "POST") return apiTranslationsMissing(request, env);
      if (url.pathname === "/api/translations" && request.method === "POST") return apiTranslationsStore(request, env);
      if (url.pathname === "/api/push" && request.method === "POST") {
        // Manual trigger of a scheduled slot, e.g. to test the morning briefing.
        const slot = url.searchParams.get("slot") || "morning";
        if (slot === "alerts") return json({ ok: true, slot, sent: await flushAlerts(env) });
        if (!SCHEDULE.some((entry) => entry.slot === slot)) return json({ ok: false, error: "unknown slot" }, 400);
        await env.PFE_STATE.delete(`sent:${slot}:${todayKey()}`);
        return json({ ok: true, slot, sent: await scheduledPush(env, slot) });
      }
      return json({ ok: false, error: "not found" }, 404);
    }

    if (url.pathname === "/setup" && request.method === "GET") {
      if (!env.TELEGRAM_BOT_TOKEN) return json({ ok: false, error: "no token" }, 500);
      const secret = pipelineSecret(env);
      if (secret && !safeEqual(url.searchParams.get("key"), secret)) {
        return json({ ok: false, error: "unauthorized" }, 403);
      }
      return setup(request, env);
    }

    return new Response("Not Found", { status: 404 });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(tick(env, event.scheduledTime ?? Date.now()).catch((error) => console.error("cron error", error)));
  },
};
