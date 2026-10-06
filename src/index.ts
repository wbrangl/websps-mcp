#!/usr/bin/env node
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { ConfigError, loadConfig } from "./config.js";
import { DeviceRegistry } from "./device/registry.js";
import { createServer } from "./server.js";

let config: ReturnType<typeof loadConfig>;
try {
  config = loadConfig();
} catch (error) {
  if (!(error instanceof ConfigError)) throw error;
  console.error(`websps-mcp: ${error.message}`);
  process.exit(1);
}

const app = { profile: config.profile, devices: new DeviceRegistry(config.devices) };
console.error(
  `websps-mcp: profile ${app.profile}, devices: ${config.devices.map((d) => `${d.alias} (${d.url})`).join(", ")}`,
);

// Serves both the 2026-07-28 revision and 2025-era clients (legacy: 'serve' is the default).
serveStdio(() => createServer(app));
