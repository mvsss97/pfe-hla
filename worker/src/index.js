/**
 * PFE Hard-Label NLP — Telegram Bot Webhook (Cloudflare Worker)
 *
 * Ce worker reçoit les updates Telegram via webhook et répond aux commandes.
 * Il lit les données du dashboard depuis le site statique Cloudflare Pages.
 * Le state (chat_id autorisé) est stocké dans Cloudflare KV.
 *
 * Variables d'environnement (secrets Cloudflare) :
 *   TELEGRAM_BOT_TOKEN   — le token du bot
 *   TELEGRAM_PAIRING_CODE — code d'association unique
 *   BOT_WEBHOOK_SECRET   — secret pour vérifier l'authenticité des requêtes
 *   SITE_URL             — URL du dashboard Cloudflare Pages
 */

// ─── Telegram API helpers ───────────────────────────────────────────────────

async function tg(token, method, body = {}) {
  const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await r.json();
  if (!data.ok) throw new Error(`Telegram ${method}: ${data.description}`);
  return data.result;
}

function sendMessage(token, chatId, text, options = {}) {
  return tg(token, "sendMessage", {
    chat_id: chatId,
    text: text.slice(0, 4096),
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...options,
  });
}

function answerCallback(token, callbackId, text) {
  return tg(token, "answerCallbackQuery", {
    callback_query_id: callbackId,
    text: text.slice(0, 200),
  });
}

// ─── State helpers (KV) ─────────────────────────────────────────────────────

async function getAuthorizedChat(env) {
  if (!env.PFE_STATE) return null;
  const val = await env.PFE_STATE.get("authorized_chat_id");
  return val ? parseInt(val, 10) : null;
}

async function setAuthorizedChat(env, chatId) {
  if (!env.PFE_STATE) return;
  await env.PFE_STATE.put("authorized_chat_id", String(chatId));
}

// ─── Dashboard data fetch ───────────────────────────────────────────────────

