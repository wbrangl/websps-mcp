import { z } from "zod";
import { looksSecret, MASK } from "../device/configSchema.js";
import type { Device } from "../device/registry.js";
import {
  auditedHandler,
  DESTRUCTIVE,
  deviceParam,
  invalidInput,
  type ToolDefinition,
} from "./common.js";

export const configSet: ToolDefinition = {
  name: "config_set",
  profile: "admin",
  register(server, app) {
    server.registerTool(
      "config_set",
      {
        title: "Change configuration",
        description: [
          "Change one device configuration field (see config_get with schema: true for names and types).",
          "Reports whether the field is critical or needs a restart. Secrets such as passwords cannot be set through this tool.",
        ].join(" "),
        inputSchema: z.object({
          device: deviceParam(app),
          key: z.string().min(1),
          value: z.union([z.string(), z.number(), z.boolean()]),
        }),
        annotations: DESTRUCTIVE,
      },
      auditedHandler(
        app,
        "config_set",
        (args) => ({ ...args, ...(looksSecret(args.key) && { value: MASK }) }),
        async (device, { key, value }) => {
          const field = (await device.configSchema.get()).find((f) => f.name === key);
          if (field === undefined) throw invalidInput(`Unknown configuration field "${key}"`);
          // Passwords belong to the administrator, never into an agent's context or the audit log.
          if (field.secret || looksSecret(key)) {
            throw invalidInput(
              `${key} is a secret and must be set by the administrator on the device`,
            );
          }
          const previous = await device.client.call<Record<string, unknown>>("config.get_multi", {
            keys: [key],
          });
          const result = await device.client.call<Record<string, unknown>>("config.set", {
            key,
            value,
          });
          return {
            device: device.alias,
            key,
            previous: previous[key],
            value,
            critical: field.critical,
            restart_required: Boolean(result.restart_required ?? field.restart_required),
            result,
          };
        },
        ({ key, previous, value }) => ({ key, previous, value }),
      ),
    );
  },
};

const timeSchema = z
  .object({
    hour: z.number().int().min(0).max(23).optional(),
    minute: z.number().int().min(0).max(59).optional(),
    second: z.number().int().min(0).max(59).optional(),
    day: z.number().int().min(1).max(31).optional(),
    month: z.number().int().min(1).max(12).optional(),
    year: z.number().int().min(2000).max(2099).optional(),
  })
  .refine((t) => Object.keys(t).length > 0, { message: "set at least one field" });

export const deviceControl: ToolDefinition = {
  name: "device_control",
  profile: "develop",
  register(server, app) {
    server.registerTool(
      "device_control",
      {
        title: "Run or stop the program",
        description: [
          "RUN / STOP the rules program, e.g. to resume after a failed rules_activate;",
          "NTPSYNC requests a time sync (only with NTP as time source). Restarts: device_reboot.",
        ].join(" "),
        inputSchema: z.object({
          device: deviceParam(app),
          command: z.enum(["RUN", "STOP", "NTPSYNC"]),
        }),
        annotations: DESTRUCTIVE,
      },
      auditedHandler(
        app,
        "device_control",
        (args) => ({ ...args }),
        async (device, { command }) => ({
          device: device.alias,
          command,
          result: await control(device, command),
        }),
      ),
    );
  },
};

/** Always the command names: the digit aliases are a legacy telnet compatibility layer. */
function control(device: Device, command: string) {
  return device.client.call<Record<string, unknown>>("system.control", { command });
}

export const deviceMaintenance: ToolDefinition = {
  name: "device_maintenance",
  profile: "admin",
  register(server, app) {
    server.registerTool(
      "device_maintenance",
      {
        title: "Device maintenance",
        description: [
          "Administrative device actions: SET_TIME sets the device clock from `time` (runtime only, not persisted),",
          "RMLOG deletes the device log file.",
        ].join(" "),
        inputSchema: z.object({
          device: deviceParam(app),
          action: z.enum(["SET_TIME", "RMLOG"]),
          time: timeSchema.optional(),
        }),
        annotations: DESTRUCTIVE,
      },
      auditedHandler(
        app,
        "device_maintenance",
        (args) => ({ ...args }),
        async (device, { action, time }) => {
          if (action === "RMLOG") {
            if (time !== undefined) throw invalidInput("`time` is only used with SET_TIME");
            return { device: device.alias, action, result: await control(device, "RMLOG") };
          }
          if (time === undefined) throw invalidInput("SET_TIME needs `time`");
          const params = Object.fromEntries(
            Object.entries(time).map(([k, v]) => [`manual_${k}`, v]),
          );
          return {
            device: device.alias,
            action,
            result: await device.client.call<Record<string, unknown>>("system.set_time", params),
          };
        },
      ),
    );
  },
};

export const deviceReboot: ToolDefinition = {
  name: "device_reboot",
  profile: "develop",
  register(server, app) {
    server.registerTool(
      "device_reboot",
      {
        title: "Restart device",
        description:
          "REINIT re-initializes the device (reloads configuration and rules), REBOOT restarts it completely; the device is unreachable for a while afterwards.",
        inputSchema: z.object({ device: deviceParam(app), mode: z.enum(["REINIT", "REBOOT"]) }),
        annotations: DESTRUCTIVE,
      },
      auditedHandler(
        app,
        "device_reboot",
        (args) => ({ ...args }),
        async (device, { mode }) => {
          const result = await control(device, mode);
          // Cached device documents and layouts may change with a firmware update before a reboot.
          device.docs.clear();
          return { device: device.alias, mode, result };
        },
      ),
    );
  },
};
