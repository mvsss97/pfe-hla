// Page translation for the bilingual PDF reader, shared by the Cloudflare
// worker (on demand) and the GitHub Actions pipeline (ahead of time):
// both produce the same cache keys, so a page translated by one is read by
// the other.

// Fast free Gemini models first (latency measured 2026-10-28).
export const READER_MODELS = ["gemini-3.5-flash-lite", "gemini-flash-lite-latest", "gemini-3.1-flash-lite", "gemini-3.5-flash"];
export const READER_CACHE_VERSION = "v1";

export const READER_PROMPT = [
  "Tu traduis des blocs de texte extraits d'une page d'article scientifique (attaques adversariales, NLP, sécurité de l'IA) de l'anglais vers le français.",
  "Règles : traduction fidèle et naturelle, en français scientifique ; un bloc traduit par bloc reçu, même identifiant `i` ;",
  "ne fusionne pas et ne coupe pas les blocs ; garde inchangés les formules, variables, chiffres, citations ([12], (Jin et al., 2020)), URL, noms de méthodes, de modèles et de jeux de données ;",
  "un bloc qui n'est pas du texte anglais (équation, nombre, code, nom propre seul) est recopié tel quel.",
  "Glossaire : adversarial → adversarial, accordé normalement (adversariale, adversariaux, adversariales ; jamais « contradictoire ») ; hard-label → étiquette seule (hard-label) ; black-box → boîte noire ; query → requête ;",
  "word importance ranking → classement d'importance des mots ; attack success rate → taux de succès de l'attaque ; robustness → robustesse ; embedding → plongement (embedding).",
].join(" ");

export async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Identity of one translation request: the exact list of English blocks. */
export function translationHash(texts) {
  return sha256Hex(JSON.stringify(texts));
}

export function translationKey(hash) {
  return `tr:${READER_CACHE_VERSION}:${hash}`;
}

function requestBody(texts) {
  return {
    systemInstruction: { parts: [{ text: READER_PROMPT }] },
    contents: [{ role: "user", parts: [{ text: JSON.stringify(texts.map((text, i) => ({ i, en: text }))) }] }],
    generationConfig: {
      responseMimeType: "application/json",
      responseJsonSchema: {
        type: "object",
        properties: {
          blocks: {
            type: "array",
            items: {
              type: "object",
              properties: { i: { type: "integer" }, fr: { type: "string" } },
              required: ["i", "fr"],
            },
          },
        },
        required: ["blocks"],
      },
      temperature: 0.1,
      maxOutputTokens: 32768,
    },
  };
}

/**
 * Translate English blocks with the free Gemini key. Busy, retired or
 * incomplete models are skipped for the next one. Returns { fr, model };
 * a block the model forgot stays null (the reader keeps the English there).
 */
export async function geminiTranslate(apiKey, texts, { fetchImpl = fetch, timeoutMs = 60000 } = {}) {
  const body = JSON.stringify(requestBody(texts));
  let last = "no model";
  for (const model of READER_MODELS) {
    try {
      const response = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        last = `${model}: HTTP ${response.status}`;
        continue;
      }
      const data = await response.json();
      const parts = data?.candidates?.[0]?.content?.parts || [];
      const parsed = JSON.parse(parts.filter((part) => !part.thought).map((part) => part.text || "").join(""));
      const french = texts.map(() => null);
      for (const block of parsed.blocks || []) {
        if (Number.isInteger(block.i) && block.i >= 0 && block.i < texts.length && typeof block.fr === "string") french[block.i] = block.fr;
      }
      const missing = french.filter((value) => value === null).length;
      if (missing > texts.length / 4) {
        last = `${model}: ${missing} bloc(s) manquant(s)`;
        continue;
      }
      return { fr: french, model: data.modelVersion || model };
    } catch (error) {
      last = `${model}: ${error.name || "error"}`;
    }
  }
  throw new Error(`traduction impossible (${last})`);
}
