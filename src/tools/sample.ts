import { z } from "zod";
import { MAX_BATCH, normalizeChannels } from "../device/channels.js";
import { MAX_DURATION_S, MIN_INTERVAL_MS } from "../device/sampler.js";
import { deviceParam, handler, invalidInput, READ_ONLY, type ToolDefinition } from "./common.js";

const READ_MAX_LIMIT = 500;

export const sample: ToolDefinition = {
  name: "sample",
  profile: "read",
  register(server, app) {
    server.registerTool(
      "sample",
      {
        title: "Record values over time",
        description: [
          "Record channel values over time on the server (nothing changes on the device).",
          `\`action: "start"\` with \`channels\` (max ${MAX_BATCH}), \`interval_ms\` (min ${MIN_INTERVAL_MS}, default 1000) and \`duration_s\` (default 60) returns an \`id\` immediately;`,
          '`action: "read"` with `id` returns the samples so far (continue with `since_index` = returned `next_index`);',
          '`action: "stop"` ends a recording early; `action: "list"` shows the recordings of this server process.',
          "Each sample costs at least one device request; a sample is skipped while the previous read is still running.",
        ].join(" "),
        inputSchema: z.object({
          device: deviceParam(app),
          action: z.enum(["start", "read", "stop", "list"]),
          channels: z.array(z.string().min(1)).min(1).max(MAX_BATCH).optional(),
          interval_ms: z.number().int().min(MIN_INTERVAL_MS).optional(),
          duration_s: z.number().int().min(1).max(MAX_DURATION_S).optional(),
          id: z.string().min(1).optional(),
          since_index: z.number().int().min(0).optional(),
          limit: z.number().int().min(1).max(READ_MAX_LIMIT).optional(),
        }),
        annotations: READ_ONLY,
      },
      handler(async (args) => {
        const device = app.devices.resolve(args.device);
        const { sampler } = device;
        switch (args.action) {
          case "start": {
            if (args.channels === undefined) throw invalidInput("`channels` is required for start");
            const recording = sampler.start(
              normalizeChannels(args.channels),
              args.interval_ms ?? 1000,
              args.duration_s ?? 60,
            );
            return { ...recording };
          }
          case "read": {
            const id = requireId(args.id);
            const read = await sampler.read(id, args.since_index ?? 0, args.limit ?? 100);
            return {
              ...read.recording,
              samples: read.samples,
              next_index: read.nextIndex,
              more: read.more,
            };
          }
          case "stop":
            return { ...(await sampler.stop(requireId(args.id))) };
          case "list":
            return { device: device.alias, recordings: sampler.list() };
        }
      }),
    );
  },
};

function requireId(id: string | undefined): string {
  if (id === undefined) throw invalidInput("`id` is required");
  return id;
}
