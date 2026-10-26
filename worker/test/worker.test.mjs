// Offline tests for the Telegram worker: a fake Telegram API, a fake site and
// an in-memory KV. Every command and every button must produce an answer.
import assert from "node:assert/strict";
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
        key: "aaaaaaaaaa", title: "Hard-label attack <b>A</b>", year: 2024, venue: "ACL", abstract: "Abstract A",
        url: "https://example.org/a", stage: "ta", later: false, hasSheet: false,
        ai: { decision: "exclude", code: "E2", relevance: 1, confidence: 0.8, rationale: "E2 : pas du NLP" },
      },
      { key: "bbbbbbbbbb", title: "Paper B", year: 2023, venue: "arXiv", abstract: "B", url: "", stage: "veille", ai: null },
      { key: "cccccccccc", title: "Paper C", year: 2022, venue: "EMNLP", abstract: "C", url: "", stage: "ft", hasSheet: true, ai: null },
    ],
    sheets: [{ key: "cccccccccc", title: "Paper C", year: 2022, summary: "Résumé", relevance: 5, checks: { exact_quote: 3, value_only: 1, not_found: 0 } }],
    vocabulary: [
      { term: "query budget", fr: "budget de requêtes", def: "Max calls", ex: "Every query counts.", syn: [], due: "2026-01-01T00:00:00+00:00", reps: 0 },
      { term: "saliency", fr: "saillance", def: "Importance", ex: "Word saliency.", syn: ["importance"], due: "2026-01-01T00:00:00+00:00", reps: 1 },
    ],
  };
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
    "📥 Trier", "📄 Fiches", "🧠 Apprendre", "🇬🇧 Anglais", "📊 PRISMA", "✍️ Rédaction", "🗓 Plan du jour", "☰ Menu",
    "hard label", "ok",
  ];
  for (const input of inputs) {
    const { env, calls } = setup();
    await post(env, message(input));
    assertAnswered(calls, input);
  }
});

test("menu exposes every section as a working button", async () => {
  for (const section of ["tri", "fiches", "apprendre", "anglais", "prisma", "redaction", "plan", "agents", "reglages"]) {
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
  for (const data of [`w:s:${hash}`, `w:q:${hash}:4`, "l:n", "l:p", "l:m", "l:o:m3", "q:m1l1", "q:m1l1:0", "q:m1l2:2", "r:s:r3", "set:morning", "set:pause", "noop"]) {
    calls.length = 0;
    await post(env, callback(data));
    assertAnswered(calls, data);
  }
  assert.ok([...kv.store.keys()].some((key) => key.startsWith("evt:")), "vocab review queued");
  const learn = JSON.parse(kv.store.get("learn:state"));
  assert.ok(learn.done.includes("m1l1"), "correct quiz answer validates the lesson");
  assert.equal(JSON.parse(kv.store.get("settings")).morning, false);
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

test("cron pushes once per slot and day, and respects settings", async () => {
  for (const cron of ["30 7 * * *", "30 12 * * *", "0 19 * * *"]) {
    const { env, calls } = setup();
    const pending = [];
    const ctx = { waitUntil: (promise) => pending.push(promise) };
    await worker.scheduled({ cron }, env, ctx);
    await Promise.all(pending);
    assert.ok(calls.some((call) => call.method === "sendMessage"), `${cron} sent nothing`);
    const count = calls.length;
    await worker.scheduled({ cron }, env, ctx);
    await Promise.all(pending);
    assert.equal(calls.length, count, `${cron} sent twice the same day`);
  }
  const { env, calls, kv } = setup();
  kv.store.set("settings", JSON.stringify({ morning: false }));
  const pending = [];
  await worker.scheduled({ cron: "30 7 * * *" }, env, { waitUntil: (promise) => pending.push(promise) });
  await Promise.all(pending);
  assert.equal(calls.length, 0);
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
