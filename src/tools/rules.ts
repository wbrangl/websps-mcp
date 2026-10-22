import { z } from "zod";
import { encodeText, safeWrite } from "../device/fileOps.js";
import type { Device } from "../device/registry.js";
import { lintRules, type RulesOperator } from "../device/rulesLint.js";
import { DeviceErrorCode, ServerErrorCode, WebspsError } from "../errors.js";
import {
  auditedHandler,
  DESTRUCTIVE,
  deviceParam,
  handler,
  invalidInput,
  READ_ONLY,
  type ToolDefinition,
  WRITES,
} from "./common.js";
import { getDoc } from "./docs.js";

/** The device accepts only 8.3 names ending in .TXT for rules files. */
const RULES_NAME = /^[A-Z0-9_-]{1,8}\.TXT$/;

interface DeviceValidation {
  valid: boolean;
  line_count?: number;
  error_count?: number;
  errors?: { line: number; code: number; message: string }[];
  warning_count?: number;
  warnings?: { line: number; code: number; message: string }[];
}

interface Root {
  configured_root?: string;
  loaded_root?: string;
}

export function rulesName(name: string): string {
  const upper = name.trim().toUpperCase();
  if (!RULES_NAME.test(upper)) {
    throw invalidInput(
      `Rules file name must be 8.3 with extension .TXT (e.g. POOL.TXT), got "${name}"`,
    );
  }
  return upper;
}

/** Rules files on the device use CRLF line endings. */
function rulesBytes(content: string, encoding: "utf-8" | "latin1"): Uint8Array {
  return encodeText(content.replace(/\r?\n/g, "\r\n"), encoding);
}

const contentArgs = {
  name: z.string().min(1),
  content: z.string(),
  encoding: z.enum(["utf-8", "latin1"]).optional(),
};

/** Device syntax check plus the server's own lint; nothing is written. */
async function validate(device: Device, name: string, bytes: Uint8Array, text: string) {
  const operators = (await getDoc(device, "operators").catch(() => undefined)) as
    | { operators?: RulesOperator[] }
    | undefined;
  const lint = lintRules(text, operators?.operators ?? []);
  const result = await device.client.upload<DeviceValidation>(`rules/${name}`, bytes, {
    action: "validate",
  });
  return {
    valid: result.valid && lint.errors.length === 0,
    device_check: result,
    lint,
  };
}

export const rulesValidate: ToolDefinition = {
  name: "rules_validate",
  profile: "develop",
  register(server, app) {
    server.registerTool(
      "rules_validate",
      {
        title: "Validate rules",
        description: [
          "Check rules content without writing anything: the device's own syntax check plus the server's lint",
          "(e.g. empty middle parameters, which the device compiler silently skips so later fields shift).",
          "Line endings are normalized to CRLF.",
        ].join(" "),
        inputSchema: z.object({ device: deviceParam(app), ...contentArgs }),
        annotations: READ_ONLY,
      },
      handler(async ({ device: alias, name, content, encoding }) => {
        const device = app.devices.resolve(alias);
        const file = rulesName(name);
        const result = await validate(
          device,
          file,
          rulesBytes(content, encoding ?? "utf-8"),
          content,
        );
        return { device: device.alias, name: file, ...result };
      }),
    );
  },
};

export const rulesWrite: ToolDefinition = {
  name: "rules_write",
  profile: "develop",
  register(server, app) {
    server.registerTool(
      "rules_write",
      {
        title: "Write rules file",
        description: [
          "Write a rules file WITHOUT activating it (use rules_activate afterwards). Always validates first and refuses invalid content.",
          "To change an existing file pass `expected_hash` (the crc16 from file_read): the write fails if the file changed meanwhile.",
          "The previous content is kept as a backup on the server. Line endings are normalized to CRLF.",
        ].join(" "),
        inputSchema: z.object({
          device: deviceParam(app),
          ...contentArgs,
          expected_hash: z.number().int().min(0).max(0xffff).optional(),
        }),
        annotations: WRITES,
      },
      auditedHandler(
        app,
        "rules_write",
        ({ content, ...rest }) => ({ ...rest, content_bytes: Buffer.byteLength(content) }),
        async (device, { name, content, encoding, expected_hash }) => {
          const file = rulesName(name);
          const bytes = rulesBytes(content, encoding ?? "utf-8");
          const validation = await validate(device, file, bytes, content);
          if (!validation.valid) {
            throw new WebspsError(
              DeviceErrorCode.VALIDATION,
              `${file} is not valid; nothing was written`,
              {
                device: device.alias,
                hint: "Fix the reported lines (see details) and try again.",
                details: { device_check: validation.device_check, lint: validation.lint },
              },
            );
          }
          const outcome = await safeWrite(device, `rules/${file}`, bytes, expected_hash);
          const root = await device.client.call<Root>("rules.get_root");
          return {
            device: device.alias,
            ...outcome,
            is_root: root.configured_root === file,
            activated: false,
            ...(validation.lint.warnings.length > 0 ||
            (validation.device_check.warning_count ?? 0) > 0
              ? {
                  warnings: {
                    device_check: validation.device_check.warnings ?? [],
                    lint: validation.lint.warnings,
                  },
                }
              : {}),
            next: `rules_activate with name ${file} loads it`,
          };
        },
        ({ path, crc16, created, backup }) => ({ path, crc16, created, backup }),
      ),
    );
  },
};

