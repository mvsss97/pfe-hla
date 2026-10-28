// Offline tests for the Telegram worker: a fake Telegram API, a fake site and
// an in-memory KV. Every command and every button must produce an answer.
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import worker from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const learning = JSON.parse(readFileSync(join(here, "../../site/data/learning.json"), "utf8"));
const CHAT = 42;

function botFixture() {
  return {
    schemaVersion: 1,
    generatedAt: "2026-10-26T05:00:00+00:00",
    site: "https://site.test",
    prisma: { identified: 120, unique_records: 100, duplicates_removed: 20, screened: 10, included: 1, pending_screening: 90 },
    protocol: { version: "v1", status: "provisional" },
    agents: { screenedPapers: 30, sheets: 1, readingQueue: 2, lastSuccessAt: "2026-10-26T05:10:00+00:00" },
    news24h: { papers: 3, sheets: 1, suggestions: 25 },
    library: { total: 120, pending: 3 },
    queue: [
      {
        key: "aaaaaaaaaa", title: "Hard-label attack <b>A</b>", titleFr: "Attaque à étiquette seule A", year: 2024, venue: "ACL",
        abstract: "Abstract A", abstractFr: "Résumé A en français", pdf: "https://arxiv.org/pdf/2012.14956",
        url: "https://example.org/a", stage: "ta", later: false, hasSheet: false,
        ai: { decision: "exclude", code: "E2", relevance: 1, confidence: 0.8, rationale: "E2 : pas du NLP" },
      },
      { key: "bbbbbbbbbb", title: "Paper B", year: 2023, venue: "arXiv", abstract: "B", url: "", stage: "veille", ai: null },
      { key: "cccccccccc", title: "Paper C", year: 2022, venue: "EMNLP", abstract: "C", url: "", stage: "ft", hasSheet: true, ai: null },
    ],
    sheets: [{ key: "cccccccccc", title: "Paper C", year: 2022, pdf: "https://arxiv.org/pdf/1", summary: "Résumé", relevance: 5, checks: { exact_quote: 3, value_only: 1, not_found: 0 } }],
    vocabulary: [
      { term: "query budget", fr: "budget de requêtes", def: "Max calls", defFr: "Nombre maximal d'appels", ex: "Every query counts.", exFr: "Chaque requête compte.", syn: [], due: "2026-01-01T00:00:00+00:00", reps: 0 },
      { term: "saliency", fr: "saillance", def: "Importance", ex: "Word saliency.", syn: ["importance"], due: "2026-01-01T00:00:00+00:00", reps: 1 },
      { term: "oracle", fr: "oracle", def: "A system we query", ex: "The oracle returns a label.", syn: [], due: "2026-01-02T00:00:00+00:00", reps: 0 },
      { term: "baseline", fr: "référence", def: "Method for comparison", ex: "A strong baseline.", syn: [], due: "2026-01-03T00:00:00+00:00", reps: 0 },
    ],
    supervisor: {
      total: 46,
      sheets: 1,
      queued: 30,
      noPdf: 2,
      items: [
        { key: "cccccccccc", short: "HLBB", title: "Generating Natural Language Attacks in a Hard Label Black Box Setting", year: 2021, priority: 1, family: "ga", reading: "sheet", url: "https://arxiv.org/abs/2012.14956", pdf: "https://arxiv.org/pdf/2012.14956" },
        { key: "dddddddddd", short: "TextHoaxer", title: "TextHoaxer: Budgeted Hard-Label Adversarial Attacks on Text", year: 2022, priority: 1, family: "optim", reading: "queued", url: "" },
        { key: "eeeeeeeeee", short: "FGWS", title: "Frequency-Guided Word Substitutions", year: 2021, priority: 2, family: "defense", reading: "no_pdf", url: "" },
      ],
    },
    securityNews: [
      {
        key: "ghsa:GHSA-aaaa", kind: "vulnerability", source: "ghsa", title: "LangChain <script> flaw", summary: "Une faille critique permet d'exécuter du code.",
        fr: true, url: "https://github.com/advisories/GHSA-aaaa", severity: "alert", at: "2026-10-26T04:00:00+00:00", collectedAt: "2026-10-26T05:00:00+00:00", stars: null, cvss: 9.8,
      },
      {
        key: "github:owner/llm-guard", kind: "repo", source: "github", title: "owner/llm-guard", titleFr: "owner/llm-guard (scanner)", summary: "A scanner for prompt injection.",
        fr: false, url: "https://github.com/owner/llm-guard", severity: "notable", at: "2026-10-25T10:00:00+00:00", collectedAt: "2026-10-26T05:00:00+00:00", stars: 230, cvss: null,
      },
      {
        key: "aiid:1", kind: "incident", source: "aiid", title: "Deepfake voice scam", summary: "Une escroquerie utilise une voix clonée.",
        fr: true, url: "javascript:alert(1)", severity: "notable", at: "2026-10-24T10:00:00+00:00", collectedAt: "2026-10-26T05:00:00+00:00", stars: null, cvss: null,
      },
    ],
  };
}

