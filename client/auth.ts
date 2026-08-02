import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

export interface AuthConfig {
  username?: string;
  password?: string;
}

export function basicAuthChallenge(res: ServerResponse): void {
  res.writeHead(401, {
    "content-type": "text/plain",
    "www-authenticate": 'Basic realm="opencode-dashboard", charset="UTF-8"',
  });
  res.end("unauthorized");
}

// Constant-time comparison: hash both sides so timingSafeEqual is safe on
// arbitrary-length inputs. Never log credentials.
function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

// True when the request carries valid Basic credentials for `auth`.
export function checkBasicAuth(req: IncomingMessage, auth: AuthConfig): boolean {
  if (!auth.username || !auth.password) return false;
  const header = req.headers.authorization;
  if (!header) return false;
  const m = /^Basic\s+(.+)$/i.exec(header);
  if (!m) return false;
  const decoded = Buffer.from(m[1], "base64").toString("utf8");
  const i = decoded.indexOf(":");
  if (i < 0) return false;
  return safeEqual(decoded.slice(0, i), auth.username) && safeEqual(decoded.slice(i + 1), auth.password);
}
