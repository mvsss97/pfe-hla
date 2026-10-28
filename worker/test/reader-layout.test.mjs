// Offline tests for the reader's paragraph detection (site/reader-layout.js).
import assert from "node:assert/strict";
import { test } from "node:test";

import { chunks, extractBlocks, markReferences } from "../../site/reader-layout.js";

const run = (str, x, y, width, size = 10) => ({ str, transform: [size, 0, 0, size, x, y], width });

test("two columns become separate paragraphs; formulas and stamps stay untouched", () => {
  const items = [
    run("1 Introduction", 50, 700, 70, 12),
    run("Adversarial attacks fool text classifiers with", 50, 680, 230),
    run("small changes that keep the meaning of the in-", 50, 668, 230),
    run("put sentence for human readers.", 50, 656, 150),
    run("max S(X, X*) s.t. F(X*) ≠ y", 90, 630, 140),
    run("The right column explains the hard-label setting", 320, 680, 230),
    run("where only the predicted class is observed.", 320, 668, 210),
    { str: "arXiv:2012.14956v1 [cs.CL]", transform: [0, 10, -10, 0, 20, 300], width: 120 },
  ];
  const blocks = extractBlocks(items);
  assert.deepEqual(blocks.map((block) => block.text), [
    "1 Introduction",
    "Adversarial attacks fool text classifiers with small changes that keep the meaning of the input sentence for human readers.",
    "max S(X, X*) s.t. F(X*) ≠ y",
    "The right column explains the hard-label setting where only the predicted class is observed.",
  ]);
  assert.deepEqual(blocks.map((block) => block.translate), [true, true, false, true]);
  assert.equal(blocks[0].heading, true);
  const [x0, yBottom, x1, yTop] = blocks[1].rect;
  assert.ok(x0 === 50 && x1 === 280 && yBottom < 656 && yTop > 680);
});

test("the bibliography is skipped, an appendix after it is translated", () => {
  const context = { inReferences: false };
  const page = extractBlocks([
    run("References", 50, 700, 60, 12),
    run("Jin, D.; Jin, Z.; Zhou, J. T.; and Szolovits, P. 2020. Is BERT really robust?", 50, 680, 240),
    run("A Appendix", 50, 400, 60, 12),
    run("We report the full results for every dataset in this appendix section.", 50, 380, 240),
  ]);
  markReferences(page, context);
  assert.deepEqual(page.map((block) => block.translate), [false, false, true, true]);
  assert.equal(context.inReferences, false);
});

test("pages are split into requests the worker accepts", () => {
  const parts = chunks(["a".repeat(10), "b".repeat(10), "c".repeat(10)], 2, 25);
  assert.deepEqual(parts.map((part) => part.length), [2, 1]);
  assert.equal(chunks(Array(250).fill("x")).length, 3);
});