// 2026-10-26 at HH:MM in Africa/Algiers (UTC+1) as epoch milliseconds.
const localTime = (hours, minutes = 0, day = 26) => Date.UTC(2026, 9, day, hours - 1, minutes);

async function withNow(ms, action) {
  const realNow = Date.now;
  Date.now = () => ms;
  try {
    return await action();
  } finally {
    Date.now = realNow;
  }
}

async function runTick(env, ms) {
  const pending = [];
  await worker.scheduled({ cron: "*/30 * * * *", scheduledTime: ms }, env, { waitUntil: (promise) => pending.push(promise) });
  await Promise.all(pending);
}

async function pipeline(env, summary) {
  const response = await worker.fetch(
    new Request("https://bot.test/api/pipeline", { method: "POST", headers: { Authorization: "Bearer pipe-secret" }, body: JSON.stringify(summary) }),
    env,
    { waitUntil() {} },
  );
  return response.json();
}

function makeKV() {
  const store = new Map();
  return {
    store,
    async get(key, type) {
      const value = store.get(key);
      if (value === undefined) return null;
      return type === "json" ? JSON.parse(value) : value;
    },
    async put(key, value) {
      store.set(key, String(value));
    },
    async delete(key) {
      store.delete(key);
    },
    async list({ prefix = "" } = {}) {
      return { keys: [...store.keys()].filter((key) => key.startsWith(prefix)).map((name) => ({ name })), list_complete: true };
    },
  };
}

function setup({ paired = true, bot = botFixture() } = {}) {
  const calls = [];
  const kv = makeKV();
  if (paired) kv.store.set("authorized_chat_id", String(CHAT));
  let messageId = 100;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.startsWith("https://api.telegram.org/")) {
      const method = url.split("/").pop();
      const body = JSON.parse(init.body || "{}");
      calls.push({ method, body });
      messageId += 1;
      return new Response(JSON.stringify({ ok: true, result: { message_id: messageId } }));
    }
    if (url.endsWith("/data/bot.json")) return new Response(JSON.stringify(bot));
    if (url.endsWith("/data/learning.json")) return new Response(JSON.stringify(learning));
    if (url.endsWith("/data/state.json")) {
      return new Response(JSON.stringify({ papers: [{ title: "Hard label text attack", abstract: "x", year: 2021, status: "identified", url: "https://e.org" }] }));
    }
    return new Response("not found", { status: 404 });
  };
  const env = {
    TELEGRAM_BOT_TOKEN: "TEST:TOKEN",
    TELEGRAM_PAIRING_CODE: "pairing-code-1234567890",
    BOT_WEBHOOK_SECRET: "hook-secret",
    PIPELINE_SECRET: "pipe-secret",
    SITE_URL: `https://site-${Math.random().toString(36).slice(2)}.test`, // defeats the in-memory cache
    PFE_STATE: kv,
  };
  return { calls, kv, env };
}

async function post(env, update, secret = "hook-secret") {
  const pending = [];
  const ctx = { waitUntil: (promise) => pending.push(promise) };
  const response = await worker.fetch(
    new Request("https://bot.test/webhook", {
      method: "POST",
      headers: { "X-Telegram-Bot-Api-Secret-Token": secret, "Content-Type": "application/json" },
      body: JSON.stringify(update),
    }),
    env,
    ctx,
  );
  await Promise.all(pending);
  return response;
}

const message = (text, chatId = CHAT) => ({ update_id: 1, message: { message_id: 7, chat: { id: chatId, type: "private" }, from: { id: chatId }, text } });
const callback = (data, text = "Ancien message") => ({
  update_id: 2,
  callback_query: { id: "cb1", data, from: { id: CHAT }, message: { message_id: 55, chat: { id: CHAT, type: "private" }, text } },
});

