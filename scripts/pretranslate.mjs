// Translate PDFs ahead of time for the bilingual reader (run by GitHub Actions).
//
// The pages are split exactly like site/reader.js does (same PDF.js build, same
// site/reader-layout.js), so the cache keys match what the reader asks for.
// Order: papers the student opened (queued by the worker), then the
// supervisor's list by priority, then papers that have a reading sheet.
// Env: WORKER_URL, PIPELINE_SECRET, GEMINI_API_KEY, READER_PAGE_BUDGET.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const moduleUrl = (relative) => pathToFileURL(join(ROOT, relative)).href;

const { WORKER_URL = "", PIPELINE_SECRET = "", GEMINI_API_KEY = "" } = process.env;
let budget = Number(process.env.READER_PAGE_BUDGET || 30);

if (!WORKER_URL || !PIPELINE_SECRET || !GEMINI_API_KEY) {
  console.log("Pre-translation skipped: WORKER_URL, PIPELINE_SECRET or GEMINI_API_KEY missing.");
  process.exit(0);
}

const pdfjs = await import(moduleUrl("site/vendor/pdfjs/pdf.min.js"));
pdfjs.GlobalWorkerOptions.workerSrc = moduleUrl("site/vendor/pdfjs/pdf.worker.min.js");
const { chunks, extractBlocks, markReferences } = await import(moduleUrl("site/reader-layout.js"));
const { geminiTranslate, translationHash } = await import(moduleUrl("worker/src/translate.js"));

async function worker(path, body) {
  const response = await fetch(`${WORKER_URL.replace(/\/+$/, "")}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { Authorization: `Bearer ${PIPELINE_SECRET}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return response.json();
}

function readJson(relative, fallback) {
  try {
    return JSON.parse(readFileSync(join(ROOT, relative), "utf8"));
  } catch (_error) {
    return fallback;
  }
}

function candidates(state) {
  const index = readJson("site/data/reader.json", { papers: {} }).papers || {};
  const site = readJson("site/data/state.json", {});
  const list = [];
  const seen = new Set(Object.keys(state.done || {}));
  const add = (url, title) => {
    if (url && !seen.has(url)) {
      seen.add(url);
      list.push({ url, title: title || url });
    }
  };
  for (const [url, info] of Object.entries(state.wanted || {}).sort(([, a], [, b]) => String(a.at).localeCompare(String(b.at)))) {
    add(url, info.title);
  }
  const supervisor = [...(site.supervisor?.papers || [])].sort((a, b) => (a.priority || 9) - (b.priority || 9));
  for (const paper of supervisor) if ((paper.priority || 9) <= 2) add(paper.pdf || index[paper.key]?.pdf, paper.title);
  for (const paper of Object.values(index)) if (paper.sheet) add(paper.pdf, paper.t);
  return list;
}

async function download(url) {
  const response = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; PFE-HLA-Reader/pipeline)", Accept: "application/pdf,*/*" } });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (String.fromCharCode(...bytes.slice(0, 4)) !== "%PDF") throw new Error("not a PDF");
  return bytes;
}

/** Every translation request the reader will make for this PDF, in order. */
async function requests(bytes) {
  const pdf = await pdfjs.getDocument({
    data: bytes,
    isEvalSupported: false,
    standardFontDataUrl: join(ROOT, "site/vendor/pdfjs/standard_fonts/").replaceAll("\\", "/"),
    verbosity: 0,
  }).promise;
  const context = { inReferences: false };
  const parts = [];
  for (let number = 1; number <= pdf.numPages; number += 1) {
    const page = await pdf.getPage(number);
    const blocks = extractBlocks((await page.getTextContent()).items);
    markReferences(blocks, context);
    const texts = blocks.filter((block) => block.translate).map((block) => block.text);
    if (texts.length) parts.push(...chunks(texts));
  }
  await pdf.destroy();
  return parts;
}

const state = await worker("/api/translations/state");
const queue = candidates(state);
let translated = 0;
let finished = 0;
console.log(`Pre-translation: ${queue.length} paper(s) waiting, budget ${budget} page request(s).`);
for (const doc of queue) {
  if (budget <= 0) break;
  let parts;
  try {
    parts = await requests(await download(doc.url));
  } catch (error) {
    console.log(`- ${doc.title.slice(0, 70)}: skipped (${error.message})`);
    continue;
  }
  const hashes = await Promise.all(parts.map((texts) => translationHash(texts)));
  const missing = new Set((await worker("/api/translations/missing", { hashes })).missing);
  let entries = [];
  let failed = false;
  for (let index = 0; index < parts.length && budget > 0; index += 1) {
    if (!missing.has(hashes[index])) continue;
    try {
      const result = await geminiTranslate(GEMINI_API_KEY, parts[index]);
      entries.push({ hash: hashes[index], fr: result.fr, model: result.model });
      missing.delete(hashes[index]);
      translated += 1;
      budget -= 1;
    } catch (error) {
      console.log(`  page request ${index + 1}: ${error.message}`);
      failed = true;
      break;
    }
    if (entries.length >= 8) {
      await worker("/api/translations", { entries });
      entries = [];
    }
  }
  const complete = !failed && missing.size === 0;
  await worker("/api/translations", { entries, done: complete ? [doc.url] : [] });
  if (complete) finished += 1;
  console.log(`- ${doc.title.slice(0, 70)}: ${parts.length - missing.size}/${parts.length} page request(s) ready${complete ? " ✓" : ""}`);
  if (failed) break; // Gemini is busy or out of quota: the next run continues.
}
console.log(`Pre-translation: ${translated} page request(s) translated, ${finished} paper(s) complete.`);
