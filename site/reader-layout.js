// Text layout for the bilingual reader: PDF.js text runs → lines → paragraphs.
// Pure functions (no DOM), shared by reader.js and the offline tests.

/** Body font size: the size that carries the most characters on the page. */
export function bodySize(lines) {
  const weight = new Map();
  for (const line of lines) {
    const size = Math.round(line.size * 2) / 2;
    weight.set(size, (weight.get(size) || 0) + line.text.length);
  }
  let best = 10;
  let bestWeight = -1;
  for (const [size, chars] of weight) {
    if (chars > bestWeight) {
      best = size;
      bestWeight = chars;
    }
  }
  return best;
}

export function joinLines(lines) {
  let text = "";
  for (const line of lines) {
    const part = line.text.replace(/\s+/g, " ").trim();
    if (!part) continue;
    if (!text) text = part;
    else if (/[A-Za-z]-$/.test(text) && /^[a-z]/.test(part)) text = text.slice(0, -1) + part;
    else text += ` ${part}`;
  }
  return text;
}

/** Prose worth translating: not an equation, a number, a lone name or a table cell. */
export function isTranslatable(text) {
  const letters = (text.match(/[A-Za-z]/g) || []).length;
  const words = (text.match(/[A-Za-z]{2,}/g) || []).length;
  return letters >= 12 && words >= 3 && letters / text.length > 0.55;
}

/**
 * Group the text items of one page into paragraphs.
 * Each paragraph keeps its rectangle in PDF user space [x0, yBottom, x1, yTop].
 */
export function extractBlocks(items) {
  // 1. Horizontal text runs (rotated text such as the arXiv margin stamp stays as is).
  const runs = [];
  for (const item of items) {
    if (!item.str || !item.str.trim()) continue;
    const [a, b, c, d, x, y] = item.transform;
    if (Math.abs(b) > 0.01 || Math.abs(c) > 0.01 || a <= 0 || d <= 0) continue;
    runs.push({ text: item.str, x, y, x2: x + item.width, size: d });
  }
  // 2. Lines, following the content order of the PDF (LaTeX writes column by column).
  const lines = [];
  let line = null;
  for (const run of runs) {
    const size = line ? Math.max(run.size, line.size) : run.size;
    const gap = line ? run.x - line.x2 : 0;
    if (line && Math.abs(run.y - line.y) < 0.6 * size && gap < 1.5 * size && gap > -2 * size) {
      const space = gap > 0.18 * run.size && !line.text.endsWith(" ") && !run.text.startsWith(" ");
      line.text += space ? ` ${run.text}` : run.text;
      line.x2 = Math.max(line.x2, run.x2);
      if (run.size > line.size * 1.05) {
        line.size = run.size;
        line.y = run.y;
      }
    } else {
      line = { text: run.text, x: run.x, x2: run.x2, y: run.y, size: run.size };
      lines.push(line);
    }
  }
  // 3. Paragraphs: consecutive lines of the same size, a normal line step and overlapping columns.
  const groups = [];
  let group = null;
  for (const current of lines) {
    if (!current.text.trim()) continue;
    const previous = group?.lines[group.lines.length - 1];
    const step = previous ? previous.y - current.y : 0;
    const joins =
      group &&
      Math.abs(current.size - group.size) < 0.1 * Math.min(current.size, group.size) &&
      step > 0.3 * group.size &&
      step < 1.75 * group.size &&
      current.x < group.x2 - group.size &&
      current.x2 > group.x0 + group.size &&
      current.x > group.x0 - 3 * group.size;
    if (joins) {
      group.lines.push(current);
      group.x0 = Math.min(group.x0, current.x);
      group.x2 = Math.max(group.x2, current.x2);
    } else {
      group = { lines: [current], x0: current.x, x2: current.x2, size: current.size };
      groups.push(group);
    }
  }
  const body = bodySize(lines);
  return groups.map((paragraph) => {
    const text = joinLines(paragraph.lines);
    const heading = paragraph.size > body * 1.12;
    const letters = (text.match(/[A-Za-z]/g) || []).length;
    return {
      text,
      size: paragraph.size,
      heading,
      rect: [
        paragraph.x0,
        Math.min(...paragraph.lines.map((item) => item.y - 0.24 * item.size)),
        paragraph.x2,
        Math.max(...paragraph.lines.map((item) => item.y + 0.82 * item.size)),
      ],
      // Short section titles ("Related Work") are translated too.
      translate: isTranslatable(text) || (heading && letters >= 4 && letters / text.length > 0.6),
      fr: null,
    };
  });
}

/**
 * The bibliography is not translated; an appendix after it is.
 * `context.inReferences` carries the state from one page to the next.
 */
export function markReferences(blocks, context) {
  for (const block of blocks) {
    const text = block.text.trim();
    if (/^(\d+\.?\s*)?(references|bibliography)$/i.test(text)) {
      context.inReferences = true;
      block.translate = false;
    } else if (context.inReferences && (block.heading || /^([A-Z](\.\d+)*\s+)?appendix/i.test(text))) {
      context.inReferences = false;
    } else if (context.inReferences) {
      block.translate = false;
    }
  }
}

/** Split a page into requests the worker accepts (block count and size limits). */
export function chunks(texts, maxBlocks = 120, maxChars = 18000) {
  const result = [];
  let current = [];
  let size = 0;
  for (const text of texts) {
    const part = text.slice(0, maxChars);
    if (current.length && (current.length >= maxBlocks || size + part.length > maxChars)) {
      result.push(current);
      current = [];
      size = 0;
    }
    current.push(part);
    size += part.length;
  }
  if (current.length) result.push(current);
  return result;
}
