import { ServerErrorCode, WebspsError } from "../errors.js";
import { MAX_CHANNEL_BYTES } from "./channels.js";

/** The device keeps channel labels in this INI file (section `[LABELS]`, lines `channel=label`). */
export const LABELS_PATH = "rules/SYMBOLIK.INI";
const SECTION = "[LABELS]";
// Verified on the device; longer labels are untested.
export const MAX_LABEL_BYTES = 100;
/** INI structure characters would corrupt the label file (same rules as the device's io.label_set). */
const CHANNEL_FORBIDDEN = /[[\]=\r\n]/;
const LABEL_FORBIDDEN = /[[\]=;\r\n]/;

function invalid(message: string): WebspsError {
  return new WebspsError(ServerErrorCode.INVALID_INPUT, message);
}

/** Trims and checks a channel name for use as a label key. */
export function labelChannel(channel: string): string {
  const name = channel.trim();
  if (name === "" || Buffer.byteLength(name) > MAX_CHANNEL_BYTES || CHANNEL_FORBIDDEN.test(name)) {
    throw invalid(
      `Invalid channel "${channel}" (1-${MAX_CHANNEL_BYTES} bytes, no [ ] = or line breaks)`,
    );
  }
  return name;
}

/** Checks a label text; an empty label means "delete". */
export function checkLabel(channel: string, label: string): void {
  if (LABEL_FORBIDDEN.test(label)) {
    throw invalid(`Label of ${channel} must not contain [ ] = ; or line breaks`);
  }
  if (Buffer.byteLength(label) > MAX_LABEL_BYTES) {
    throw invalid(`Label of ${channel} is longer than ${MAX_LABEL_BYTES} bytes`);
  }
}

export interface LabelChange {
  channel: string;
  /** New label; empty when the label was removed. */
  label: string;
  previous_label: string | null;
}

/**
 * Applies label changes to the content of SYMBOLIK.INI. Only `channel=label` lines inside the
 * `[LABELS]` section are touched: existing ones are replaced in place or removed, new ones are
 * appended to the section. Everything else (other sections, comments, blank lines) stays as it
 * was. With `replaceAll`, labels not mentioned in `labels` are removed.
 */
export function applyLabelChanges(
  content: string,
  labels: ReadonlyMap<string, string>,
  replaceAll: boolean,
): { content: string; changes: LabelChange[]; current: Map<string, string> } {
  const lines = content === "" ? [] : content.split(/\r?\n/);
  // A trailing line break leaves an empty last element; it is restored when joining.
  const trailingBreak = lines.length > 0 && lines.at(-1) === "";
  if (trailingBreak) lines.pop();

  let start = lines.findIndex((l) => l.trim().toUpperCase() === SECTION);
  if (start < 0) {
    lines.push(SECTION);
    start = lines.length - 1;
  }
  let end = lines.findIndex((l, i) => i > start && l.trim().startsWith("["));
  if (end < 0) end = lines.length;

  const current = new Map<string, string>();
  const changes: LabelChange[] = [];
  const kept: string[] = [];
  const seen = new Set<string>();
  for (const line of lines.slice(start + 1, end)) {
    const eq = line.indexOf("=");
    const key = eq > 0 ? line.slice(0, eq).trim() : undefined;
    if (key === undefined || line.trimStart().startsWith(";")) {
      kept.push(line);
      continue;
    }
    const value = line.slice(eq + 1);
    current.set(key, value);
    const wanted = labels.get(key);
    if (wanted === undefined) {
      if (replaceAll) changes.push({ channel: key, label: "", previous_label: value });
      else kept.push(line);
      continue;
    }
    seen.add(key);
    if (wanted === "") {
      changes.push({ channel: key, label: "", previous_label: value });
    } else {
      if (wanted !== value) changes.push({ channel: key, label: wanted, previous_label: value });
      kept.push(`${key}=${wanted}`);
    }
  }
  for (const [channel, label] of labels) {
    if (seen.has(channel) || label === "") continue;
    changes.push({ channel, label, previous_label: null });
    kept.push(`${channel}=${label}`);
  }

  const result = [...lines.slice(0, start + 1), ...kept, ...lines.slice(end)];
  return {
    content: result.join("\r\n") + (trailingBreak || result.length > 0 ? "\r\n" : ""),
    changes,
    current,
  };
}
