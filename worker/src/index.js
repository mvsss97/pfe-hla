/**
 * PFE Hard-Label NLP — Telegram bot (Cloudflare Worker)
 *
 * - Webhook  : commands, persistent menu keyboard and inline buttons. Every
 *              command and button answers, even when data is missing.
 * - Cron     : the bot writes first — morning briefing, midday triage session,
 *              evening review (see [triggers] in wrangler.toml).
 * - Pipeline : GitHub Actions pulls the decisions queued here (/api/events),
 *              acknowledges them once saved, and posts its run summary.
 *
 * Data comes from the static site (data/bot.json, data/learning.json).
 * Decisions are queued in KV and applied by the Python pipeline through the
 * audited PRISMA functions — the bot never edits the research database itself.
 *
 * Secrets: TELEGRAM_BOT_TOKEN, TELEGRAM_PAIRING_CODE, optional PIPELINE_SECRET
 *          (defaults to the pairing code, already shared with GitHub) and
 *          optional TELEGRAM_WEBHOOK_SECRET (overrides the BOT_WEBHOOK_SECRET var).
 * Vars: SITE_URL. KV binding: PFE_STATE.
 */

const VERSION = "2.0.0";
const DEFAULT_SITE = "https://pfe-hla.pages.dev";
const BOT_HANDLE = "PFE_MN_bot";
const DECIDED_TTL = 4 * 24 * 3600; // hide a decided paper until the pipeline syncs it
const VOCAB_TTL = 20 * 3600;
const CACHE_SECONDS = 120;

const CRON_SLOTS = {
  "30 7 * * *": "morning", // 08:30 Africa/Algiers (UTC+1, no DST)
  "30 12 * * *": "midday", // 13:30
  "0 19 * * *": "evening", // 20:00
};

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
    [{ text: "📊 PRISMA" }, { text: "✍️ Rédaction" }],
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
  ["prisma", "Compteurs PRISMA"],
  ["anglais", "3 mots d'anglais à réviser"],
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
};

// ─── Small utilities ────────────────────────────────────────────────────────

function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
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

function pipelineSecret(env) {
  return env.PIPELINE_SECRET || env.TELEGRAM_PAIRING_CODE || "";
}

function webhookSecret(env) {
  return env.TELEGRAM_WEBHOOK_SECRET || env.BOT_WEBHOOK_SECRET || "";
}

function algiersNow() {
  return new Date(Date.now() + 3600 * 1000); // UTC+1 all year
}

