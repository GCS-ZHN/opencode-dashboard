// MCP (Model Context Protocol) server mounted on the front-end server at
// /mcp (and /mcp/). Exposes read-only tools that proxy the same dashboard
// endpoints the HTTP API serves (/overview, /projects, ...) to the configured
// backends, so MCP clients never talk to real backends directly.
import type { IncomingMessage, ServerResponse } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { DashboardConfig, ServerConfig } from "./config";
import pkg from "./package.json" with { type: "json" };

type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

function int(v: unknown, name: string, servers: ServerConfig[]): number {
  const n = typeof v === "string" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 0 || n >= servers.length) {
    throw new Error(`invalid ${name}: expected an integer in [0, ${servers.length})`);
  }
  return n;
}

// Fetch one API.md endpoint from backend `i` and parse the JSON, mirroring the
// proxy() path in cli.ts. Any non-2xx or unparseable response becomes an error
// that MCP surfaces as a failed tool call.
async function fetchJson(servers: ServerConfig[], i: number, path: string): Promise<unknown> {
  const res = await fetch(servers[i].url + path);
  if (!res.ok) {
    throw new Error(`backend ${servers[i].name}: ${res.status} ${res.statusText} for ${path}`);
  }
  return res.json();
}

const TOOLS = [
  {
    name: "list_servers",
    description: "List the configured dashboard backends (name + base URL).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "overview",
    description: "Aggregate token usage overview for one backend (host, opencode version, totals).",
    inputSchema: {
      type: "object",
      properties: { server: { type: "number", description: "Backend index (see list_servers)" } },
      required: ["server"],
    },
  },
  {
    name: "projects",
    description: "Per-project token usage for one backend.",
    inputSchema: {
      type: "object",
      properties: { server: { type: "number", description: "Backend index (see list_servers)" } },
      required: ["server"],
    },
  },
  {
    name: "project_detail",
    description: "One project plus its sessions for one backend.",
    inputSchema: {
      type: "object",
      properties: {
        server: { type: "number", description: "Backend index (see list_servers)" },
        projectId: { type: "string", description: "Project id (from projects)" },
      },
      required: ["server", "projectId"],
    },
  },
  {
    name: "session_detail",
    description: "One session including its per-model token breakdown for one backend.",
    inputSchema: {
      type: "object",
      properties: {
        server: { type: "number", description: "Backend index (see list_servers)" },
        sessionId: { type: "string", description: "Session id (from project_detail)" },
      },
      required: ["server", "sessionId"],
    },
  },
] as const;

function text(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function toolsResult() {
  return { tools: TOOLS };
}

// Build a server instance with the read-only dashboard tools registered. A
// fresh instance is created per request: the SDK forbids reusing a stateless
// transport (message-id collisions), and Protocol.connect() accepts one
// transport per Server.
function makeServer(cfg: DashboardConfig): Server {
  const server = new Server(
    { name: "opencode-dashboard", version: pkg.version },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, () => toolsResult());

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    const servers = cfg.servers;
    switch (name) {
      case "list_servers":
        return text(servers);
      default:
        break;
    }
    // Validation / backend failures surface as in-band tool errors (MCP
    // convention) so clients can read the message and self-correct, rather
    // than a protocol-level -32603 that most clients just surface raw.
    try {
      switch (name) {
        case "overview":
          return text(await fetchJson(servers, int(args?.server, "server", servers), "/overview"));
        case "projects":
          return text(await fetchJson(servers, int(args?.server, "server", servers), "/projects"));
        case "project_detail":
          return text(
            await fetchJson(
              servers,
              int(args?.server, "server", servers),
              `/projects/${encodeURIComponent(String(args?.projectId))}`,
            ),
          );
        case "session_detail":
          return text(
            await fetchJson(
              servers,
              int(args?.server, "server", servers),
              `/sessions/${encodeURIComponent(String(args?.sessionId))}`,
            ),
          );
        default:
          throw new Error(`unknown tool: ${name}`);
      }
    } catch (e) {
      return {
        content: [{ type: "text" as const, text: e instanceof Error ? e.message : String(e) }],
        isError: true,
      };
    }
  });

  return server;
}

// Mount a stateless MCP endpoint at /mcp (and /mcp/). Each request gets its own
// transport+server pair; read-only tools need no session state, so stateless is
// all we need and every POST/GET is self-contained.
export function createMcpHandler(cfg: DashboardConfig): Handler {
  return async (req, res) => {
    const server = makeServer(cfg);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    await transport.handleRequest(req, res);
  };
}
