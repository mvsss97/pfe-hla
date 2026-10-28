// Bilingual PDF reader.
//
// The page is drawn by PDF.js exactly as published. For the French view, the
// text of each paragraph is extracted with its position, translated (pages
// cached by the Telegram worker: translated ahead of time by the pipeline, or
// on demand when the worker has its Gemini key) and painted over the same
// spot of a copy of the page: columns, figures and formulas keep their place.
// Library PDFs open for everyone; other links need the paired account
// (Telegram mini-app launch data, or a token sent by the bot's /lecteur).

import { chunks, extractBlocks, markReferences } from "./reader-layout.js";
import * as pdfjsLib from "./vendor/pdfjs/pdf.min.js";

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL("./vendor/pdfjs/pdf.worker.min.js", import.meta.url).href;

const SEARCH = new URLSearchParams(location.search);
const API = (SEARCH.get("api") || "https://pfe-hla-bot.massiresacko97.workers.dev").replace(/\/+$/, "");
const STORAGE = {
  token: "hardlabel.reader.token",
  telegram: "hardlabel.reader.tma",
  mode: "hardlabel.reader.mode",
  zoom: "hardlabel.reader.zoom",
};
const CACHE_PREFIX = "hardlabel.reader.tr.v1.";
const PARALLEL_PAGES = 2;

const $ = (selector) => document.querySelector(selector);

const state = {
  auth: "",
  canTranslate: false,
  mode: "fr",
  zoom: 1,
  scale: 1,
  entries: [],
  active: 0,
  instant: false,
  doc: {},
  references: { inReferences: false },
};

// ─── Small helpers ───────────────────────────────────────────────────────────

function storageGet(store, key) {
  try {
    return store.getItem(key);
  } catch (_error) {
    return null;
  }
}

function storageSet(store, key, value) {
  try {
    store.setItem(key, value);
    return true;
  } catch (_error) {
    return false;
  }
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function setStatus(text) {
  $("#status").textContent = text;
}

function showNotice(text) {
  const notice = $("#notice");
  notice.textContent = text;
  notice.hidden = !text;
}

async function sha256(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

class ReaderError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.status = status;
  }
}

// ─── Telegram mini app and access ───────────────────────────────────────────

function telegramEvent(type, data = {}) {
  try {
    if (window.TelegramWebviewProxy?.postEvent) window.TelegramWebviewProxy.postEvent(type, JSON.stringify(data));
    else if (window.parent !== window) window.parent.postMessage(JSON.stringify({ eventType: type, eventData: data }), "*");
  } catch (_error) {
    // Outside Telegram: nothing to tell.
  }
}

function launchAuth() {
  const hash = new URLSearchParams(location.hash.slice(1));
  const initData = hash.get("tgWebAppData");
  if (initData) storageSet(sessionStorage, STORAGE.telegram, initData);
  const token = hash.get("t");
  if (token) {
    storageSet(localStorage, STORAGE.token, token);
    history.replaceState(null, "", location.pathname + location.search);
  }
  const telegram = initData || storageGet(sessionStorage, STORAGE.telegram);
  if (telegram) {
    telegramEvent("web_app_ready");
    telegramEvent("web_app_expand");
    return `tma ${telegram}`;
  }
  const saved = storageGet(localStorage, STORAGE.token);
  return saved ? `Bearer ${saved}` : "";
}

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (state.auth) headers.Authorization = state.auth;
  const response = await fetch(`${API}${path}`, { ...options, headers });
  if (!response.ok) {
    const info = await response.json().catch(() => ({}));
    throw new ReaderError(info.error || `HTTP ${response.status}`, response.status);
  }
  return response;
}

const OTHER_LINKS_HELP =
  "Ce lien n'est pas dans ta bibliothèque. Pour l'ouvrir ici, passe par un bouton « 📖 Lire » du bot, ou envoie /lecteur au bot puis touche « 💻 Activer sur ce navigateur ».";
const SCHEDULED_HELP =
  "Les pages déjà traduites par les agents s'affichent en français. Les autres sont programmées : les agents les traduisent automatiquement à leur prochain passage (environ toutes les 3 h), sans rien à faire de ta part.";

async function checkAccess() {
  try {
    const status = await (await api("/reader/status")).json();
    state.instant = Boolean(status.translate);
    state.canTranslate = true;
    return true;
  } catch (error) {
    showNotice(`Le service de traduction ne répond pas (${error.message}). L'article reste lisible en anglais ; réessaie plus tard.`);
    return false;
  }
}