function sentTexts(calls) {
  return calls.filter((call) => ["sendMessage", "editMessageText"].includes(call.method)).map((call) => call.body.text);
}

function assertAnswered(calls, label) {
  const replies = calls.filter((call) => ["sendMessage", "editMessageText", "editMessageReplyMarkup", "answerCallbackQuery"].includes(call.method));
  assert.ok(replies.length > 0, `${label}: no reply at all`);
  for (const text of sentTexts(calls)) {
    assert.ok(!text.includes("Petite erreur"), `${label}: error message: ${text}`);
    assert.ok(text.length <= 4096, `${label}: message too long`);
  }
}

test("webhook rejects a wrong secret", async () => {
  const { env } = setup();
  const response = await post(env, message("/menu"), "wrong");
  assert.equal(response.status, 403);
});

test("unpaired chats are refused, pairing works", async () => {
  const { env, calls, kv } = setup({ paired: false });
  await post(env, message("/menu"));
  assert.match(sentTexts(calls)[0], /Bot privé/);
  await post(env, message("/start pairing-code-1234567890"));
  assert.equal(kv.store.get("authorized_chat_id"), String(CHAT));
});

test("every command and keyboard button answers without error", async () => {
  const inputs = [
    "/start", "/menu", "/aide", "/help", "/aujourdhui", "/today", "/tri", "/papers", "/more", "/fiches",
    "/prisma", "/stats", "/anglais", "/words", "/apprendre", "/learn", "/quiz", "/redaction", "/plan",
    "/agents", "/chercher hard label", "/search", "/site", "/reglages", "/inconnue",
    "/actus", "/news", "/encadrant", "/these", "/questions", "/lecteur", "/lire", "/app",
    "📥 Trier", "📄 Fiches", "🧠 Apprendre", "🇬🇧 Anglais", "📊 PRISMA", "✍️ Rédaction", "🗓 Plan du jour", "☰ Menu",
    "📰 Actus sécu", "🎓 Encadrant", "📖 Lecteur PDF", "📱 App",
    "hard label", "ok",
  ];
  for (const input of inputs) {
    const { env, calls } = setup();
    await post(env, message(input));
    assertAnswered(calls, input);
  }
});

test("menu exposes every section as a working button", async () => {
  for (const section of ["tri", "fiches", "apprendre", "anglais", "prisma", "redaction", "plan", "agents", "reglages", "actus", "encadrant", "these", "questions", "lecteur", "app"]) {
    const { env, calls } = setup();
    await post(env, callback(`m:${section}`));
    assertAnswered(calls, `m:${section}`);
    assert.ok(calls.some((call) => call.method === "sendMessage"), `m:${section} sent nothing`);
  }
});

test("triage flow queues events and moves to the next paper", async () => {
  const { env, calls, kv } = setup();
  await post(env, callback("s:i:aaaaaaaaaa"));
  const events = [...kv.store.entries()].filter(([key]) => key.startsWith("evt:")).map(([, value]) => JSON.parse(value));
  assert.equal(events.length, 1);
  assert.deepEqual({ type: events[0].type, key: events[0].key, decision: events[0].decision }, { type: "screen", key: "aaaaaaaaaa", decision: "include" });
  const next = calls.filter((call) => call.method === "sendMessage").pop();
  assert.match(next.body.text, /Paper B/, "the next card must skip the paper just decided");

  // the decided paper is not proposed again
  calls.length = 0;
  await post(env, message("/tri"));
  assert.match(calls.find((call) => call.method === "sendMessage").body.text, /Paper B/);
});

test("exclusion requires a valid code for the stage", async () => {
  const { env, calls, kv } = setup();
  await post(env, callback("s:x:aaaaaaaaaa"));
  const markup = calls.find((call) => call.method === "editMessageReplyMarkup").body.reply_markup;
  const codes = markup.inline_keyboard.flat().map((button) => button.callback_data);
  assert.ok(codes.includes("s:x:aaaaaaaaaa:E2"));
  assert.ok(!codes.includes("s:x:aaaaaaaaaa:E6"), "E6 is not allowed at title/abstract");
  await post(env, callback("s:x:aaaaaaaaaa:E6"));
  assert.equal([...kv.store.keys()].filter((key) => key.startsWith("evt:")).length, 0);
  await post(env, callback("f:x:cccccccccc:E6"));
  const events = [...kv.store.entries()].filter(([key]) => key.startsWith("evt:")).map(([, value]) => JSON.parse(value));
  assert.equal(events[0].code, "E6");
  await post(env, callback("c:s:aaaaaaaaaa"));
});

