// Tests for the HTTP basic-auth boundary (client/auth.ts) and the numeric-YAML
// config guard (client/config.ts). Run: bun test auth.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { checkBasicAuth } from "./auth.ts";
import { loadDashboardConfig } from "./config.ts";

const auth = { username: "u", password: "p" };
const basic = (u, p) => "Basic " + Buffer.from(`${u}:${p}`).toString("base64");
// checkBasicAuth only reads headers; a plain object suffices.
const req = (authorization) => ({ headers: authorization ? { authorization } : {} });

test("checkBasicAuth accepts valid credentials", () => {
  assert.equal(checkBasicAuth(req(basic("u", "p")), auth), true);
});

test("checkBasicAuth rejects wrong password", () => {
  assert.equal(checkBasicAuth(req(basic("u", "nope")), auth), false);
});

test("checkBasicAuth rejects wrong user", () => {
  assert.equal(checkBasicAuth(req(basic("nope", "p")), auth), false);
});

test("checkBasicAuth rejects missing header", () => {
  assert.equal(checkBasicAuth(req(), auth), false);
});

test("checkBasicAuth rejects a non-Basic scheme", () => {
  assert.equal(checkBasicAuth(req("Bearer token"), auth), false);
});

test("checkBasicAuth rejects garbage base64", () => {
  assert.equal(checkBasicAuth(req("Basic @@@@@@@@"), auth), false);
});

test("checkBasicAuth rejects decoded credentials without a colon", () => {
  assert.equal(checkBasicAuth(req("Basic " + Buffer.from("abc").toString("base64")), auth), false);
});

test("numeric YAML password raises a clean config error, not a crash", () => {
  delete process.env.DASHBOARD_AUTH_USERNAME;
  delete process.env.DASHBOARD_AUTH_PASSWORD;
  const dir = mkdtempSync(join(tmpdir(), "ocd-auth-"));
  const path = join(dir, "config.yaml");
  writeFileSync(path, "auth:\n  username: u\n  password: 123456\n");
  assert.throws(() => loadDashboardConfig(path), /invalid auth\.password/);
});
