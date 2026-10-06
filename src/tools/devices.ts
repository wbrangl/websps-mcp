import { z } from "zod";
import { DeviceErrorCode, ServerErrorCode, WebspsError } from "../errors.js";
import { type App, deviceParam, handler, READ_ONLY, type ToolDefinition } from "./common.js";

interface DescribeResult {
  device_variant?: string;
  firmware_version?: string;
}

export const devicesList: ToolDefinition = {
  name: "devices_list",
  profile: "read",
  register(server, app) {
    server.registerTool(
      "devices_list",
      {
        title: "List devices",
        description:
          "List the configured Web@SPS devices with alias, URL, reachability and firmware. Also shows the server's profile, which determines the available tools.",
        inputSchema: z.object({}),
        annotations: READ_ONLY,
      },
      handler(async () => ({
        profile: app.profile,
        devices: await Promise.all(
          app.devices.list().map(async (device) => {
            const base = { alias: device.alias, url: device.url };
            try {
              // api.describe needs no permission, so it works for every device user.
              const info = await device.client.call<DescribeResult>("api.describe");
              return {
                ...base,
                reachable: true,
                circuit: device.client.circuitState,
                device_variant: info.device_variant,
                firmware_version: info.firmware_version,
              };
            } catch (error) {
              if (!(error instanceof WebspsError)) throw error;
              return {
                ...base,
                reachable: false,
                circuit: device.client.circuitState,
                error: error.toPayload(),
              };
            }
          }),
        ),
      })),
    );
  },
};

export const deviceStatus: ToolDefinition = {
  name: "device_status",
  profile: "read",
  register(server, app) {
    server.registerTool(
      "device_status",
      {
        title: "Device status",
        description:
          "Operating status (RUN/STOP/error states), device and firmware info, active rules file and current message box entries of a device.",
        inputSchema: z.object({ device: deviceParam(app) }),
        annotations: READ_ONLY,
      },
      handler(async ({ device: alias }) => statusOf(app, alias)),
    );
  },
};

async function statusOf(app: App, alias: string | undefined): Promise<Record<string, unknown>> {
  const device = app.devices.resolve(alias);
  const parts = { status: "system.status", info: "system.info", mbox: "system.mbox" } as const;
  const result: Record<string, unknown> = { device: device.alias };
  const errors: Record<string, unknown> = {};
  let firstError: WebspsError | undefined;

  for (const [key, method] of Object.entries(parts)) {
    try {
      result[key] = await device.client.call(method);
    } catch (error) {
      // Only per-method device errors (e.g. a missing permission) give a partial result;
      // auth, circuit and network errors would hit every further part as well.
      if (!(error instanceof WebspsError) || !isPerMethodError(error)) throw error;
      firstError ??= error;
      errors[key] = error.toPayload();
    }
  }
  // If nothing worked at all (e.g. device unreachable), report it as a tool error.
  if (firstError !== undefined && Object.keys(errors).length === Object.keys(parts).length) {
    throw firstError;
  }
  if (firstError !== undefined) result.errors = errors;
  return result;
}

function isPerMethodError(error: WebspsError): boolean {
  return error.code !== DeviceErrorCode.AUTH && error.code < ServerErrorCode.SERVER_ERROR;
}