// ─── Translation (local cache → worker cache → Gemini) ──────────────────────

function cacheRead(hash) {
  const raw = storageGet(localStorage, CACHE_PREFIX + hash);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (_error) {
    return null;
  }
}

function cacheWrite(hash, value) {
  if (storageSet(localStorage, CACHE_PREFIX + hash, JSON.stringify(value))) return;
  // Storage full: drop half of the old translations, then retry once.
  try {
    const keys = Object.keys(localStorage).filter((key) => key.startsWith(CACHE_PREFIX));
    keys.slice(0, Math.ceil(keys.length / 2)).forEach((key) => localStorage.removeItem(key));
  } catch (_error) {
    return;
  }
  storageSet(localStorage, CACHE_PREFIX + hash, JSON.stringify(value));
}

async function translateTexts(texts) {
  const output = [];
  let fromCache = true;
  for (const part of chunks(texts)) {
    const hash = await sha256(JSON.stringify(part));
    let french = cacheRead(hash);
    if (!french) {
      fromCache = false;
      const result = await (
        await api("/reader/translate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ texts: part, doc: state.doc }),
        })
      ).json();
      // 202: not translated yet, the paper is queued for the agents' next run.
      if (!result.ok) throw new ReaderError(result.queued ? "queued" : result.error || "no-url", 202);
      french = result.fr;
      cacheWrite(hash, french);
    }
    output.push(...part.map((_text, index) => french[index] ?? null));
  }
  return { french: output, fromCache };
}

// ─── Pages ───────────────────────────────────────────────────────────────────

function availableWidth() {
  const width = Math.min(document.documentElement.clientWidth - 16, 1500);
  if (state.mode === "both" && width >= 760) return (width - 12) / 2;
  return Math.min(width, 980);
}

function label(text) {
  return element("span", "label", text);
}

function setPageStatus(entry) {
  const status = entry.statusEl;
  status.replaceChildren();
  const prefix = `Page ${entry.index + 1}/${state.entries.length} · `;
  if (!state.canTranslate) {
    status.textContent = `${prefix}original anglais`;
    return;
  }
  const labels = {
    waiting: "extraction du texte…",
    pending: "traduction en attente",
    running: "🇫🇷 traduction en cours…",
    done: entry.fromCache ? "🇫🇷 traduite (déjà en mémoire)" : "🇫🇷 traduite",
    empty: "rien à traduire (figures, formules ou références)",
    queued: "⏳ traduction programmée : les agents la font au prochain passage (≈ 3 h)",
    local: "🇬🇧 original (un fichier de ton appareil n'est traduit qu'en traduction instantanée)",
  };
  if (entry.translation === "error") {
    status.textContent = `${prefix}⚠️ traduction impossible (${entry.error})`;
    const retry = element("button", "", "Réessayer");
    retry.type = "button";
    retry.addEventListener("click", () => {
      entry.translation = "pending";
      setPageStatus(entry);
      pumpTranslations();
    });
    status.append(retry);
    return;
  }
  status.textContent = prefix + (labels[entry.translation] || "");
}

function updateFoot() {
  const total = state.entries.length;
  if (!total || !state.canTranslate) {
    $("#foot").hidden = true;
    return;
  }
  const done = state.entries.filter((entry) => ["done", "empty"].includes(entry.translation)).length;
  const queued = state.entries.filter((entry) => entry.translation === "queued").length;
  $("#foot-text").textContent =
    done === total
      ? `🇫🇷 ${total} pages traduites`
      : `🇫🇷 ${done}/${total} pages traduites${queued ? ` · ${queued} programmée(s)` : ""}`;
  $("#foot").hidden = false;
}

function sizeSheets(entry) {
  const width = `${Math.floor(entry.base.width * state.scale)}px`;
  const height = `${Math.floor(entry.base.height * state.scale)}px`;
  for (const sheet of [entry.enSheet, entry.frSheet]) {
    sheet.style.width = width;
    sheet.style.height = height;
  }
}

function backgroundAt(context, dpr, points) {
  let best = [255, 255, 255];
  let bestLight = -1;
  for (const [x, y] of points) {
    try {
      const pixel = context.getImageData(Math.max(0, Math.round(x * dpr)), Math.max(0, Math.round(y * dpr)), 1, 1).data;
      const light = pixel[0] + pixel[1] + pixel[2];
      if (light > bestLight) {
        bestLight = light;
        best = [pixel[0], pixel[1], pixel[2]];
      }
    } catch (_error) {
      return best;
    }
  }
  return best;
}

