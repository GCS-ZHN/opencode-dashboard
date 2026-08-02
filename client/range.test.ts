// Assert-based checks for the time-range window math (DST-safe nextDay).
// Run: bun test range.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";

// Deterministic DST fall-back case regardless of the runner's own timezone.
process.env.TZ = "America/New_York";

import { computeRange, nextDay, startOfDay } from "./src/range";

test("nextDay stays on midnight across a DST fall-back day", () => {
  // 2026-11-01 is the fall-back day in America/New_York (02:00 EDT -> 01:00 EST).
  // The absolute +86_400_000ms shortcut would land at 23:00 and floor back to
  // the same midnight; calendar arithmetic must reach 2026-11-02T00:00.
  const fallBack = new Date("2026-11-01T00:00:00").getTime();
  const nd = nextDay(fallBack);
  assert.ok(nd > fallBack);
  const d = new Date(nd);
  assert.equal(d.getHours(), 0);
  assert.equal(d.getMonth() + 1, 11);
  assert.equal(d.getDate(), 2);
});

test("until-of-a-day covers that whole day", () => {
  const until = nextDay(new Date("2026-11-01T00:00:00").getTime());
  assert.ok(new Date("2026-11-01T23:59:59").getTime() < until); // inside
  assert.ok(new Date("2026-11-02T00:00:00").getTime() >= until); // excluded
});

test("today preset spans the current local day", () => {
  const now = new Date("2026-08-02T15:30:00").getTime();
  const r = computeRange("today", now);
  assert.deepEqual(r, { since: startOfDay(new Date(now)), until: nextDay(now) });
});

test("custom preset builds a half-open window ending after the until day", () => {
  const r = computeRange("custom", 0, "2026-08-01", "2026-08-02");
  assert.equal(r?.since, new Date("2026-08-01T00:00:00").getTime());
  assert.equal(r?.until, nextDay(new Date("2026-08-02T00:00:00").getTime()));
  assert.ok(new Date("2026-08-02T23:59:00").getTime() < (r?.until ?? 0));
});

test("inverted custom window is swapped", () => {
  const r = computeRange("custom", 0, "2026-08-05", "2026-08-01");
  assert.equal(r?.since, new Date("2026-08-01T00:00:00").getTime());
  assert.equal(r?.until, nextDay(new Date("2026-08-05T00:00:00").getTime()));
});

test("empty custom inputs return null", () => {
  assert.equal(computeRange("custom", 0), null);
});