async function fetchDashboardState(siteUrl) {
  try {
    const r = await fetch(`${siteUrl}/data/state.json`, {
      headers: { "User-Agent": "PFE-HLA-Bot/1.0" },
    });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

// ─── Command handlers ───────────────────────────────────────────────────────

async function handleStart(env, chatId, text) {
  const token = env.TELEGRAM_BOT_TOKEN;
  const existingChat = await getAuthorizedChat(env);

  if (existingChat) {
    if (existingChat === chatId) {
      await sendMessage(token, chatId,
        "✅ Tu es déjà associé. Utilise /help pour voir les commandes.");
    } else {
      await sendMessage(token, chatId, "⛔ Ce bot est déjà associé à un autre compte.");
    }
    return;
  }

  // Try pairing
  const parts = text.trim().split(/\s+/);
  const supplied = parts.length > 1 ? parts.slice(1).join(" ") : "";
  const expected = env.TELEGRAM_PAIRING_CODE || "";

  if (!expected || expected.length < 8 || !supplied || supplied !== expected) {
    await sendMessage(token, chatId,
      "🔑 Envoie <code>/start TON_CODE</code> pour associer ce bot à ton compte.");
    return;
  }

  await setAuthorizedChat(env, chatId);
  await sendMessage(token, chatId,
    "✅ Appareil associé avec succès !\n\n" +
    "Supprime maintenant le message avec le code.\n" +
    "Utilise /help pour voir les commandes disponibles.");
}

async function handleHelp(env, chatId) {
  await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId,
    "📚 <b>Commandes disponibles</b>\n\n" +
    "/today — résumé du jour\n" +
    "/papers — articles en attente de screening\n" +
    "/stats — compteurs PRISMA\n" +
    "/words — mots d'anglais du jour\n" +
    "/search <i>terme</i> — chercher dans les articles\n" +
    "/site — lien vers le dashboard\n" +
    "/help — cette aide");
}

async function handleToday(env, chatId) {
  const token = env.TELEGRAM_BOT_TOKEN;
  const state = await fetchDashboardState(env.SITE_URL || "https://pfe-hla.pages.dev");

  if (!state) {
    await sendMessage(token, chatId, "⚠️ Impossible de charger les données du dashboard.");
    return;
  }

  const p = state.prisma || {};
  const papers = state.papers || [];
  const pending = papers.filter(pp => pp.status === "identified").length;
  const included = papers.filter(pp => pp.status === "included").length;

  let text = "📊 <b>Résumé du jour</b>\n\n";
  text += `📄 Articles en base : <b>${papers.length}</b>\n`;
  text += `🔍 À screener : <b>${pending}</b>\n`;
  text += `✅ Inclus : <b>${included}</b>\n`;
  if (p.identified !== undefined) text += `📥 Identifiés (PRISMA) : <b>${p.identified}</b>\n`;
  if (p.duplicates_removed !== undefined) text += `🔄 Doublons retirés : <b>${p.duplicates_removed}</b>\n`;

  const experiments = state.experiments || [];
  if (experiments.length > 0) {
    text += `\n🧪 Expériences : <b>${experiments.length}</b>\n`;
  }

  text += `\n🌐 <a href="${env.SITE_URL || "https://pfe-hla.pages.dev"}">Voir le dashboard</a>`;

  await sendMessage(token, chatId, text);
}

async function handlePapers(env, chatId) {
  const token = env.TELEGRAM_BOT_TOKEN;
  const state = await fetchDashboardState(env.SITE_URL || "https://pfe-hla.pages.dev");

  if (!state) {
    await sendMessage(token, chatId, "⚠️ Données indisponibles.");
    return;
  }

  const pending = (state.papers || [])
    .filter(p => p.status === "identified")
    .slice(0, 10);

  if (pending.length === 0) {
    await sendMessage(token, chatId, "🎉 Aucun article en attente de screening !");
    return;
  }

  let text = `📄 <b>${pending.length} articles à screener</b> (10 premiers) :\n\n`;
  for (const p of pending) {
    const year = p.year || "?";
    const title = (p.title || "Sans titre").slice(0, 80);
    text += `• [${year}] ${escapeHtml(title)}\n`;
  }
  text += `\n🌐 <a href="${env.SITE_URL || "https://pfe-hla.pages.dev"}">Screener sur le dashboard</a>`;

  await sendMessage(token, chatId, text);
}

async function handleStats(env, chatId) {
  const token = env.TELEGRAM_BOT_TOKEN;
  const state = await fetchDashboardState(env.SITE_URL || "https://pfe-hla.pages.dev");

  if (!state || !state.prisma) {
    await sendMessage(token, chatId, "⚠️ Données PRISMA indisponibles.");
    return;
  }

  const p = state.prisma;
  let text = "📊 <b>Compteurs PRISMA</b>\n\n";
  text += `📥 Identifiés : ${p.identified || 0}\n`;
  text += `🔄 Uniques : ${p.unique_records || 0}\n`;
  text += `🗑 Doublons retirés : ${p.duplicates_removed || 0}\n`;
  text += `🔍 Screenés : ${p.screened || 0}\n`;
  text += `❌ Exclus (titre/abstract) : ${p.excluded_title_abstract || 0}\n`;
  text += `📄 Rapports cherchés : ${p.reports_sought || 0}\n`;
  text += `✅ Inclus : ${p.included || 0}\n`;
  text += `⏳ En attente : ${p.pending_screening || 0}`;

  await sendMessage(token, chatId, text);
}

async function handleWords(env, chatId) {
  const token = env.TELEGRAM_BOT_TOKEN;
  const state = await fetchDashboardState(env.SITE_URL || "https://pfe-hla.pages.dev");

  if (!state || !state.vocabulary || state.vocabulary.length === 0) {
    await sendMessage(token, chatId, "📝 Pas de mots d'anglais disponibles pour le moment.");
    return;
  }

  // Pick 3 random words to review
  const words = state.vocabulary;
  const selected = [];
  const used = new Set();
  for (let i = 0; i < Math.min(3, words.length); i++) {
    let idx;
    do { idx = Math.floor(Math.random() * words.length); } while (used.has(idx) && used.size < words.length);
    used.add(idx);
    selected.push(words[idx]);
  }

  let text = "🇬🇧 <b>Mots du jour</b>\n\n";
  for (const w of selected) {
    text += `<b>${escapeHtml(w.term)}</b> — ${escapeHtml(w.translation || "")}\n`;
    if (w.definition) text += `<i>${escapeHtml(w.definition)}</i>\n`;
    if (w.synonyms) text += `Synonymes : ${escapeHtml(w.synonyms)}\n`;
    if (w.example) text += `Ex : « ${escapeHtml(w.example)} »\n`;
    text += "\n";
  }

  await sendMessage(token, chatId, text);
}

async function handleSearch(env, chatId, query) {
  const token = env.TELEGRAM_BOT_TOKEN;
  if (!query || query.trim().length < 2) {
    await sendMessage(token, chatId, "🔍 Utilise : /search <i>terme</i>");
    return;
  }

  const state = await fetchDashboardState(env.SITE_URL || "https://pfe-hla.pages.dev");
  if (!state) {
    await sendMessage(token, chatId, "⚠️ Données indisponibles.");
    return;
  }

  const q = query.toLowerCase().trim();
  const matches = (state.papers || []).filter(p => {
    const title = (p.title || "").toLowerCase();
    const abstract = (p.abstract || "").toLowerCase();
    return title.includes(q) || abstract.includes(q);
  }).slice(0, 8);

  if (matches.length === 0) {
    await sendMessage(token, chatId, `🔍 Aucun résultat pour « ${escapeHtml(query)} ».`);
    return;
  }

  let text = `🔍 <b>${matches.length} résultat(s) pour « ${escapeHtml(query)} »</b>\n\n`;
  for (const p of matches) {
    text += `• [${p.year || "?"}] ${escapeHtml((p.title || "").slice(0, 80))} — <i>${escapeHtml(p.status || "?")}</i>\n`;
  }

  await sendMessage(token, chatId, text);
}

async function handleSite(env, chatId) {
  const url = env.SITE_URL || "https://pfe-hla.pages.dev";
  await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId,
    `🌐 <a href="${url}">Ouvrir le dashboard PFE</a>`);
}

