import { randomUUID } from "node:crypto";
import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { AuditEntry } from "../device/audit.js";
import type { Device, DeviceRegistry } from "../device/registry.js";
import { ServerErrorCode, WebspsError } from "../errors.js";
import type { Profile } from "../profiles.js";

export interface App {
  profile: Profile;
  devices: DeviceRegistry;
}

export interface ToolDefinition {
  name: string;
  /** Lowest profile that sees this tool in `tools/list`. */
  profile: Profile;
  register(server: McpServer, app: App): void;
}

export function deviceParam(app: App) {
  const [first, ...rest] = app.devices.aliases;
  if (first === undefined) throw new Error("no devices configured");
  return z
    .enum([first, ...rest])
    .optional()
    .describe(
      "Device alias (see devices_list). May be omitted when exactly one device is configured.",
    );
}

/**
 * Wraps a tool handler: the full result goes into the text content as compact JSON (not every
 * client reads `structuredContent`) and additionally into `structuredContent`.
 */
export function handler<A>(fn: (args: A) => Promise<Record<string, unknown>>) {
  return async (args: A): Promise<CallToolResult> => {
    try {
      const result = await fn(args);
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: result,
      };
    } catch (error) {
      const known =
        error instanceof WebspsError
          ? error
          : new WebspsError(
              ServerErrorCode.SERVER_ERROR,
              (error as Error).message ?? String(error),
            );
      if (!(error instanceof WebspsError)) console.error(error);
      const payload = { error: known.toPayload() };
      return {
        isError: true,
        content: [{ type: "text", text: JSON.stringify(payload) }],
        structuredContent: payload,
      };
    }
  };
}

/**
 * Handler for tools that change something on the device: resolves the device and records every
 * call, successful or not, in the device's audit log (`redact` removes secrets and contents;
 * `summarize` picks result fields worth keeping, e.g. the previous value, so a change can be
 * traced and undone).
 */
export function auditedHandler<A extends { device?: string | undefined }>(
  app: App,
  tool: string,
  redact: (args: A) => Record<string, unknown>,
  fn: (device: Device, args: A) => Promise<Record<string, unknown>>,
  summarize?: (result: Record<string, unknown>) => Record<string, unknown>,
) {
  return handler(async (args: A) => {
    const device = app.devices.resolve(args.device);
    const base = { id: randomUUID(), tool, profile: app.profile, args: redact(args) };
    const audit = (entry: Partial<AuditEntry>) =>
      device.audit
        .write({ ...base, at: new Date().toISOString(), outcome: "started", ...entry })
        .catch((error: unknown) => console.error(`[${device.alias}] audit log: ${error}`));
    const started = Date.now();
    await audit({});
    try {
      const result = await fn(device, args);
      await audit({
        outcome: "ok",
        duration_ms: Date.now() - started,
        ...(summarize !== undefined && { result: summarize(result) }),
      });
      return result;
    } catch (error) {
      const payload = error instanceof WebspsError ? error.toPayload() : String(error);
      await audit({ outcome: "error", duration_ms: Date.now() - started, error: payload });
      throw error;
    }
  });
}

export function invalidInput(message: string): WebspsError {
  return new WebspsError(ServerErrorCode.INVALID_INPUT, message);
}

/** Hints only: clients evaluate them differently and the spec treats them as untrusted. */
export const WRITES = {
  readOnlyHint: false,
  destructiveHint: false,
  openWorldHint: false,
} as const;
export const DESTRUCTIVE = {
  readOnlyHint: false,
  destructiveHint: true,
  openWorldHint: false,
} as const;

export const READ_ONLY = {
  readOnlyHint: true,
  idempotentHint: true,
  openWorldHint: false,
} as const;
