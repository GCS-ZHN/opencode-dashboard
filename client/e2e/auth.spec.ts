import { test, expect, request } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";

// Basic-auth behavior, verified at the HTTP level:
//  - the main (config.none) instance has NO auth configured → open, no prompt.
//  - a separate instance spawned with config.auth.yaml rejects without creds
//    (401) and accepts correct Basic credentials.

const AUTH_PORT = 5283;

async function waitForPort(port: number): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/config`);
      if (res.status !== 404) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`server on :${port} did not come up`);
}

let server: ChildProcess | null = null;

test.beforeAll(async () => {
  server = spawn("node", ["dist-cli/cli.mjs", "serve", "--port", String(AUTH_PORT)], {
    env: { ...process.env, DASHBOARD_CONFIG: "e2e/config.auth.yaml" },
    stdio: "ignore",
  });
  await waitForPort(AUTH_PORT);
});

test.afterAll(() => {
  server?.kill();
});

test("no-auth instance is open without any credentials", async () => {
  const ctx = await request.newContext({ baseURL: "http://127.0.0.1:5282" });
  const res = await ctx.get("/api/config");
  expect(res.status()).toBe(200);
});

test("configured auth rejects anonymous and accepts Basic credentials", async () => {
  const ctx = await request.newContext({ baseURL: `http://127.0.0.1:${AUTH_PORT}` });
  const anon = await ctx.get("/api/config");
  expect(anon.status()).toBe(401);
  const www = anon.headers()["www-authenticate"] ?? "";
  expect(www.toLowerCase()).toContain("basic");
  const auth = await ctx.get("/api/config", {
    headers: { Authorization: "Basic " + Buffer.from("admin:secret").toString("base64") },
  });
  expect(auth.status()).toBe(200);
  const wrong = await ctx.get("/api/config", {
    headers: { Authorization: "Basic " + Buffer.from("admin:nope").toString("base64") },
  });
  expect(wrong.status()).toBe(401);
});
