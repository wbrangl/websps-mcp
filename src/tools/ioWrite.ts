import { z } from "zod";
import { MAX_BATCH, MAX_CHANNEL_BYTES, readChannelValues } from "../device/channels.js";
import type { Device } from "../device/registry.js";
import {
  auditedHandler,
  DESTRUCTIVE,
  deviceParam,
  invalidInput,
  type ToolDefinition,
  WRITES,
} from "./common.js";

const DIGITAL = /^[SMVU]\d{1,2}\.[0-7]$/;
const ANALOG = /^(AA|SW)\d{1,2}$/;
const MAX_VERIFY_DELAY_MS = 10_000;
/** INI structure characters would corrupt the label file on the device. */
const LABEL_FORBIDDEN = /[[\]=;\r\n]/;
// Verified on the device; longer labels are untested.
const MAX_LABEL_BYTES = 100;

const valueSchema = z.union([z.number(), z.boolean()]);

/**
 * Only the operand classes the device allows to be written. The device converts analog values
 * without checking (`"abc"` becomes 0), so values are validated here.
 */
export function writeValue(channel: string, value: number | boolean): string {
  const numeric = typeof value === "boolean" ? Number(value) : value;
  if (DIGITAL.test(channel)) {
    if (numeric !== 0 && numeric !== 1) {
      throw invalidInput(`${channel} is digital; value must be 0 or 1 (or true/false)`);
    }
    return String(numeric);
  }
  if (ANALOG.test(channel)) {
    if (typeof value === "boolean" || !Number.isFinite(numeric)) {
      throw invalidInput(`${channel} is analog; value must be a number`);
    }
    return String(numeric);
  }
  throw invalidInput(
    `${channel} cannot be written; writable are S/M/V/U (e.g. S0.0, value 0/1) and AA/SW (e.g. SW0, a number)`,
  );
}

interface WriteEntry {
  channel: string;
  value?: number;
  success: boolean;
  error?: string;
}

export const ioWrite: ToolDefinition = {
  name: "io_write",
  profile: "operate",
  register(server, app) {
    server.registerTool(
      "io_write",
      {
        title: "Write channels",
        description: [
          "Set Web@SPS operands: digital S/M/V/U (0/1, e.g. visu switch S0.0) or analog AA/SW (number, e.g. setpoint SW0).",
          `Pass \`channel\`+\`value\` or up to ${MAX_BATCH} \`writes\`. Each write reports \`success\` on its own.`,
          "`verify: true` reads the written channels back; `verify: {channel, expect, delay_ms}` checks a different channel",
          "after a delay, e.g. a status output that should follow a switch. How a plant reacts (level vs. pulse) is plant specific.",
        ].join(" "),
        inputSchema: z.object({
          device: deviceParam(app),
          channel: z.string().min(1).optional(),
          value: valueSchema.optional(),
          writes: z
            .array(z.object({ channel: z.string().min(1), value: valueSchema }))
            .min(1)
            .max(MAX_BATCH)
            .optional(),
          verify: z
            .union([
              z.literal(true),
              z.object({
                channel: z.string().min(1).optional(),
                expect: valueSchema.optional(),
                delay_ms: z.number().int().min(0).max(MAX_VERIFY_DELAY_MS).optional(),
              }),
            ])
            .optional(),
        }),
        annotations: DESTRUCTIVE,
      },
      auditedHandler(
        app,
        "io_write",
        (args) => ({ ...args }),
        async (device, args) => {
          const writes =
            args.writes ??
            (args.channel !== undefined && args.value !== undefined
              ? [{ channel: args.channel, value: args.value }]
              : undefined);
          if (writes === undefined || (args.writes !== undefined && args.channel !== undefined)) {
            throw invalidInput("Pass either `channel` and `value`, or `writes`");
          }
          const prepared = writes.map((w) => ({
            channel: w.channel.trim(),
            value: writeValue(w.channel.trim(), w.value),
          }));
          const result = await device.client.call<{ writes?: WriteEntry[]; timestamp?: string }>(
            "io.write",
            { writes: prepared },
          );
          const entries = result.writes ?? [];
          const response: Record<string, unknown> = {
            device: device.alias,
            timestamp: result.timestamp,
            writes: entries,
            all_ok: entries.length === prepared.length && entries.every((e) => e.success),
          };
          if (args.verify !== undefined) {
            response.verify = await verify(device, args.verify, prepared, entries);
          }
          return response;
        },
      ),
    );
  },
};

