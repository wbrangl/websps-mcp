import { z } from "zod";
import { deviceParam, handler, invalidInput, READ_ONLY, type ToolDefinition } from "./common.js";

const CONSOLE_MAX_LIMIT = 200;
/** Device limit of `logs.search`. */
const LOGFILE_MAX_LIMIT = 50;

export const logRead: ToolDefinition = {
  name: "log_read",
  profile: "read",
  register(server, app) {
    server.registerTool(
      "log_read",
      {
        title: "Read device log",
        description: [
          "Read the device log.",
          '`source: "console"` (default): recent console messages, accumulated by the server beyond the device\'s 25-line buffer;',
          "pass the returned `next_cursor` as `since_cursor` to get only newer lines, `grep` filters case-insensitively.",
          "`gap: true` means lines were lost on the device between two reads.",
          '`source: "logfile"`: search the device\'s full log file with `grep` (required, case-sensitive);',
          "this takes about 10 seconds during which the device answers nothing else.",
        ].join(" "),
        inputSchema: z.object({
          device: deviceParam(app),
          source: z.enum(["console", "logfile"]).optional(),
          since_cursor: z.number().int().min(0).optional(),
          grep: z.string().min(1).optional(),
          limit: z.number().int().min(1).max(CONSOLE_MAX_LIMIT).optional(),
        }),
        annotations: READ_ONLY,
      },
      handler(async ({ device: alias, source = "console", since_cursor, grep, limit }) => {
        const device = app.devices.resolve(alias);

        if (source === "logfile") {
          if (grep === undefined) throw invalidInput("`grep` is required for source logfile");
          if (since_cursor !== undefined) {
            throw invalidInput("`since_cursor` only applies to source console");
          }
          const result = await device.client.call<Record<string, unknown>>("logs.search", {
            pattern: grep,
            limit: Math.min(limit ?? 25, LOGFILE_MAX_LIMIT),
          });
          return { device: device.alias, source, ...result };
        }

        const poll = await device.consoleLog.poll();
        const read = await device.consoleLog.read({
          sinceCursor: since_cursor,
          grep,
          limit: limit ?? 25,
        });
        return {
          device: device.alias,
          source,
          entries: read.entries.map(({ pos: _pos, ...entry }) => entry),
          next_cursor: read.nextCursor,
          more: read.more,
          ...(poll.gap && { gap: true }),
          ...(poll.restarted && { device_restarted: true }),
        };
      }),
    );
  },
};