test("follow-the-AI, read request, final decision", async () => {
  const { env, kv } = setup();
  await post(env, callback("s:a:aaaaaaaaaa"));
  await post(env, callback("r:bbbbbbbbbb"));
  await post(env, callback("d:k:cccccccccc"));
  const events = [...kv.store.entries()].filter(([key]) => key.startsWith("evt:")).map(([, value]) => JSON.parse(value));
  const byType = Object.fromEntries(events.map((event) => [event.type, event]));
  assert.equal(byType.screen.decision, "exclude");
  assert.equal(byType.screen.code, "E2");
  assert.equal(byType.read.key, "bbbbbbbbbb");
  assert.equal(byType.final.decision, "keep");
});

test("vocabulary, lessons, quiz, writing steps and settings buttons", async () => {
  const { env, calls, kv } = setup();
  await post(env, message("/anglais"));
  const reveal = calls.filter((call) => call.method === "sendMessage").flatMap((call) => call.body.reply_markup?.inline_keyboard?.flat() || []).find((button) => button.callback_data?.startsWith("w:s:"));
  assert.ok(reveal, "word card has a reveal button");
  const hash = reveal.callback_data.split(":")[2];
  for (const data of [
    `w:s:${hash}`, `w:q:${hash}:4`, "l:n", "l:p", "l:m", "l:o:m3", "l:o:these", "l:o:hardlabel", "q:m1l1", "q:m1l1:0", "q:m1l2:2", "q:t1:0", "r:s:r3",
    "set:morning", "set:english", "set:news", "set:alerts", "set:pause", "n:repo", "n:all", "n:bogus", "t:p1", "noop",
  ]) {
    calls.length = 0;
    await post(env, callback(data));
    assertAnswered(calls, data);
  }
  assert.ok([...kv.store.keys()].some((key) => key.startsWith("evt:")), "vocab review queued");
  const learn = JSON.parse(kv.store.get("learn:state"));
  assert.ok(learn.done.includes("m1l1"), "correct quiz answer validates the lesson");
  assert.ok(learn.done.includes("t1"), "thesis lessons have working quizzes");
  const settings = JSON.parse(kv.store.get("settings"));
  assert.deepEqual([settings.morning, settings.english, settings.news, settings.alerts], [false, false, false, false]);
  assert.deepEqual(JSON.parse(kv.store.get("these:done")), ["p1"], "thesis plan step ticked");
});

test("pipeline API is protected and round-trips events", async () => {
  const { env, calls, kv } = setup();
  await post(env, callback("s:i:aaaaaaaaaa"));
  const unauthorized = await worker.fetch(new Request("https://bot.test/api/events"), env, { waitUntil() {} });
  assert.equal(unauthorized.status, 403);
  const auth = { Authorization: "Bearer pipe-secret" };
  const listed = await (await worker.fetch(new Request("https://bot.test/api/events", { headers: auth }), env, { waitUntil() {} })).json();
  assert.equal(listed.events.length, 1);
  const ack = await worker.fetch(
    new Request("https://bot.test/api/events/ack", { method: "POST", headers: auth, body: JSON.stringify({ ids: [listed.events[0].id] }) }),
    env,
    { waitUntil() {} },
  );
  assert.equal((await ack.json()).deleted, 1);
  assert.equal([...kv.store.keys()].filter((key) => key.startsWith("evt:")).length, 0);

  calls.length = 0;
  const summary = { newPapers: 4, suggestions: 10, sheets: [{ key: "cccccccccc", title: "Paper C" }], synthesis: true, agentErrors: 0, agentsSkipped: "" };
  const notified = await worker.fetch(new Request("https://bot.test/api/pipeline", { method: "POST", headers: auth, body: JSON.stringify(summary) }), env, { waitUntil() {} });
  assert.equal((await notified.json()).notified, true);
  assert.match(sentTexts(calls)[0], /Nouvelle fiche/);

  calls.length = 0;
  const skipped = { newPapers: 2, sheets: [], agentsSkipped: "token missing" };
  await worker.fetch(new Request("https://bot.test/api/pipeline", { method: "POST", headers: auth, body: JSON.stringify(skipped) }), env, { waitUntil() {} });
  assert.match(sentTexts(calls)[0], /setup-secrets\.ps1/);
  calls.length = 0;
  await worker.fetch(new Request("https://bot.test/api/pipeline", { method: "POST", headers: auth, body: JSON.stringify(skipped) }), env, { waitUntil() {} });
  assert.equal(sentTexts(calls).length, 0, "the missing-token reminder is sent once per day");
});

