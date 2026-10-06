/**
 * PFE Hard-Label NLP — Telegram Bot Webhook (Cloudflare Worker)
 *
 * Ce worker reçoit les updates Telegram via webhook et répond aux commandes.
 * Il lit les données du dashboard depuis le site statique.
 * Il stocke temporairement les actions (screening) dans Cloudflare KV.
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

function editMessageReplyMarkup(token, chatId, messageId, replyMarkup) {
  return tg(token, "editMessageReplyMarkup", {
    chat_id: chatId,
    message_id: messageId,
    reply_markup: replyMarkup,
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

// Stocke la décision de l'utilisateur pour l'action GitHub
async function saveDecision(env, paperId, action) {
  if (!env.PFE_STATE) return;
  const key = `decision:${paperId}`;
  await env.PFE_STATE.put(key, JSON.stringify({ action, timestamp: Date.now() }));
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
      await sendMessage(token, chatId, "✅ Tu es déjà associé. Utilise /help pour voir les commandes.");
    } else {
      await sendMessage(token, chatId, "⛔ Ce bot est déjà associé à un autre compte.");
    }
    return;
  }

  const parts = text.trim().split(/\s+/);
  const supplied = parts.length > 1 ? parts.slice(1).join(" ") : "";
  const expected = env.TELEGRAM_PAIRING_CODE || "";

  if (!expected || expected.length < 8 || !supplied || supplied !== expected) {
    await sendMessage(token, chatId, "🔑 Envoie <code>/start TON_CODE</code> pour associer ce bot à ton compte.");
    return;
  }

  await setAuthorizedChat(env, chatId);
  await sendMessage(token, chatId, "✅ Appareil associé avec succès !\n\nSupprime maintenant le message avec le code.\nUtilise /help pour voir les commandes disponibles.");
}

async function handleHelp(env, chatId) {
  await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId,
    "📚 <b>Commandes disponibles</b>\n\n" +
    "/today — résumé du jour\n" +
    "/papers — articles en attente de screening (interactif)\n" +
    "/stats — compteurs PRISMA\n" +
    "/words — mots d'anglais du jour\n" +
    "/learn — apprendre NLP, Math, et Hard-Label Attacks\n" +
    "/search <i>terme</i> — chercher dans les articles\n" +
    "/site — lien vers le dashboard\n" +
    "/help — cette aide");
}

async function handleToday(env, chatId) {
  const token = env.TELEGRAM_BOT_TOKEN;
  const state = await fetchDashboardState(env.SITE_URL || "https://mvsss97.github.io/pfe-hla/");

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

  text += `\n🌐 <a href="${env.SITE_URL || "https://mvsss97.github.io/pfe-hla/"}">Voir le dashboard</a>`;
  await sendMessage(token, chatId, text);
}

async function handlePapers(env, chatId) {
  const token = env.TELEGRAM_BOT_TOKEN;
  const state = await fetchDashboardState(env.SITE_URL || "https://mvsss97.github.io/pfe-hla/");

  if (!state) {
    await sendMessage(token, chatId, "⚠️ Données indisponibles.");
    return;
  }

  const pending = (state.papers || []).filter(p => p.status === "identified");

  if (pending.length === 0) {
    await sendMessage(token, chatId, "🎉 Aucun article en attente de screening !");
    return;
  }

  // Envoie les 3 premiers avec des boutons interactifs
  const toSend = pending.slice(0, 3);
  await sendMessage(token, chatId, `📄 <b>${pending.length} articles en attente.</b> Voici les prochains :`);

  for (const p of toSend) {
    const year = p.year || "?";
    const title = p.title || "Sans titre";
    const abstract = (p.abstract || "Pas d'abstract").slice(0, 300) + "...";
    const paperId = p.id;
    
    let text = `<b>[${year}] ${escapeHtml(title)}</b>\n\n<i>${escapeHtml(abstract)}</i>`;
    
    // Clavier interactif
    const replyMarkup = {
      inline_keyboard: [
        [
          { text: "✅ Accepter", callback_data: `keep:${paperId}` },
          { text: "❌ Rejeter", callback_data: `reject:${paperId}` }
        ]
      ]
    };

    await sendMessage(token, chatId, text, { reply_markup: replyMarkup });
  }
}

async function handleLearn(env, chatId) {
  const token = env.TELEGRAM_BOT_TOKEN;
  const text = "🧠 <b>Apprentissage : Hard-Label NLP</b>\n\n" +
               "Que souhaites-tu réviser aujourd'hui ? Choisis un module :";
  
  const replyMarkup = {
    inline_keyboard: [
      [{ text: "🧮 Mathématiques (Dérivées, Gradients)", callback_data: "learn:math" }],
      [{ text: "🗣 NLP (Transformers, Embeddings)", callback_data: "learn:nlp" }],
      [{ text: "⚔️ Adversarial Attacks (Hard-label)", callback_data: "learn:attacks" }]
    ]
  };

  await sendMessage(token, chatId, text, { reply_markup: replyMarkup });
}

// ─── Callback Handler (Interactive buttons) ─────────────────────────────────

async function handleCallback(env, callback) {
  const token = env.TELEGRAM_BOT_TOKEN;
  const chatId = callback.message?.chat?.id;
  const msgId = callback.message?.message_id;
  const data = callback.data;

  if (!chatId || !data) return;

  if (data.startsWith("keep:") || data.startsWith("reject:")) {
    const [action, paperId] = data.split(":", 2);
    
    // Sauvegarder dans KV pour que GitHub Actions le récupère à 19h
    await saveDecision(env, paperId, action);

    // Mettre à jour le message pour désactiver les boutons
    await editMessageReplyMarkup(token, chatId, msgId, { inline_keyboard: [] });
    
    const actionText = action === "keep" ? "✅ Accepté" : "❌ Rejeté";
    await answerCallback(token, callback.id, `${actionText}. L'action sera synchronisée ce soir.`);
    await sendMessage(token, chatId, `${actionText} (Le dashboard sera mis à jour à 19h).`);
  } 
  else if (data.startsWith("learn:")) {
    const module = data.split(":")[1];
    let content = "";
    if (module === "math") {
      content = "🧮 <b>Les Gradients (Maths)</b>\n\nUn gradient est un vecteur qui indique la direction de la plus grande pente d'une fonction. En IA, on l'utilise pour ajuster les poids et minimiser l'erreur.\n\n<i>En 'Hard-Label', on ne peut pas calculer ce gradient directement, il faut l'estimer !</i>";
    } else if (module === "nlp") {
      content = "🗣 <b>Word Embeddings (NLP)</b>\n\nEn NLP, les mots sont convertis en vecteurs (listes de nombres). Des mots au sens proche auront des vecteurs proches. C'est ce qui permet aux modèles comme BERT de comprendre le contexte.";
    } else if (module === "attacks") {
      content = "⚔️ <b>Hard-Label Attacks</b>\n\nContrairement au 'Soft-Label' où on voit les probabilités (ex: 90% Chien), en 'Hard-Label' on a juste la décision finale (Chien ou Chat). Pour tromper l'IA, on doit deviner la frontière de décision à tâtons !";
    }
    await answerCallback(token, callback.id, "Module chargé !");
    await sendMessage(token, chatId, content);
  }
}

// ─── Utility ────────────────────────────────────────────────────────────────

function escapeHtml(text) {
  return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
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

    // Endpoint privé pour GitHub Actions (récupérer les décisions)
    if (url.pathname === "/sync-decisions" && request.method === "GET") {
      const secret = url.searchParams.get("secret");
      if (secret !== env.TELEGRAM_PAIRING_CODE) return new Response("Unauthorized", { status: 403 });

      const decisions = {};
      if (env.PFE_STATE) {
        const list = await env.PFE_STATE.list({ prefix: "decision:" });
        for (const key of list.keys) {
          const val = await env.PFE_STATE.get(key.name);
          decisions[key.name.replace("decision:", "")] = JSON.parse(val);
          // Effacer la décision de la file d'attente
          await env.PFE_STATE.delete(key.name);
        }
      }
      return new Response(JSON.stringify(decisions), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // Webhook Telegram
    if (url.pathname === "/webhook" && request.method === "POST") {
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

      return new Response("OK", { status: 200 });
    }

    // Setup webhook
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

  if (update.message && update.message.chat.type === "private") {
    const chatId = update.message.chat.id;
    const text = update.message.text || "";

    if (text.startsWith("/start")) {
      await handleStart(env, chatId, text);
      return;
    }

    const authorizedChat = await getAuthorizedChat(env);
    if (authorizedChat === null || authorizedChat !== chatId) {
      await sendMessage(token, chatId, "🔒 Non autorisé. Utilise /start <i>code</i> pour t'associer.");
      return;
    }

    const cmd = text.split(/\s+/)[0].toLowerCase().replace(/@\w+$/, "");
    switch (cmd) {
      case "/help": await handleHelp(env, chatId); break;
      case "/today": await handleToday(env, chatId); break;
      case "/papers": await handlePapers(env, chatId); break;
      case "/learn": await handleLearn(env, chatId); break;
      default: break;
    }
    return;
  }

  if (update.callback_query) {
    const chatId = update.callback_query.message?.chat?.id;
    const authorizedChat = await getAuthorizedChat(env);
    if (!chatId || authorizedChat !== chatId) {
      await answerCallback(token, update.callback_query.id, "Non autorisé");
      return;
    }
    await handleCallback(env, update.callback_query);
  }
}
