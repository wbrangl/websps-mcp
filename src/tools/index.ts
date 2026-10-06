import type { McpServer } from "@modelcontextprotocol/server";
import { profileAllows } from "../profiles.js";
import type { App, ToolDefinition } from "./common.js";
import { deviceStatus, devicesList } from "./devices.js";
import { ioLabels, ioRead } from "./io.js";

const TOOLS: readonly ToolDefinition[] = [devicesList, deviceStatus, ioRead, ioLabels];

/** Registers the tools visible for the configured profile, sorted by name for a stable tools/list. */
export function registerTools(server: McpServer, app: App): void {
  for (const tool of [...TOOLS].sort((a, b) => a.name.localeCompare(b.name))) {
    if (profileAllows(app.profile, tool.profile)) tool.register(server, app);
  }
}