test("without PIPELINE_SECRET the pairing code (shared with GitHub) protects the API", async () => {
  const { env } = setup();
  delete env.PIPELINE_SECRET;
  const denied = await worker.fetch(new Request("https://bot.test/api/events", { headers: { Authorization: "Bearer pipe-secret" } }), env, { waitUntil() {} });
  assert.equal(denied.status, 403);
  const allowed = await worker.fetch(
    new Request("https://bot.test/api/events", { headers: { Authorization: "Bearer pairing-code-1234567890" } }),
    env,
    { waitUntil() {} },
  );
  assert.equal(allowed.status, 200);
  delete env.TELEGRAM_PAIRING_CODE;
  const noSecret = await worker.fetch(new Request("https://bot.test/api/events", { headers: { Authorization: "Bearer " } }), env, { waitUntil() {} });
  assert.equal(noSecret.status, 403, "an empty secret must never authorize");
});

test("a dedicated webhook secret overrides the public var", async () => {
  const { env } = setup();
  env.TELEGRAM_WEBHOOK_SECRET = "private-secret";
  assert.equal((await post(env, message("/menu"), "hook-secret")).status, 403);
  assert.equal((await post(env, message("/menu"), "private-secret")).status, 200);
});

test("setup registers webhook, commands and menu button", async () => {
  const { env, calls } = setup();
  const denied = await worker.fetch(new Request("https://bot.test/setup"), env, { waitUntil() {} });
  assert.equal(denied.status, 403);
  const response = await worker.fetch(new Request("https://bot.test/setup?key=pipe-secret"), env, { waitUntil() {} });
  assert.equal(response.status, 200);
  const methods = calls.map((call) => call.method);
  assert.deepEqual(methods, ["setWebhook", "setMyCommands", "setChatMenuButton"]);
  assert.equal(calls[0].body.secret_token, "hook-secret");
  assert.ok(calls[1].body.commands.length >= 10);
});