// ─── Utility ────────────────────────────────────────────────────────────────

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// ─── Main handler ───────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Health check
    if (url.pathname === "/" || url.pathname === "/health") {
      return new Response(JSON.stringify({ ok: true, bot: "pfe-hla" }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // Webhook endpoint
    if (url.pathname === "/webhook" && request.method === "POST") {
      // Verify secret token header
      const secretHeader = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
      if (env.BOT_WEBHOOK_SECRET && secretHeader !== env.BOT_WEBHOOK_SECRET) {
        return new Response("Unauthorized", { status: 403 });
      }

      try {
        const update = await request.json();
        await processUpdate(env, update);
      } catch (err) {
        console.error("Error processing update:", err);
      }

      // Always return 200 to Telegram
      return new Response("OK", { status: 200 });
    }

    // Setup webhook (one-time, call manually)
    if (url.pathname === "/setup" && request.method === "GET") {
      const token = env.TELEGRAM_BOT_TOKEN;
      if (!token) return new Response("No token configured", { status: 500 });

      const workerUrl = `${url.origin}/webhook`;
      const result = await tg(token, "setWebhook", {
        url: workerUrl,
        secret_token: env.BOT_WEBHOOK_SECRET || "",
        allowed_updates: ["message", "callback_query"],
      });

      return new Response(JSON.stringify({ ok: true, webhook: workerUrl, result }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response("Not Found", { status: 404 });
  },
};

async function processUpdate(env, update) {
  const token = env.TELEGRAM_BOT_TOKEN;
  if (!token) return;

  // Handle messages
  const message = update.message;
  if (message) {
    const chatId = message.chat.id;
    const text = message.text || "";
    const chatType = message.chat.type;

    // Only handle private messages
    if (chatType !== "private") return;

    // Check authorization
    const authorizedChat = await getAuthorizedChat(env);

    // /start is always handled (for pairing)
    if (text.startsWith("/start")) {
      await handleStart(env, chatId, text);
      return;
    }

    // All other commands require authorization
    if (authorizedChat === null || authorizedChat !== chatId) {
      await sendMessage(token, chatId,
        "🔒 Non autorisé. Utilise /start <i>code</i> pour t'associer.");
      return;
    }

    // Route commands
    const cmd = text.split(/\s+/)[0].toLowerCase().replace(/@\w+$/, "");
    const args = text.slice(cmd.length).trim();

    switch (cmd) {
      case "/help": await handleHelp(env, chatId); break;
      case "/today": await handleToday(env, chatId); break;
      case "/papers": await handlePapers(env, chatId); break;
      case "/stats": await handleStats(env, chatId); break;
      case "/words": await handleWords(env, chatId); break;
      case "/search": await handleSearch(env, chatId, args); break;
      case "/site": await handleSite(env, chatId); break;
      default:
        await sendMessage(token, chatId,
          "🤔 Commande inconnue. Utilise /help pour voir les commandes.");
    }
    return;
  }

  // Handle callback queries (for future interactive buttons)
  const callback = update.callback_query;
  if (callback) {
    const chatId = callback.message?.chat?.id;
    const authorizedChat = await getAuthorizedChat(env);
    if (!chatId || authorizedChat !== chatId) {
      await answerCallback(token, callback.id, "Non autorisé");
      return;
    }
    await answerCallback(token, callback.id, "Action reçue ✅");
  }
}
