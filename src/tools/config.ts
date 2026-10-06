import { z } from "zod";
import { deviceParam, handler, invalidInput, READ_ONLY, type ToolDefinition } from "./common.js";

/** Device limit of `config.get_multi`. */
const MAX_KEYS = 32;

export const configGet: ToolDefinition = {
  name: "config_get",
  profile: "read",
  register(server, app) {
    server.registerTool(
      "config_get",
      {
        title: "Read configuration",
        description: [
          `Read device configuration values: \`keys\` (up to ${MAX_KEYS} field names) or \`schema: true\` for all fields`,
          'with type and whether changing them is critical or needs a restart. Passwords and other secrets are always masked as "***".',
        ].join(" "),
        inputSchema: z.object({
          device: deviceParam(app),
          keys: z.array(z.string().min(1)).min(1).max(MAX_KEYS).optional(),
          schema: z.boolean().optional(),
        }),
        annotations: READ_ONLY,
      },
      handler(async ({ device: alias, keys, schema }) => {
        const device = app.devices.resolve(alias);
        if ((keys === undefined) === (schema !== true)) {
          throw invalidInput("Pass either `keys` or `schema: true`");
        }
        if (keys === undefined) {
          return { device: device.alias, fields: await device.configSchema.get() };
        }
        const unique = [...new Set(keys)];
        // get_multi silently drops unknown keys; report them instead.
        const values = await device.client.call<Record<string, unknown>>("config.get_multi", {
          keys: unique,
        });
        const missing = unique.filter((k) => !(k in values));
        return {
          device: device.alias,
          values: await device.configSchema.mask(values),
          ...(missing.length > 0 && { unknown_keys: missing }),
        };
      }),
    );
  },
};