// Text is laid out at a comfortable size, then scaled down with a transform:
// phone browsers enlarge tiny fonts ("font boosting"), not transformed text.
const LAYOUT_FONT = 16;

function fitText(inner, startSize, width, height) {
  const fits = (size) => {
    const factor = LAYOUT_FONT / size;
    inner.style.width = `${width * factor}px`;
    inner.style.transform = `scale(${1 / factor})`;
    return inner.scrollHeight / factor <= height + 1;
  };
  let high = Math.max(startSize, 2);
  if (fits(high)) return;
  let low = 2;
  for (let step = 0; step < 8; step += 1) {
    const middle = (low + high) / 2;
    if (fits(middle)) low = middle;
    else high = middle;
  }
  fits(low);
}

function paintFrench(entry) {
  if (!entry.canvas) return;
  const copy = element("canvas");
  copy.width = entry.canvas.width;
  copy.height = entry.canvas.height;
  copy.style.width = entry.canvas.style.width;
  copy.style.height = entry.canvas.style.height;
  const context = copy.getContext("2d", { willReadFrequently: true });
  context.drawImage(entry.canvas, 0, 0);
  const overlay = element("div", "overlay");
  const ready = entry.translation === "done";
  entry.frSheet.replaceChildren(copy, overlay, label(ready ? `FR · p. ${entry.index + 1}` : "FR · traduction…"));
  if (!ready) return;
  for (const block of entry.blocks) {
    if (!block.translate || !block.fr) continue;
    const [x0, y0, x1, y1] = entry.viewport.convertToViewportRectangle(block.rect);
    const left = Math.min(x0, x1);
    const top = Math.min(y0, y1);
    const width = Math.abs(x1 - x0);
    const height = Math.abs(y1 - y0);
    const [red, green, blue] = backgroundAt(context, entry.dpr, [
      [left - 2, top - 2],
      [left + width + 2, top - 2],
      [left - 2, top + height + 2],
      [left + width + 2, top + height + 2],
    ]);
    const node = element("div", `block${block.heading ? " heading" : ""}${red + green + blue < 300 ? " dark" : ""}`);
    const inner = element("div", "block-text", block.fr);
    node.append(inner);
    node.lang = "fr";
    node.title = block.text;
    node.style.left = `${left}px`;
    node.style.top = `${top}px`;
    node.style.width = `${width}px`;
    node.style.height = `${height}px`;
    node.style.background = `rgb(${red}, ${green}, ${blue})`;
    node.addEventListener("click", () => {
      const showEnglish = !node.classList.contains("show-en");
      node.classList.toggle("show-en", showEnglish);
      node.lang = showEnglish ? "en" : "fr";
      inner.textContent = showEnglish ? block.text : block.fr;
      fitText(inner, block.size * state.scale * 0.95, width, height);
    });
    overlay.append(node);
    fitText(inner, block.size * state.scale * 0.95, width, height);
  }
}

async function renderEntry(entry) {
  if (entry.rendering || entry.renderedScale === state.scale) return;
  entry.rendering = true;
  const scale = state.scale;
  const viewport = entry.page.getViewport({ scale });
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const canvas = element("canvas");
  canvas.width = Math.floor(viewport.width * dpr);
  canvas.height = Math.floor(viewport.height * dpr);
  canvas.style.width = `${Math.floor(viewport.width)}px`;
  canvas.style.height = `${Math.floor(viewport.height)}px`;
  try {
    await entry.page.render({
      canvasContext: canvas.getContext("2d"),
      viewport,
      transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
    }).promise;
  } catch (error) {
    entry.rendering = false;
    entry.statusEl.textContent = `Page ${entry.index + 1} : affichage impossible (${error.message})`;
    return;
  }
  entry.rendering = false;
  if (scale !== state.scale) return; // zoom changed meanwhile: the next pass redraws
  entry.canvas = canvas;
  entry.viewport = viewport;
  entry.dpr = dpr;
  entry.renderedScale = scale;
  entry.enSheet.replaceChildren(canvas, label(`EN · p. ${entry.index + 1}`));
  paintFrench(entry);
}

function releaseEntry(entry) {
  if (!entry.canvas) return;
  entry.canvas.width = 0;
  entry.canvas = null;
  entry.renderedScale = null;
  entry.enSheet.replaceChildren(label(`EN · p. ${entry.index + 1}`));
  entry.frSheet.replaceChildren(label(`FR · p. ${entry.index + 1}`));
}