async function verify(
  device: Device,
  spec:
    | true
    | {
        channel?: string | undefined;
        expect?: number | boolean | undefined;
        delay_ms?: number | undefined;
      },
  prepared: { channel: string; value: string }[],
  entries: WriteEntry[],
) {
  const options = spec === true ? {} : spec;
  await new Promise((resolve) => setTimeout(resolve, options.delay_ms ?? 200));

  if (options.channel !== undefined) {
    if (options.expect === undefined) throw invalidInput("verify.channel needs verify.expect");
    const expected = Number(options.expect);
    const { entries: read } = await readChannelValues(device, [options.channel]);
    const actual = read[0]?.value;
    return [{ channel: options.channel, expected, actual, ok: actual === expected }];
  }
  const written = prepared.filter((p) => entries.find((e) => e.channel === p.channel)?.success);
  if (written.length === 0) return [];
  const { entries: read } = await readChannelValues(
    device,
    written.map((w) => w.channel),
  );
  return written.map((w) => {
    const actual = read.find((r) => r.channel === w.channel)?.value;
    const expected = options.expect !== undefined ? Number(options.expect) : Number(w.value);
    return { channel: w.channel, expected, actual, ok: actual === expected };
  });
}

export const recordingClear: ToolDefinition = {
  name: "recording_clear",
  profile: "operate",
  register(server, app) {
    server.registerTool(
      "recording_clear",
      {
        title: "Clear data recorder",
        description:
          "Delete the data recorder's recording of an O channel (e.g. O0.0), like the DEL rules operator.",
        inputSchema: z.object({
          device: deviceParam(app),
          channel: z.string().regex(/^O\d{1,2}\.[0-7]$/),
        }),
        annotations: DESTRUCTIVE,
      },
      auditedHandler(
        app,
        "recording_clear",
        (args) => ({ ...args }),
        async (device, { channel }) => ({
          device: device.alias,
          ...(await device.client.call<Record<string, unknown>>("data.clear_recording", {
            channel,
          })),
        }),
      ),
    );
  },
};

export const ioLabelSet: ToolDefinition = {
  name: "io_label_set",
  profile: "develop",
  register(server, app) {
    server.registerTool(
      "io_label_set",
      {
        title: "Set channel label",
        description:
          'Set the human-readable label of a channel on the device (shown by io_labels/io_read), e.g. S0.0 → "Pool pump on". An empty label deletes it.',
        inputSchema: z.object({
          device: deviceParam(app),
          channel: z.string().min(1),
          label: z.string(),
        }),
        annotations: WRITES,
      },
      auditedHandler(
        app,
        "io_label_set",
        (args) => ({ ...args }),
        async (device, { channel, label }) => {
          const name = channel.trim();
          if (
            name === "" ||
            Buffer.byteLength(name) > MAX_CHANNEL_BYTES ||
            LABEL_FORBIDDEN.test(name)
          ) {
            throw invalidInput(`Invalid channel "${channel}"`);
          }
          if (LABEL_FORBIDDEN.test(label)) {
            throw invalidInput("Label must not contain [ ] = ; or line breaks");
          }
          if (Buffer.byteLength(label) > MAX_LABEL_BYTES) {
            throw invalidInput(`Label is longer than ${MAX_LABEL_BYTES} bytes`);
          }
          try {
            return {
              device: device.alias,
              ...(await device.client.call<Record<string, unknown>>("io.label_set", {
                channel: name,
                label,
              })),
            };
          } finally {
            device.labels.invalidate();
          }
        },
      ),
    );
  },
};