export const rulesActivate: ToolDefinition = {
  name: "rules_activate",
  profile: "develop",
  register(server, app) {
    server.registerTool(
      "rules_activate",
      {
        title: "Activate rules",
        description: [
          "Make a rules file the active program and load it (takes a few seconds). Without `name` the configured root file is (re)loaded.",
          "Loading a different file than the one currently running replaces the running program: then `expected_root` must name the",
          "file that runs now (see device_status); otherwise nothing is changed and the error shows the actual state.",
          "If loading fails, the device rolls back to its .BAK copy where one exists; after a switch the server also loads the previous file again.",
          "After a failed load the device may stay in STOP and needs device_control RUN.",
        ].join(" "),
        inputSchema: z.object({
          device: deviceParam(app),
          name: z.string().min(1).optional(),
          expected_root: z.string().min(1).optional(),
        }),
        annotations: DESTRUCTIVE,
      },
      auditedHandler(
        app,
        "rules_activate",
        (args) => ({ ...args }),
        async (device, { name, expected_root }) => {
          const before = await device.client.call<Root>("rules.get_root");
          const configured = before.configured_root;
          // What runs now is what a load replaces; configured and loaded differ after a
          // set_root without reload.
          const running = before.loaded_root ?? configured;
          const target = name !== undefined ? rulesName(name) : configured;
          if (target === undefined)
            throw invalidInput("No root rules file is configured; pass `name`");
          const expected = expected_root !== undefined ? rulesName(expected_root) : undefined;
          confirmSwitch(device, target, running, configured, expected);
          // Fail early on a missing file instead of leaving the device without a loadable root.
          await device.client.fileHash(`rules/${target}`);

          const switching = running !== undefined && target !== running;
          if (target !== configured) await device.client.call("rules.set_root", { name: target });
          try {
            const reload = await device.client.call<Record<string, unknown>>("rules.reload");
            return {
              device: device.alias,
              root: target,
              previous_root: running,
              reload,
              status: await status(device),
            };
          } catch (error) {
            if (!(error instanceof WebspsError)) throw error;
            // Only an answer from the device proves the load failed. A timeout, an unreachable
            // device or the auth circuit breaker leave the outcome open: the single-threaded
            // device may still be loading successfully, so rolling back would undo a good load.
            if (error.code === DeviceErrorCode.AUTH || error.code >= ServerErrorCode.SERVER_ERROR) {
              throw new WebspsError(
                error.code,
                `Activating ${target}: outcome unknown (${error.message})`,
                {
                  device: device.alias,
                  hint: "The device may have loaded the file anyway. Check device_status (active rules file, status) before trying again.",
                  details: { target, previous_root: running },
                },
              );
            }
            let restored: string | undefined;
            let restoreError: unknown;
            if (switching && running !== undefined) {
              try {
                await device.client.call("rules.set_root", { name: running });
                await device.client.call("rules.reload");
                restored = running;
              } catch (e) {
                restoreError = e instanceof WebspsError ? e.toPayload() : String(e);
              }
            }
            const after = await status(device).catch(() => undefined);
            // DATA is shown for ~2 s after any I/O write while the rules keep running.
            const rulesRunning = after?.status_text === "RUN" || after?.status_text === "DATA";
            throw new WebspsError(error.code, `Activating ${target} failed: ${error.message}`, {
              device: device.alias,
              hint: rulesRunning
                ? "The device runs the previous rules again. Fix the file and try again."
                : "The device is not running (see details.status). After checking, device_control RUN resumes it.",
              details: {
                target,
                ...(restored !== undefined && { restored_previous_root: restored }),
                ...(restoreError !== undefined && { restore_error: restoreError }),
                status: after,
              },
            });
          }
        },
        ({ root, previous_root }) => ({ root, previous_root }),
      ),
    );
  },
};

/**
 * Like expected_hash for writes: replacing the running program needs the caller to name what runs
 * now, so a wrong assumption about the device state fails before anything changes. A caller may
 * copy the value from the error; this makes the switch explicit, it does not replace a human
 * approval.
 */
function confirmSwitch(
  device: Device,
  target: string,
  running: string | undefined,
  configured: string | undefined,
  expected: string | undefined,
): void {
  const mismatch = expected !== undefined && running !== undefined && expected !== running;
  const unconfirmed = running !== undefined && target !== running && expected === undefined;
  if (!mismatch && !unconfirmed) return;
  const message = mismatch
    ? `expected_root is ${expected}, but ${running} is running`
    : `Activating ${target} would replace the running rules ${running}; pass expected_root: "${running}" to confirm`;
  throw new WebspsError(DeviceErrorCode.VALIDATION, message, {
    device: device.alias,
    hint: "Check with device_status whether replacing the running program is intended; nothing was changed.",
    details: {
      target,
      current_root: running,
      ...(configured !== undefined && configured !== running && { configured_root: configured }),
    },
  });
}

async function status(device: Device) {
  return device.client.call<{ status_code: number; status_text: string }>("system.status");
}