function updateRendering() {
  const visible = state.entries.filter((entry) => entry.visible).map((entry) => entry.index);
  if (visible.length) {
    const first = Math.min(...visible) - 1;
    const last = Math.max(...visible) + 1;
    for (const entry of state.entries) {
      if (entry.index >= first && entry.index <= last) void renderEntry(entry);
      else if (entry.index < first - 2 || entry.index > last + 2) releaseEntry(entry);
    }
  }
  pumpTranslations();
}

function pumpTranslations() {
  if (!state.canTranslate || state.mode === "en") return;
  while (state.active < PARALLEL_PAGES) {
    const pending = state.entries.filter((entry) => entry.translation === "pending");
    const next = pending.find((entry) => entry.visible) || pending[0];
    if (!next) return;
    state.active += 1;
    next.translation = "running";
    setPageStatus(next);
    void translateEntry(next).finally(() => {
      state.active -= 1;
      updateFoot();
      pumpTranslations();
    });
  }
}

async function translateEntry(entry) {
  const blocks = entry.blocks.filter((block) => block.translate);
  if (!blocks.length) {
    entry.translation = "empty";
  } else {
    try {
      const { french, fromCache } = await translateTexts(blocks.map((block) => block.text));
      blocks.forEach((block, index) => {
        block.fr = french[index];
      });
      entry.fromCache = fromCache;
      entry.translation = "done";
    } catch (error) {
      if (error.status === 202) {
        entry.translation = state.doc.url ? "queued" : "local";
        showNotice(
          state.doc.url
            ? SCHEDULED_HELP
            : "Un fichier de ton appareil ne peut pas être traduit à l'avance par les agents : il faut la traduction instantanée (sur ton PC, double-clic sur ACTIVER-LECTEUR.bat, une seule fois). En attendant, ouvre plutôt l'article depuis la bibliothèque ou un lien.",
        );
      } else {
        entry.translation = "error";
        entry.error = error.message;
      }
    }
  }
  if (entry.canvas) paintFrench(entry);
  setPageStatus(entry);
}

function relayout() {
  if (!state.entries.length) return;
  state.scale = (availableWidth() / state.entries[0].base.width) * state.zoom;
  for (const entry of state.entries) {
    releaseEntry(entry);
    sizeSheets(entry);
  }
  updateRendering();
}

async function openDocument(data, meta = {}) {
  setStatus("Ouverture du PDF…");
  const pdf = await pdfjsLib.getDocument({
    data,
    isEvalSupported: false,
    standardFontDataUrl: new URL("./vendor/pdfjs/standard_fonts/", import.meta.url).href,
  }).promise;
  $("#picker").hidden = true;
  const container = $("#pages");
  container.replaceChildren();
  state.entries = [];
  state.references = { inReferences: false };
  for (let number = 1; number <= pdf.numPages; number += 1) {
    const page = await pdf.getPage(number);
    const section = element("section", "page");
    section.id = `page-${number}`;
    const pair = element("div", "page-pair");
    const enSheet = element("div", "sheet en");
    const frSheet = element("div", "sheet fr");
    enSheet.append(label(`EN · p. ${number}`));
    frSheet.append(label(`FR · p. ${number}`));
    pair.append(enSheet, frSheet);
    const statusEl = element("p", "page-status");
    section.append(pair, statusEl);
    container.append(section);
    state.entries.push({
      index: number - 1,
      page,
      base: page.getViewport({ scale: 1 }),
      el: section,
      enSheet,
      frSheet,
      statusEl,
      blocks: null,
      translation: "waiting",
      visible: false,
    });
  }
  state.scale = (availableWidth() / state.entries[0].base.width) * state.zoom;
  state.entries.forEach(sizeSheets);
  setStatus(`${meta.title || "PDF"} · ${pdf.numPages} page(s)${state.canTranslate ? " · traduction page par page" : ""}`);
  const observer = new IntersectionObserver(
    (changes) => {
      for (const change of changes) {
        const entry = state.entries.find((candidate) => candidate.el === change.target);
        if (entry) entry.visible = change.isIntersecting;
      }
      updateRendering();
    },
    { rootMargin: "900px 0px" },
  );
  state.entries.forEach((entry) => observer.observe(entry.el));
  // Text of every page, in order (the bibliography detection needs the order).
  for (const entry of state.entries) {
    const content = await entry.page.getTextContent();
    entry.blocks = extractBlocks(content.items);
    markReferences(entry.blocks, state.references);
    entry.translation = "pending";
    setPageStatus(entry);
    pumpTranslations();
  }
  updateFoot();
}

