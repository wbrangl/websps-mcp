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
          `Read device configuration: \`keys\` (up to ${MAX_KEYS} field names), \`section\` (e.g. "IP", see the \`section\` of each field)`,
          "or `schema: true` for all fields with type, section and whether changing them is critical or needs a restart.",
          'Passwords and other secrets are always masked as "***".',
        ].join(" "),
        inputSchema: z.object({
          device: deviceParam(app),
          keys: z.array(z.string().min(1)).min(1).max(MAX_KEYS).optional(),
          section: z.string().min(1).optional(),
          schema: z.boolean().optional(),
        }),
        annotations: READ_ONLY,
      },
      handler(async ({ device: alias, keys, section, schema }) => {
        const device = app.devices.resolve(alias);
        const given = [
          keys !== undefined && "keys",
          section !== undefined && "section",
          schema === true && "schema",
        ].filter((name): name is string => name !== false);
        if (given.length > 1) {
          throw invalidInput(
            `Only one of keys, section, schema may be given, got: ${given.join(", ")}`,
          );
        }
        if (given.length === 0) throw invalidInput("Pass `keys`, `section` or `schema: true`");
        if (schema === true) {
          return { device: device.alias, fields: await device.configSchema.get() };
        }
        if (section !== undefined) {
          const values = await device.client.call<Record<string, unknown>>("config.get_section", {
            section,
          });
          return {
            device: device.alias,
            section,
            values: await device.configSchema.mask(values),
          };
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
