export interface ServerConfig {
  name: string;
  url: string;
}

export const servers: ServerConfig[] = [
  { name: "main", url: "http://127.0.0.1:8791" },
  { name: "backup", url: "http://127.0.0.1:8792" },
  { name: "dev", url: "http://127.0.0.1:8793" },
  { name: "staging", url: "http://127.0.0.1:8794" },
];