// ─── Sources: paper key, PDF link or local file ─────────────────────────────

async function paperFromIndex(key) {
  try {
    const response = await fetch("data/reader.json", { cache: "no-store" });
    if (!response.ok) return null;
    const index = await response.json();
    return index?.papers?.[key] || null;
  } catch (_error) {
    return null;
  }
}

async function openUrl(url, meta) {
  state.doc = { url, key: meta.key || "", title: meta.title || "" };
  setStatus("Téléchargement du PDF…");
  try {
    const response = await api(`/reader/pdf?url=${encodeURIComponent(url)}`);
    await openDocument(new Uint8Array(await response.arrayBuffer()), meta);
  } catch (error) {
    if (error.status === 403) showNotice(OTHER_LINKS_HELP);
    setStatus(`Impossible d'ouvrir ce PDF : ${error.message === "not-public" ? "lien hors bibliothèque" : error.message}`);
    $("#picker").hidden = false;
  }
}

function showMeta(paper, key) {
  if (!paper) return;
  $("#doc-title").textContent = paper.t || "Article";
  $("#doc-title-fr").textContent = paper.tf ? `🇫🇷 ${paper.tf}` : "";
  document.title = `${paper.t || "Article"} · Lecteur bilingue`;
  if (paper.sheet) {
    const back = $("#back-link");
    back.href = `./#fiches/${encodeURIComponent(key)}`;
    back.textContent = "← Fiche de lecture";
  }
}

function setMode(mode, { persist = true } = {}) {
  const previous = state.mode;
  state.mode = ["en", "fr", "both"].includes(mode) ? mode : "fr";
  if (persist) storageSet(localStorage, STORAGE.mode, state.mode);
  document.body.className = `mode-${state.mode}`;
  document.querySelectorAll("[data-mode]").forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.mode === state.mode));
  });
  if ((previous === "both") !== (state.mode === "both")) relayout();
  else updateRendering();
}

function initControls() {
  document.querySelectorAll("[data-mode]").forEach((button) => {
    button.addEventListener("click", () => setMode(button.dataset.mode));
  });
  const zoom = (factor) => {
    state.zoom = Math.min(Math.max(state.zoom * factor, 0.5), 3);
    storageSet(localStorage, STORAGE.zoom, String(state.zoom));
    relayout();
  };
  $("#zoom-in").addEventListener("click", () => zoom(1.15));
  $("#zoom-out").addEventListener("click", () => zoom(1 / 1.15));
  let lastWidth = document.documentElement.clientWidth;
  let timer = 0;
  window.addEventListener("resize", () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const width = document.documentElement.clientWidth;
      if (Math.abs(width - lastWidth) / lastWidth > 0.1) {
        lastWidth = width;
        relayout();
      }
    }, 300);
  });
  $("#url-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const url = $("#url-input").value.trim();
    if (url) location.search = `?url=${encodeURIComponent(url)}`;
  });
  $("#file-input").addEventListener("change", async () => {
    const file = $("#file-input").files?.[0];
    if (!file) return;
    $("#doc-title").textContent = file.name;
    state.doc = { url: "", key: "", title: file.name };
    try {
      await openDocument(new Uint8Array(await file.arrayBuffer()), { title: file.name });
    } catch (error) {
      setStatus(`Impossible de lire ce fichier : ${error.message}`);
    }
  });
}

async function main() {
  state.auth = launchAuth();
  state.zoom = Number(storageGet(localStorage, STORAGE.zoom)) || 1;
  initControls();
  setMode(storageGet(localStorage, STORAGE.mode) || "fr");
  const access = checkAccess();
  const key = SEARCH.get("k");
  const url = SEARCH.get("url");
  await access;
  // Worker unreachable: the French view would only repeat the original.
  if (!state.canTranslate && state.mode !== "en") setMode("en", { persist: false });
  if (key) {
    const paper = await paperFromIndex(key);
    showMeta(paper, key);
    if (!paper?.pdf) {
      setStatus("Pas de PDF en accès libre connu pour cet article. Colle un lien ou ouvre le fichier.");
      $("#picker").hidden = false;
      return;
    }
    await openUrl(paper.pdf, { title: paper.t, key });
  } else if (url) {
    $("#doc-title").textContent = url.split("/").pop() || "PDF";
    await openUrl(url, { title: url.split("/").pop() });
  } else {
    setStatus("Choisis un article.");
    $("#picker").hidden = false;
  }
}

void main();