test("the 30-minute tick follows the daily schedule once per slot", async () => {
  const { env, calls } = setup();
  await runTick(env, localTime(2, 0));
  assert.equal(calls.length, 0, "nothing at night");

  await runTick(env, localTime(8, 0));
  assert.match(sentTexts(calls)[0], /Bonjour/);
  assert.match(sentTexts(calls)[0], /Liste de l'encadrant : 1\/46/);
  const count = calls.length;
  await runTick(env, localTime(8, 30));
  assert.equal(calls.length, count, "the morning briefing is sent once");

  calls.length = 0;
  await runTick(env, localTime(10, 0));
  const firstBreak = sentTexts(calls);
  assert.match(firstBreak[0], /Pause anglais/);
  assert.equal(firstBreak.length, 3, "header + 2 word cards");

  calls.length = 0;
  await runTick(env, localTime(15, 30));
  const secondBreak = sentTexts(calls);
  assert.match(secondBreak[0], /Pause anglais/);
  const words = (texts) => texts.slice(1).map((text) => text.split("</b>")[0]);
  assert.equal(words(firstBreak).filter((word) => words(secondBreak).includes(word)).length, 0, "the second break shows other words");

  calls.length = 0;
  await runTick(env, localTime(18, 0));
  const digest = sentTexts(calls)[0];
  assert.match(digest, /Actus sécurité IA du jour<\/b> \(3\)/);
  assert.ok(digest.indexOf("LangChain") < digest.indexOf("llm-guard"), "alerts come first");
  assert.ok(digest.includes("&lt;script&gt;"), "titles are escaped");
  assert.ok(!digest.includes("javascript:"), "only http(s) links");

  calls.length = 0;
  await runTick(env, localTime(18, 0, 27));
  assert.match(sentTexts(calls)[0], /Rien de nouveau/, "already shown news are not repeated");
});

test("a delayed tick still delivers the slot, but not hours later", async () => {
  const { env, calls } = setup();
  await runTick(env, localTime(9, 30));
  assert.match(sentTexts(calls)[0], /Bonjour/, "08:00 slot caught up at 09:30");
  const late = setup();
  await runTick(late.env, localTime(12, 0));
  assert.ok(!sentTexts(late.calls).some((text) => /Bonjour/.test(text)), "no morning briefing at noon");
  assert.ok(sentTexts(late.calls).some((text) => /Pause anglais/.test(text)), "the 10:00 English break is still due");
});

test("settings switch slots off", async () => {
  const { env, calls, kv } = setup();
  kv.store.set("settings", JSON.stringify({ morning: false, english: false }));
  await runTick(env, localTime(8, 0));
  await runTick(env, localTime(10, 0));
  assert.equal(calls.length, 0);
  kv.store.set("settings", JSON.stringify({ pausedUntil: "2999-01-01T00:00:00.000Z" }));
  await runTick(env, localTime(13, 0));
  assert.equal(calls.length, 0, "pause stops everything");
});

test("security alerts: immediate by day, held at night, never twice", async () => {
  const { env, calls, kv } = setup();
  const alert = { key: "ghsa:GHSA-crit", kind: "vulnerability", source: "ghsa", title: "Critical flaw in vLLM", summary: "Faille critique.", url: "https://github.com/advisories/GHSA-crit" };

  const day = await withNow(localTime(12, 0), () => pipeline(env, { light: true, sheets: [], alerts: [alert] }));
  assert.equal(day.alerted, true);
  assert.match(sentTexts(calls)[0], /Alerte sécurité IA/);
  assert.match(sentTexts(calls)[0], /Critical flaw in vLLM/);

  calls.length = 0;
  const again = await withNow(localTime(15, 0), () => pipeline(env, { light: true, sheets: [], alerts: [alert] }));
  assert.equal(again.alerted, false);
  assert.equal(calls.length, 0, "the same alert is never pushed twice");

  const night = await withNow(localTime(2, 0, 27), () => pipeline(env, { light: true, sheets: [], alerts: [{ ...alert, key: "nvd:CVE-2", title: "Night flaw" }] }));
  assert.equal(night.alerted, false);
  assert.equal(calls.length, 0, "quiet hours");
  assert.equal(JSON.parse(kv.store.get("alerts:pending")).length, 1);

  await runTick(env, localTime(7, 0, 27));
  assert.ok(sentTexts(calls).some((text) => /Night flaw/.test(text)), "held alert sent at 07:00");
  assert.equal(JSON.parse(kv.store.get("alerts:pending")).length, 0);
});

test("alerts switched off are dropped, light runs stay quiet", async () => {
  const { env, calls, kv } = setup();
  kv.store.set("settings", JSON.stringify({ alerts: false }));
  const alert = { key: "kev:CVE-9", kind: "vulnerability", source: "kev", title: "Exploited", url: "https://nvd.nist.gov/" };
  await withNow(localTime(12, 0), () => pipeline(env, { light: true, sheets: [{ key: "cccccccccc", title: "Paper C" }], alerts: [alert] }));
  assert.equal(calls.length, 0, "no alert and no run report on a light run");
  assert.equal(JSON.parse(kv.store.get("alerts:pending")).length, 0);
});

test("supervisor, thesis plan and news commands render real data", async () => {
  const { env, calls } = setup();
  await post(env, message("/encadrant"));
  const supervisor = sentTexts(calls)[0];
  assert.match(supervisor, /46 articles/);
  assert.match(supervisor, /HLBB/);
  assert.ok(!supervisor.includes("FGWS"), "priority 2 is not listed in the short view");

  calls.length = 0;
  await post(env, message("/these"));
  assert.match(sentTexts(calls)[0], /Progression : <b>0\/9<\/b>/);

  calls.length = 0;
  await post(env, message("/actus"));
  const news = sentTexts(calls)[0];
  assert.match(news, /llm-guard/);
  assert.match(news, /⭐230/);
  assert.match(news, /🇬🇧/, "untranslated summaries are flagged");
});

test("missing site data degrades to a clear message", async () => {
  const { env, calls } = setup();
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.startsWith("https://api.telegram.org/")) {
      calls.push({ method: url.split("/").pop(), body: JSON.parse(init.body || "{}") });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }));
    }
    return new Response("down", { status: 503 });
  };
  await post(env, message("/prisma"));
  assert.match(sentTexts(calls)[0], /indisponibles/);
});

// ─── French next to the English, and the bilingual PDF reader ───────────────