function todayKey() {
  return algiersNow().toISOString().slice(0, 10);
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

const DEFAULT_SETTINGS = { morning: true, midday: true, evening: true, agents: true, pausedUntil: null };

async function getSettings(env) {
  return { ...DEFAULT_SETTINGS, ...(await kvGet(env, "settings", {})) };
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

function paperText(item, data, position) {
  const lines = [
    `📄 <b>${esc(item.title)}</b>`,
    `${esc(item.year || "année ?")} · ${esc(cut(item.venue || "source ?", 80))}`,
    `🏷 ${STAGE_LABELS[item.stage] || "À trier"}${position ? ` · ${position}` : ""}`,
    "",
    item.abstract ? `<i>${esc(cut(item.abstract, 650))}</i>` : "<i>(résumé absent)</i>",
    "",
    aiLine(item.ai),
  ];
  if (item.url) lines.push(`🔗 <a href="${esc(item.url)}">Source</a>`);
  if (item.hasSheet) lines.push(`📘 <a href="${esc(data.site || "")}/#fiches/${esc(item.key)}">Fiche de lecture IA</a>`);
  return lines.join("\n");
}

function paperButtons(item, data) {
  const key = item.key;
  const sheetUrl = `${data.site || DEFAULT_SITE}/#fiches/${key}`;
  if (item.stage === "ft") {
    return {
      inline_keyboard: [
        [
          { text: "✅ Éligible", callback_data: `f:i:${key}` },
          { text: "❌ Exclure…", callback_data: `f:x:${key}` },
        ],
        [{ text: "📘 Lire la fiche", url: sheetUrl }, { text: "➡️ Suivant", callback_data: `s:n:${key}` }],
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
  extra.push({ text: "📖 Lire en priorité", callback_data: `r:${key}` });
  rows.push(extra);
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
  return send(env, chatId, text, { reply_markup: paperButtons(item, data) });
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
      "Je t'écris moi-même 3 fois par jour (08:30, 13:30, 20:00) et après chaque passage des agents IA.\n" +
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
          { text: "📊 PRISMA", callback_data: "m:prisma" },
          { text: "✍️ Rédaction", callback_data: "m:redaction" },
        ],
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
    `📄 <b>Fiches de lecture (${sheets.length})</b>\n✓ = phrase retrouvée mot pour mot dans le PDF, ≈ = valeur seule, ✗ = introuvable (à vérifier).\n\n${lines.join("\n\n")}`,
    { reply_markup: { inline_keyboard: [[{ text: "🌐 Toutes les fiches + comparatif", url: `${siteUrl(env)}/#fiches` }]] } },
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

async function cmdAnglais(env, chatId, count = 3) {
  const data = await botData(env);
  if (!data || !(data.vocabulary || []).length) {
    return send(env, chatId, "🇬🇧 Pas de vocabulaire disponible pour le moment.");
  }
  const reviewed = new Set(Object.keys(await recentMap(env, "recent:vocab")));
  const now = new Date().toISOString();
  const pool = data.vocabulary.filter((word) => !reviewed.has(hashTerm(word.term)));
  let selection = pool
    .filter((word) => !word.due || word.due <= now)
    .sort((a, b) => String(a.due).localeCompare(String(b.due)) || (a.reps || 0) - (b.reps || 0))
    .slice(0, count);
  let intro = "🇬🇧 <b>Mots à réviser aujourd'hui</b> (répétition espacée)";
  if (!selection.length) {
    selection = [...pool].sort(() => Math.random() - 0.5).slice(0, count);
    intro = "🇬🇧 <b>Révision libre</b> — aucun mot n'est dû aujourd'hui, bravo !";
  }
  if (!selection.length) return send(env, chatId, "🇬🇧 Tous les mots ont été révisés récemment. Reviens demain !");
  await send(env, chatId, intro);
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
    "🤖 <b>Agents IA (Gemini gratuit, 2 passages par jour dans GitHub Actions)</b>",
    "",
    "• <b>Collecteur</b> : cherche les nouveaux articles (OpenAlex + arXiv)",
    "• <b>Trieur</b> : pré-trie titres/résumés selon tes critères PRISMA",
    "• <b>Lecteur</b> : télécharge le PDF, le lit en entier, écrit une fiche et vérifie ses citations",
    "• <b>Synthèse</b> : compare les fiches et prépare l'état de l'art",
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
  const paused = settings.pausedUntil && settings.pausedUntil > new Date().toISOString();
  const text = `⚙️ <b>Notifications automatiques</b>${paused ? `\n⏸ En pause jusqu'au ${esc(settings.pausedUntil.slice(0, 10))}` : ""}\nTouche pour activer/désactiver :`;
  const markup = {
    inline_keyboard: [
      [{ text: `${mark(settings.morning)} Matin 08:30 (plan + leçon)`, callback_data: "set:morning" }],
      [{ text: `${mark(settings.midday)} Midi 13:30 (session de tri)`, callback_data: "set:midday" }],
      [{ text: `${mark(settings.evening)} Soir 20:00 (quiz + mots)`, callback_data: "set:evening" }],
      [{ text: `${mark(settings.agents)} Rapports des agents IA`, callback_data: "set:agents" }],
      [{ text: paused ? "▶️ Reprendre maintenant" : "⏸ Pause 24 h", callback_data: "set:pause" }],
    ],
  };
  if (messageId) return edit(env, chatId, messageId, text, { reply_markup: markup });
  return send(env, chatId, text, { reply_markup: markup });
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
  const lines = [
    greeting,
    `Semaine ${week}/16${entry ? ` — ${esc(entry.goal)}` : ""}`,
    "",
    news.papers || news.sheets
      ? `🆕 Dernières 24 h : ${news.papers || 0} nouvel(s) article(s), ${news.sheets || 0} nouvelle(s) fiche(s).`
      : "🆕 Pas de nouveauté des agents depuis hier.",
    `📥 ${pending} article(s) attendent ton tri.`,
    lesson ? `🧠 Leçon du jour : <b>${esc(lesson.title)}</b>` : "",
    `🇬🇧 ${dueWords} mot(s) à réviser.`,
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
        [{ text: "🗓 Plan de la semaine", callback_data: "m:plan" }],
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
    return editButtons(env, chatId, messageId, paperButtons(item, botState || {}));
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
      const synonyms = (word.syn || []).length ? `\nSynonymes : ${esc(word.syn.join(", "))}` : "";
      return edit(
        env,
        chatId,
        messageId,
        `🇬🇧 <b>${esc(word.term)}</b> = <b>${esc(word.fr)}</b>\n${esc(word.def)}${synonyms}\n<i>« ${esc(word.ex)} »</i>\n\nTu le savais ?`,
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

  // Settings toggles
  if (parts[0] === "set") {
    const settings = await getSettings(env);
    if (parts[1] === "pause") {
      const paused = settings.pausedUntil && settings.pausedUntil > new Date().toISOString();
      settings.pausedUntil = paused ? null : new Date(Date.now() + 24 * 3600 * 1000).toISOString();
    } else if (parts[1] in DEFAULT_SETTINGS) {
      settings[parts[1]] = !settings[parts[1]];
    }
    await kvPut(env, "settings", settings);
    await answer(env, callback.id, "Réglage enregistré");
    return cmdSettings(env, chatId, messageId);
  }

  return answer(env, callback.id, data === "noop" ? "" : "Action inconnue");
}

// ─── Scheduled pushes ───────────────────────────────────────────────────────

async function scheduledPush(env, slot) {
  const chatId = await getChat(env);
  if (!chatId) return;
  const settings = await getSettings(env);
  if (settings.pausedUntil && settings.pausedUntil > new Date().toISOString()) return;
  const sentKey = `sent:${slot}:${todayKey()}`;
  if (await kvGet(env, sentKey, null)) return; // never twice per slot and day
  if (slot === "morning" && settings.morning) {
    await cmdToday(env, chatId, { greeting: "☀️ <b>Bonjour !</b> Voici ta journée PFE." });
  } else if (slot === "midday" && settings.midday) {
    const data = await botData(env);
    const { item } = data ? await nextPaper(env, data) : { item: null };
    if (item) {
      await sendNextPaper(env, chatId, { intro: "🕐 <b>Session de tri (5 minutes)</b>\nDécide article par article ; l'IA te donne son avis.\n\n" });
    } else {
      await cmdAnglais(env, chatId, 2);
    }
  } else if (slot === "evening" && settings.evening) {
    const learning = await loadData(env, "learning.json");
    const lessons = flattenLessons(learning);
    const state = await learnState(env);
    const lesson = lessons[Math.min(state.current || 0, Math.max(lessons.length - 1, 0))];
    await send(env, chatId, "🌙 <b>Bilan du soir</b> — 5 minutes pour ancrer ce que tu as vu aujourd'hui.");
    if (lesson && !(state.done || []).includes(lesson.id)) await sendQuiz(env, chatId, lesson.id);
    await cmdAnglais(env, chatId, 3);
  } else {
    return;
  }
  await kvPut(env, sentKey, true, 36 * 3600);
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
  await kvPut(env, "pipeline:last", summary);
  memoryCache.clear(); // the site was just redeployed
  const chatId = await getChat(env);
  const settings = await getSettings(env);
  if (!chatId || !settings.agents) return json({ ok: true, notified: false });
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
  if (!lines.length) return json({ ok: true, notified: false });
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
  return json({ ok: true, notified: true });
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
      return json({ ok: true, bot: BOT_HANDLE, version: VERSION, crons: Object.keys(CRON_SLOTS) });
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

    if (url.pathname.startsWith("/api/")) {
      if (!authorizedPipeline(request, env)) return json({ ok: false, error: "unauthorized" }, 403);
      if (url.pathname === "/api/events" && request.method === "GET") return apiEvents(env);
      if (url.pathname === "/api/events/ack" && request.method === "POST") return apiAck(request, env);
      if (url.pathname === "/api/pipeline" && request.method === "POST") return apiPipeline(request, env);
      if (url.pathname === "/api/push" && request.method === "POST") {
        // Manual trigger of a scheduled slot, e.g. to test the morning briefing.
        const slot = url.searchParams.get("slot") || "morning";
        await env.PFE_STATE.delete(`sent:${slot}:${todayKey()}`);
        await scheduledPush(env, slot);
        return json({ ok: true, slot });
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
    const slot = CRON_SLOTS[event.cron];
    if (slot) ctx.waitUntil(scheduledPush(env, slot).catch((error) => console.error("cron error", error)));
  },
};
