import { z } from "zod";
import { MAX_BATCH, readChannelValues } from "../device/channels.js";
import { encodeText, readVerified, safeWrite } from "../device/fileOps.js";
import { decodeText } from "../device/files.js";
import { applyLabelChanges, checkLabel, LABELS_PATH, labelChannel } from "../device/labelsFile.js";
import type { Device } from "../device/registry.js";
import { DeviceErrorCode, WebspsError } from "../errors.js";
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
          `\`writes\` lists 1 to ${MAX_BATCH} {channel, value} pairs, e.g. [{"channel":"S0.0","value":1}]. Each write reports \`success\` on its own.`,
          "`verify: true` reads the written channels back; `verify: {channel, expect, delay_ms}` checks a different channel",
          "after a delay, e.g. a status output that should follow a switch. How a plant reacts (level vs. pulse) is plant specific.",
        ].join(" "),
        inputSchema: z.object({
          device: deviceParam(app),
          // One form only: alternative top-level forms (channel/value vs. writes) led models to
          // fill in both. JSON Schema oneOf at the root is not portable across clients.
          writes: z
            .array(z.object({ channel: z.string().min(1), value: valueSchema }))
            .min(1)
            .max(MAX_BATCH),
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
          const prepared = args.writes.map((w) => ({
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
          'Set the human-readable label of a channel on the device (shown by io_labels/io_read), e.g. S0.0 → "Pool pump on". An empty label deletes it. The result contains `previous_label` (null if there was none) so the change can be undone; `changed: false` means the label already had that value and nothing was written.',
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
          const name = labelChannel(channel);
          checkLabel(name, label);
          // Read fresh from the device, not from the label cache, so the previous value is
          // current. Reading and setting are not atomic on the device; a change in between by
          // someone else would go unnoticed (very short window).
          const current = await device.client.call<{ labels?: Record<string, string> }>(
            "io.labels",
          );
          const previous = current.labels?.[name] ?? null;
          if (previous === (label === "" ? null : label)) {
            return {
              device: device.alias,
              channel: name,
              label,
              previous_label: previous,
              changed: false,
            };
          }
          try {
            const result = await device.client.call<Record<string, unknown>>("io.label_set", {
              channel: name,
              label,
            });
            return { device: device.alias, ...result, previous_label: previous, changed: true };
          } finally {
            device.labels.invalidate();
          }
        },
        ({ channel, label, previous_label, changed }) => ({
          channel,
          label,
          previous_label,
          changed,
        }),
      ),
    );
  },
};

/** More labels per call than any device has channels; keeps a single call bounded. */
const MAX_LABELS_PER_CALL = 1000;

export const ioLabelsSet: ToolDefinition = {
  name: "io_labels_set",
  profile: "develop",
  register(server, app) {
    server.registerTool(
      "io_labels_set",
      {
        title: "Set many channel labels",
        description: [
          "Set, change or delete many channel labels at once (one write of the device's label file instead of one call per channel).",
          "`labels` lists {channel, label} pairs; an empty label deletes that label. Other labels stay unchanged,",
          "unless `replace_all: true`, which removes every label not listed. The result lists each change with its",
          "`previous_label` (null if there was none) so it can be undone; `applied` tells whether the device reports the new labels.",
        ].join(" "),
        inputSchema: z.object({
          device: deviceParam(app),
          labels: z
            .array(z.object({ channel: z.string().min(1), label: z.string() }))
            .min(1)
            .max(MAX_LABELS_PER_CALL),
          replace_all: z.boolean().optional(),
        }),
        annotations: DESTRUCTIVE,
      },
      auditedHandler(
        app,
        "io_labels_set",
        ({ labels, ...rest }) => ({ ...rest, labels: labels.length }),
        async (device, { labels, replace_all }) => {
          const wanted = new Map<string, string>();
          for (const entry of labels) {
            const channel = labelChannel(entry.channel);
            checkLabel(channel, entry.label);
            if (wanted.has(channel)) throw invalidInput(`Channel ${channel} is listed twice`);
            wanted.set(channel, entry.label);
          }

          // Read the file fresh with its CRC; the write below passes that CRC as expected_hash,
          // so a change by someone else in between makes the device refuse the write.
          const existing = await readVerified(device, LABELS_PATH).catch((error: unknown) => {
            if (error instanceof WebspsError && error.code === DeviceErrorCode.NOT_FOUND) {
              return undefined;
            }
            throw error;
          });
          const { text, encoding } =
            existing === undefined
              ? { text: "", encoding: "utf-8" as const }
              : decodeText(existing.bytes);
          const updated = applyLabelChanges(text, wanted, replace_all === true);
          const unchanged =
            labels.length - updated.changes.filter((c) => wanted.has(c.channel)).length;
          if (updated.changes.length === 0) {
            return { device: device.alias, changes: [], unchanged, written: false };
          }

          let outcome: Awaited<ReturnType<typeof safeWrite>>;
          try {
            outcome = await safeWrite(
              device,
              LABELS_PATH,
              encodeText(updated.content, encoding),
              existing?.crc16,
            );
          } finally {
            device.labels.invalidate();
          }

          // The device must serve the new labels; report it if it does not (yet).
          const now = await device.client.call<{ labels?: Record<string, string> }>("io.labels");
          const applied = updated.changes.every((c) => (now.labels?.[c.channel] ?? "") === c.label);
          return {
            device: device.alias,
            changes: updated.changes,
            unchanged,
            written: true,
            applied,
            ...(!applied && {
              hint: "The file was written but the device does not report all new labels yet; check io_labels, a device_reboot REINIT reloads them.",
            }),
            backup: outcome.backup,
            crc16: outcome.crc16,
          };
        },
        ({ changes, written, applied, backup }) => ({ changes, written, applied, backup }),
      ),
    );
  },
};