const BOT_TOKEN = "TEST:TOKEN";

function readerRequest(path, { auth = null, origin = "https://pfe-hla.pages.dev", method = "GET", body } = {}) {
  const headers = { Origin: origin };
  if (auth) headers.Authorization = auth;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  return new Request(`https://bot.test${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

function initData(userId, botToken = BOT_TOKEN, authDate = Math.floor(Date.now() / 1000)) {
  const params = new URLSearchParams({ auth_date: String(authDate), query_id: "AAE", user: JSON.stringify({ id: userId, first_name: "M" }) });
  const check = [...params.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([key, value]) => `${key}=${value}`).join("\n");
  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  params.set("hash", createHmac("sha256", secret).update(check).digest("hex"));
  return params.toString();
}

async function readerTokenFromBot(env, calls) {
  await post(env, message("/lecteur"));
  const buttons = calls.filter((call) => call.method === "sendMessage").flatMap((call) => call.body.reply_markup?.inline_keyboard?.flat() || []);
  const activate = buttons.find((button) => button.url?.includes("#t="));
  assert.ok(activate, "the /lecteur message has an activation link");
  assert.ok(buttons.some((button) => button.web_app?.url?.endsWith("/reader.html")), "and opens the reader as a mini app");
  return activate.url.split("#t=")[1];
}

test("paper cards and word cards show the French under the English", async () => {
  const { env, calls } = setup();
  await post(env, message("/tri"));
  const card = calls.find((call) => call.method === "sendMessage");
  assert.match(card.body.text, /🇫🇷 <i>Attaque à étiquette seule A<\/i>/);
  assert.match(card.body.text, /🇬🇧 <i>Abstract A<\/i>/);
  assert.match(card.body.text, /🇫🇷 <b>Résumé :<\/b> Résumé A en français/);
  const reader = card.body.reply_markup.inline_keyboard.flat().find((button) => button.web_app);
  assert.equal(reader.web_app.url, `${env.SITE_URL}/reader.html?k=aaaaaaaaaa`);

  calls.length = 0;
  await post(env, message("/anglais"));
  const hash = calls.flatMap((call) => call.body.reply_markup?.inline_keyboard?.flat() || []).find((button) => button.callback_data?.startsWith("w:s:")).callback_data.split(":")[2];
  calls.length = 0;
  await post(env, callback(`w:s:${hash}`));
  const back = sentTexts(calls).find((text) => text.includes("Tu le savais"));
  assert.ok(/🇬🇧 /.test(back) && /🇫🇷 /.test(back), back);

  calls.length = 0;
  await post(env, message("/actus"));
  assert.match(sentTexts(calls)[0], /🇫🇷 owner\/llm-guard \(scanner\)/);
});

test("reader API: CORS, and only the paired account gets in", async () => {
  const { env, calls } = setup();
  const preflight = await worker.fetch(readerRequest("/reader/status", { method: "OPTIONS" }), env, { waitUntil() {} });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("Access-Control-Allow-Origin"), "https://pfe-hla.pages.dev");
  const foreign = await worker.fetch(readerRequest("/reader/status", { method: "OPTIONS", origin: "https://evil.example" }), env, { waitUntil() {} });
  assert.equal(foreign.headers.get("Access-Control-Allow-Origin"), null);

  assert.equal((await worker.fetch(readerRequest("/reader/status"), env, { waitUntil() {} })).status, 401);
  assert.equal((await worker.fetch(readerRequest("/reader/status", { auth: "Bearer 9999999999.forged" }), env, { waitUntil() {} })).status, 401);

  const token = await readerTokenFromBot(env, calls);
  const status = await worker.fetch(readerRequest("/reader/status", { auth: `Bearer ${token}` }), env, { waitUntil() {} });
  assert.equal(status.status, 200);
  assert.deepEqual(await status.json(), { ok: true, translate: false, version: (await (await worker.fetch(new Request("https://bot.test/health"), env, {})).json()).version });

  const owner = await worker.fetch(readerRequest("/reader/status", { auth: `tma ${initData(CHAT)}` }), env, { waitUntil() {} });
  assert.equal(owner.status, 200, "Telegram mini-app launch data of the paired account");
  const stranger = await worker.fetch(readerRequest("/reader/status", { auth: `tma ${initData(7)}` }), env, { waitUntil() {} });
  assert.equal(stranger.status, 401, "another Telegram user");
  const forged = await worker.fetch(readerRequest("/reader/status", { auth: `tma ${initData(CHAT, "OTHER:TOKEN")}` }), env, { waitUntil() {} });
  assert.equal(forged.status, 401, "launch data signed with another bot token");
  const stale = await worker.fetch(readerRequest("/reader/status", { auth: `tma ${initData(CHAT, BOT_TOKEN, 1_000_000)}` }), env, { waitUntil() {} });
  assert.equal(stale.status, 401, "old launch data");
});

test("reader translation goes through Gemini once, then the KV cache", async () => {
  const { env, calls } = setup();
  const token = await readerTokenFromBot(env, calls);
  const auth = `Bearer ${token}`;
  const texts = ["The attack only observes the predicted label.", "Related Work"];
  const missing = await worker.fetch(readerRequest("/reader/translate", { auth, method: "POST", body: { texts } }), env, { waitUntil() {} });
  assert.equal(missing.status, 503, "no Gemini key yet");

  env.GEMINI_API_KEY = "gemini-test-key";
  const siteFetch = globalThis.fetch;
  let geminiCalls = 0;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.startsWith("https://generativelanguage.googleapis.com/")) {
      geminiCalls += 1;
      assert.equal(init.headers["x-goog-api-key"], "gemini-test-key");
      if (url.includes("gemini-3.5-flash-lite")) return new Response("busy", { status: 503 });
      const sent = JSON.parse(JSON.parse(init.body).contents[0].parts[0].text);
      const blocks = sent.map((block) => ({ i: block.i, fr: `FR:${block.en}` }));
      return new Response(JSON.stringify({ modelVersion: "gemini-test", candidates: [{ content: { parts: [{ text: JSON.stringify({ blocks }) }] } }] }));
    }
    return siteFetch(input, init);
  };
  try {
    const first = await (await worker.fetch(readerRequest("/reader/translate", { auth, method: "POST", body: { texts } }), env, { waitUntil() {} })).json();
    assert.deepEqual(first.fr, texts.map((text) => `FR:${text}`));
    assert.equal(first.cached, false);
    assert.equal(geminiCalls, 2, "a busy model is skipped for the next one");
    const second = await (await worker.fetch(readerRequest("/reader/translate", { auth, method: "POST", body: { texts } }), env, { waitUntil() {} })).json();
    assert.equal(second.cached, true);
    assert.equal(geminiCalls, 2, "the second reader gets the cached page");
    const tooBig = await worker.fetch(readerRequest("/reader/translate", { auth, method: "POST", body: { texts: Array(200).fill("text") } }), env, { waitUntil() {} });
    assert.equal(tooBig.status, 413);
  } finally {
    globalThis.fetch = siteFetch;
  }
});

test("reader PDF proxy streams PDFs only", async () => {
  const { env, calls } = setup();
  const token = await readerTokenFromBot(env, calls);
  const siteFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url === "https://arxiv.org/pdf/2012.14956") return new Response("%PDF-1.5 fake", { headers: { "Content-Type": "application/pdf" } });
    if (url === "https://example.org/page") return new Response("<html>", { headers: { "Content-Type": "text/html" } });
    return siteFetch(input, init);
  };
  try {
    const auth = `Bearer ${token}`;
    const pdf = await worker.fetch(readerRequest(`/reader/pdf?url=${encodeURIComponent("https://arxiv.org/pdf/2012.14956")}`, { auth }), env, { waitUntil() {} });
    assert.equal(pdf.status, 200);
    assert.equal(await pdf.text(), "%PDF-1.5 fake");
    assert.equal(pdf.headers.get("Access-Control-Allow-Origin"), "https://pfe-hla.pages.dev");
    const html = await worker.fetch(readerRequest(`/reader/pdf?url=${encodeURIComponent("https://example.org/page")}`, { auth }), env, { waitUntil() {} });
    assert.equal(html.status, 415);
    const local = await worker.fetch(readerRequest(`/reader/pdf?url=${encodeURIComponent("file:///etc/passwd")}`, { auth }), env, { waitUntil() {} });
    assert.equal(local.status, 400);
    const anonymous = await worker.fetch(readerRequest(`/reader/pdf?url=${encodeURIComponent("https://arxiv.org/pdf/2012.14956")}`), env, { waitUntil() {} });
    assert.equal(anonymous.status, 401);
  } finally {
    globalThis.fetch = siteFetch;
  }
});
