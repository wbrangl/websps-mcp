import { DeviceErrorCode, ServerErrorCode, WebspsError } from "../errors.js";
import { crc16Xmodem } from "./crc16.js";
import { MAX_FILE_BYTES } from "./files.js";
import type { Device } from "./registry.js";

/**
 * Reads a file and checks it against the device's CRC: this tells content from an error body
 * and detects a change between hashing and reading (one retry).
 */
export async function readVerified(device: Device, path: string) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const hash = await device.client.fileHash(path).catch((error: unknown) => {
      // The device refuses even to hash files above its size limit.
      if (error instanceof WebspsError && error.code === DeviceErrorCode.VALIDATION) {
        throw new WebspsError(error.code, error.message, {
          device: device.alias,
          hint: `Files above ${MAX_FILE_BYTES} bytes cannot be read through the device API; for the log file use log_read.`,
        });
      }
      throw error;
    });
    const bytes = await device.client.readFile(path);
    const crc16 = crc16Xmodem(bytes);
    if (crc16 === hash.crc16 && bytes.length === hash.bytes) return { bytes, crc16 };
  }
  throw new WebspsError(
    ServerErrorCode.BAD_RESPONSE,
    `${path} changed while reading or arrived incomplete; try again`,
    { device: device.alias },
  );
}

/** CRC and size of a file, or undefined if it does not exist. */
export async function currentHash(
  device: Device,
  path: string,
): Promise<{ crc16: number; bytes: number } | undefined> {
  try {
    return await device.client.fileHash(path);
  } catch (error) {
    if (error instanceof WebspsError && error.code === DeviceErrorCode.NOT_FOUND) return undefined;
    throw error;
  }
}

export function encodeText(text: string, encoding: "utf-8" | "latin1"): Uint8Array {
  if (encoding === "utf-8") return new TextEncoder().encode(text);
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code > 0xff) {
      throw new WebspsError(
        ServerErrorCode.INVALID_INPUT,
        `Character "${text[i]}" cannot be stored as Latin-1; use encoding utf-8`,
      );
    }
    bytes[i] = code;
  }
  return bytes;
}

export interface WriteOutcome {
  path: string;
  bytes: number;
  /** New CRC: the `expected_hash` for the next write of this file. */
  crc16: number;
  created: boolean;
  /** Server-side copy of the previous content in the state directory. */
  backup?: string;
  device_result: unknown;
}

/**
 * Writes a file safely: refuses to overwrite without the caller's `expected_hash` (optimistic
 * concurrency), keeps a timestamped backup of the old content, writes with the hash so the device
 * re-checks it right before overwriting, and verifies the result afterwards.
 */
export async function safeWrite(
  device: Device,
  path: string,
  content: Uint8Array,
  expectedHash: number | undefined,
): Promise<WriteOutcome> {
  if (content.length > MAX_FILE_BYTES) {
    throw new WebspsError(
      ServerErrorCode.INVALID_INPUT,
      `Content has ${content.length} bytes; the device limit is ${MAX_FILE_BYTES}`,
    );
  }
  const current = await currentHash(device, path);
  if (current !== undefined && expectedHash === undefined) {
    throw new WebspsError(
      ServerErrorCode.INVALID_INPUT,
      `${path} already exists; pass expected_hash (the crc16 from file_read) to overwrite it`,
    );
  }
  if (current !== undefined && expectedHash !== current.crc16) {
    throw new WebspsError(
      DeviceErrorCode.VALIDATION,
      `${path} changed since it was read (expected_hash ${expectedHash}, now ${current.crc16})`,
      { device: device.alias, hint: "Read the file again with file_read and redo the change." },
    );
  }

  let backup: string | undefined;
  if (current !== undefined) {
    const old = await readVerified(device, path);
    backup = await device.backups.save(path, old.bytes);
  }

  const deviceResult = await device.client.upload(path, content, {
    expectedHash: current?.crc16,
  });
  const crc16 = crc16Xmodem(content);
  const written = await device.client.fileHash(path);
  if (written.crc16 !== crc16 || written.bytes !== content.length) {
    throw new WebspsError(
      ServerErrorCode.BAD_RESPONSE,
      `${path} on the device does not match what was sent (crc ${written.crc16}, expected ${crc16})`,
      { device: device.alias, ...(backup !== undefined && { details: { backup } }) },
    );
  }
  return {
    path,
    bytes: content.length,
    crc16,
    created: current === undefined,
    ...(backup !== undefined && { backup }),
    device_result: deviceResult,
  };
}
