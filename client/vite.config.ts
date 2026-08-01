import { defineConfig } from "vite";
import { servers } from "./src/config";

// Front-end server: the browser only talks to this dev server. Requests to
// /api/s/{i}/* are proxied to servers[i].url, so real backends stay hidden.
const proxy = Object.fromEntries(
  servers.map((s, i) => [
    `/api/s/${i}`,
    {
      target: s.url,
      changeOrigin: true,
      rewrite: (path: string) => path.replace(`/api/s/${i}`, ""),
    },
  ]),
);

export default defineConfig({ server: { proxy } });
