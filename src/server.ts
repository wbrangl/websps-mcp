import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/server";
import type { App } from "./tools/common.js";
import { registerTools } from "./tools/index.js";

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

const INSTRUCTIONS = [
  "Web@SPS device control.",
  "Always pass `device` unless exactly one is configured.",
  "Prefer `io_labels` to resolve names to channels.",
  "Never guess channels: check `io_usage`/`io_read` first.",
  "Change Rules only via `rules_validate` -> `rules_write` -> `rules_activate`;",
  "do not leave middle parameters empty (the compiler silently shifts fields).",
  "Writes are verified with `io_write.verify`.",
  "Some tools may be unavailable for the configured profile.",
].join(" ");

/**
 * Transport-free server factory; stdio and (later) HTTP adapters both call this. Device state
 * lives in `app` and is shared across all server instances of the process.
 */
export function createServer(app: App): McpServer {
  const server = new McpServer({ name: "websps-mcp", version }, { instructions: INSTRUCTIONS });
  registerTools(server, app);
  return server;
}
