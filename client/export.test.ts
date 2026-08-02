// Assert-based checks for the sheet-name sanitization + dedupe logic.
// Run: bun test export.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";

import { sheetName } from "./src/export";

test("sheetName strips forbidden characters", () => {
  assert.equal(sheetName("a:b"), "a_b");
  assert.equal(sheetName("a?b"), "a_b");
  assert.equal(sheetName("a*b"), "a_b");
  assert.equal(sheetName("a[b]"), "a_b_");
  assert.equal(sheetName("a\\b"), "a_b");
  assert.equal(sheetName("a/b"), "a_b");
});

test("sheetName truncates to 31 chars", () => {
  const long = "x".repeat(50);
  assert.equal(sheetName(long).length, 31);
});

test("sheetName collisions after sanitization resolve via dedupe", () => {
  // "a:b" and "a?b" both sanitize to "a_b"; the dedupe loop must append " (2)".
  const used = new Set<string>();
  const names = ["a:b", "a?b"];
  const out = names.map((n) => {
    let name = sheetName(n);
    for (let i = 2; used.has(name); i++) name = `${sheetName(n).slice(0, 28)} (${i})`;
    used.add(name);
    return name;
  });
  assert.deepEqual(out, ["a_b", "a_b (2)"]);
});
