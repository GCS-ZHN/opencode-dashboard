// Smoke test for the MCP handler: initialize, tools/list, tools/call over a
// real node:http server (the CLI runtime), against a stub backend.
// Run: node --test mcp.test.mjs
import { createServer } from "node:http";
import { test } from "node:test";
import assert from "node:assert/strict";

// Import the TS source via bun (this file is meant to run with `bun test` /
// `bun --test`, matching the repo's bun toolchain).
import { createMcpHandler } from "./mcp.ts";

const OVERVIEW = { host: "stub", opencodeVersion: "1.0", projectCount: 0, sessionCount: 0, tokens: { total: 0 }, cost: 0, updatedAt: 1 };

const cfg = {
  servers: [
    { name: "stub", url: "http://127.0.0.1:1" }, // real backend never contacted for the tools under test
  ],
  host: "0.0.0.0",
  port: 0,
  ui: { sessionPage: 30 },
};

async function startServer() {
  const handler = createMcpHandler(cfg);
  const srv = createServer((req, res) => void handler(req, res));
  await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const port = srv.address().port;
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => srv.close(resolve)),
  };
}

async function postJson(base, path, body) {
  const res = await fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, text };
}

test("initialize over /mcp returns SSE with serverInfo", async () => {
  const { base, close } = await startServer();
  try {
    const { status, text } = await postJson(base, "/mcp", {
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } },
    });
    assert.equal(status, 200);
    const data = JSON.parse(text.split("\n").find((l) => l.startsWith("data:"))?.slice(5));
    assert.equal(data.result.serverInfo.name, "opencode-dashboard");
    assert.ok(data.result.capabilities.tools);
  } finally {
    await close();
  }
});

test("/mcp/ (trailing slash) behaves identically", async () => {
  const { base, close } = await startServer();
  try {
    const { status } = await postJson(base, "/mcp/", {
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } },
    });
    assert.equal(status, 200);
  } finally {
    await close();
  }
});

test("tools/list returns the five tools", async () => {
  const { base, close } = await startServer();
  try {
    const { text } = await postJson(base, "/mcp", {
      jsonrpc: "2.0", id: 2, method: "tools/list", params: {},
    });
    const data = JSON.parse(text.split("\n").find((l) => l.startsWith("data:"))?.slice(5));
    assert.equal(data.result.tools.length, 5);
    assert.deepEqual(data.result.tools.map((t) => t.name).sort(),
      ["list_servers", "overview", "project_detail", "projects", "session_detail"]);
  } finally {
    await close();
  }
});

test("tools/call with an out-of-range server index returns an isError result, not a protocol error", async () => {
  const { base, close } = await startServer();
  try {
    const { text } = await postJson(base, "/mcp", {
      jsonrpc: "2.0", id: 3, method: "tools/call",
      params: { name: "overview", arguments: { server: 99 } },
    });
    const data = JSON.parse(text.split("\n").find((l) => l.startsWith("data:"))?.slice(5));
    assert.equal(data.result.isError, true);
    assert.match(data.result.content[0].text, /invalid server/);
  } finally {
    await close();
  }
});

test("list_servers returns configured backends without touching them", async () => {
  const { base, close } = await startServer();
  try {
    const { text } = await postJson(base, "/mcp", {
      jsonrpc: "2.0", id: 4, method: "tools/call",
      params: { name: "list_servers", arguments: {} },
    });
    const data = JSON.parse(text.split("\n").find((l) => l.startsWith("data:"))?.slice(5));
    assert.equal(data.result.isError, undefined);
    assert.match(data.result.content[0].text, /stub/);
  } finally {
    await close();
  }
});
