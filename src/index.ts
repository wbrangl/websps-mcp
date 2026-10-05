#!/usr/bin/env node
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createServer } from "./server.js";

// Serves both the 2026-07-28 revision and 2025-era clients (legacy: 'serve' is the default).
serveStdio(() => createServer());
