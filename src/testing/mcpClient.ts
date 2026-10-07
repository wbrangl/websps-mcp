import { createRequire } from "node:module";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const tsx = createRequire(import.meta.url).resolve("tsx/cli");

/** Starts the server from source over stdio (as a client would) and connects to it. */
export async function connectServer(options: {
  url: string;
  stateDir: string;
  mode?: "legacy" | { pin: string };
  env?: Record<string, string>;
}): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [tsx, "src/index.ts"],
    env: {
      PATH: process.env.PATH ?? "",
      // A config file (WEBSPS_CONFIG in env) replaces the single-device variables.
      ...(options.env?.WEBSPS_CONFIG === undefined && {
        WEBSPS_URL: options.url,
        WEBSPS_USER: "api_user",
        WEBSPS_PASSWORD: "secret",
      }),
      WEBSPS_STATE_DIR: options.stateDir,
      ...options.env,
    },
    stderr: "ignore",
  });
  const client = new Client(
    { name: "e2e", version: "0" },
    { versionNegotiation: { mode: options.mode ?? { pin: "2026-07-28" } } },
  );
  await client.connect(transport);
  return client;
}

/** The full tool result, which the server puts as JSON into the text content. */
export function parseResult(result: Awaited<ReturnType<Client["callTool"]>>) {
  const first = (result.content as { type: string; text: string }[])[0];
  return JSON.parse(first?.text ?? "null");
}
