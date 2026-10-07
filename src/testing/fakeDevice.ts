import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { crc16Xmodem } from "../device/crc16.js";

/** Minimal stand-in for the device's "Variablen ID" help table (same structure, own content). */
export const VARIABLE_TABLE_HTML = `<html><body>
<ul><li><a href="#ID" data-bs-toggle="tab">Variablen ID</a></li></ul>
<div class="tab-content">
<div role="tabpanel" class="tab-pane active" id="ID">
<table class="table">
<tr><th>Operand</th><th>Anzahl</th><th>Bezeichnung</th><th>Typ</th><th>Feldname</th><th>ID</th></tr>
<tr><td>Hx.x</td><td>16</td><td>Melder</td><td>VKE</td><td>HBx (Byte)</td><td>H0.0</td></tr>
<tr><td>-</td><td>16</td><td>Counter</td><td>Zählwert</td><td>CVxx</td><td>CV0.0</td></tr>
<tr><td>-</td><td>² 2</td><td>Analog Eingang</td><td>Wert</td><td>WAE[x] (Array)</td><td>AE0</td></tr>
<tr><td>Px.x</td><td>8</td><td>Mbox</td><td>Text</td><td>P[M,T]x.x</td><td>PM0.0</td></tr>
<tr><td>Sx.x</td><td>16</td><td>Schalter</td><td>OP</td><td>SBx (Byte)</td><td>S0.0</td></tr>
</table>
</div>
<div role="tabpanel" class="tab-pane" id="other"><table><tr><td>a</td><td>b</td><td>c</td><td>d</td><td>XBx (Byte)</td><td>X0.0</td></tr></table></div>
</div></body></html>`;

export interface FakeDeviceState {
  user: string;
  password: string;
  bits: Record<string, number>;
  readAll: Record<string, unknown>;
  labels: Record<string, string>;
  /** Number of BUSY answers to give before answering normally. */
  busy: number;
  calls: string[];
  /** Files of the `/files` endpoint by path, e.g. `rules/TEST.TXT`. */
  files: Record<string, string>;
  /** Console ring buffer, oldest first; the device returns the newest 25. */
  log: { seq: number; timestamp: string; message: string }[];
  used: Record<string, number[]>;
  config: Record<string, unknown>;
  /** Configured and loaded root rules file. */
  root: string;
  loaded: string;
  status: { status_code: number; status_text: string };
  /** Writing the key channel also sets the value channel (stands in for a rules line). */
  mirror: Record<string, string>;
  /** Partial chunked uploads by path and action. */
  uploads: Record<string, Buffer>;
  /** Delay before answering rules.reload; the reload itself takes effect immediately. */
  reloadDelayMs: number;
}

const STATUS = {
  RUN: { status_code: 1, status_text: "RUN" },
  STOP: { status_code: 0, status_text: "STOP" },
  RULES: { status_code: -1, status_text: "RULES" },
} as const;

const CONFIG_FIELDS = [
  {
    name: "device_name",
    type: "string",
    section: "DEVICE",
    secret: false,
    critical: false,
    restart_required: false,
  },
  {
    name: "admin_password",
    type: "string",
    section: "USERS",
    secret: true,
    critical: true,
    restart_required: false,
  },
  {
    name: "time_source",
    type: "bool",
    section: "TIME",
    secret: false,
    critical: false,
    restart_required: false,
  },
];
const SCHEMA_PAGE_SIZE = 2;

export const RULES_HELP_HTML =
  "<html><head><style>p{}</style></head><body><h4>Merker</h4><p>M0.0&nbsp;=&nbsp;E0.0 &amp;&amp; M0.1</p>" +
  "<table><tr><td>SET</td><td>setzen</td></tr></table></body></html>";

export function defaultState(): FakeDeviceState {
  return {
    user: "api_user",
    password: "secret",
    bits: { "S0.0": 1, "H1.2": 0 },
    readAll: {
      HB: [0, 4],
      CV: [0, 0, 0, 7, ...Array<number>(28).fill(0)],
      WAE: [12.5, 0],
      SB: [1, 0],
      WB: [2],
      status: 1,
      timestamp: "2026-01-01T00:00:00Z",
    },
    labels: { "S0.0": "Pump on" },
    busy: 0,
    calls: [],
    files: {
      "rules/TEST.TXT": "A0.0 = E0.0 && M0.0;\r\nM0.0 = S0.0;\r\n",
      "rules/TEST.BAK": "A0.0 = E0.0;\r\n",
      "rules/SYMBOLIK.INI": "[SYMBOLIK]\r\nS0.0=Pump on\r\n",
      "mails/HELLO.TXT": "Grüße",
    },
    log: Array.from({ length: 30 }, (_, i) => ({
      seq: i + 1,
      timestamp: "10:00:00",
      message: i % 2 === 0 ? `Rules loaded ${i + 1}` : `API Basic-Auth OK ${i + 1}`,
    })),
    used: { S: [1, 0, 0, 0, 0, 0, 0, 0], M: [2, 1, 0, 0, 0, 0, 0, 0] },
    config: { device_name: "Test", admin_password: "pw", time_source: false },
    root: "TEST.TXT",
    loaded: "TEST.TXT",
    status: { ...STATUS.RUN },
    mirror: { "S5.0": "A0.7" },
    uploads: {},
    reloadDelayMs: 0,
  };
}

type Answer =
  | { ok: true; result: unknown }
  | { ok: false; error: { code: number; message: string } };

export interface FakeDevice {
  url: string;
  state: FakeDeviceState;
  close(): Promise<void>;
}

/** Local HTTP server answering like a Web@SPS device: always HTTP 200, errors in the body. */
export async function startFakeDevice(
  state: FakeDeviceState = defaultState(),
): Promise<FakeDevice> {
  const server: Server = createServer(async (req, res) => {
    const body = await readBody(req);
    if (req.method === "GET") {
      const page = PAGES[req.url ?? ""];
      if (page !== undefined) res.writeHead(200, { "content-type": "text/html" }).end(page);
      else res.writeHead(404).end("not found");
      return;
    }
    if (req.url === "/files") {
      const reply = files(state, req, body);
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(typeof reply === "string" ? reply : JSON.stringify(reply));
      return;
    }
    const reply = answer(state, req, body);
    if (state.reloadDelayMs > 0 && body.includes('"rules.reload"')) {
      await new Promise((resolve) => setTimeout(resolve, state.reloadDelayMs));
    }
    res.writeHead(200, { "content-type": "text/plain" }).end(JSON.stringify(reply));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    state,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

const PAGES: Record<string, string> = {
  "/system/html/dat_vis.htm": VARIABLE_TABLE_HTML,
  "/system/html/dat_rul.htm": RULES_HELP_HTML,
};

function authorized(state: FakeDeviceState, req: IncomingMessage): boolean {
  const expected = `Basic ${Buffer.from(`${state.user}:${state.password}`).toString("base64")}`;
  return req.headers.authorization === expected;
}

const SEPARATOR = "\n---CONTENT---\n";
const fail = (code: number, message: string): Answer => ({ ok: false, error: { code, message } });

/** `/files`: raw content on success, a JSON error body otherwise. */
function files(state: FakeDeviceState, req: IncomingMessage, body: string): string | Answer {
  const split = body.indexOf(SEPARATOR);
  if (split >= 0) {
    if (!authorized(state, req)) return fail(1, "Nicht angemeldet");
    return upload(
      state,
      JSON.parse(body.slice(0, split)),
      Buffer.from(body.slice(split + SEPARATOR.length)),
    );
  }
  const { path, action } = JSON.parse(body) as { path: string; action?: string };
  state.calls.push(`/files ${action ?? "read"} ${path}`);
  if (!authorized(state, req))
    return { ok: false, error: { code: 1, message: "Nicht angemeldet" } };
  if (path === "log/LOGFILE.TXT") {
    return { ok: false, error: { code: 6, message: "Datei zu gross (max 32767 Bytes)" } };
  }
  const content = state.files[path];
  if (content === undefined)
    return { ok: false, error: { code: 4, message: "Datei nicht gefunden" } };
  if (action === "hash") {
    const bytes = Buffer.from(content);
    return { ok: true, result: { crc16: crc16Xmodem(bytes), bytes: bytes.length } };
  }
  return content;
}

interface UploadHeader {
  path: string;
  action?: string;
  chunk?: number;
  chunks?: number;
  expected_hash?: number;
}

function upload(state: FakeDeviceState, header: UploadHeader, content: Buffer): Answer {
  const { path, action } = header;
  state.calls.push(`/files ${action ?? "write"} ${path}`);
  const key = `${action ?? "write"} ${path}`;
  const sofar = Buffer.concat([state.uploads[key] ?? Buffer.alloc(0), content]);
  const chunks = header.chunks ?? 1;
  if ((header.chunk ?? 0) < chunks - 1) {
    state.uploads[key] = sofar;
    return { ok: true, result: { chunk_received: (header.chunk ?? 0) + 1, chunks_total: chunks } };
  }
  delete state.uploads[key];
  const text = sofar.toString();

  if (action === "validate") {
    const errors = text
      .split("\r\n")
      .flatMap((line, i) =>
        line.includes("BAD") ? [{ line: i + 1, code: 13, message: "VKE fehlt" }] : [],
      );
    return {
      ok: true,
      result: {
        valid: errors.length === 0,
        error_count: errors.length,
        errors,
        warning_count: 0,
        warnings: [],
      },
    };
  }
  const dir = path.split("/")[0] ?? "";
  if (!["rules", "mails", "svg", "htm"].includes(dir)) return fail(2, "Schreiben nicht erlaubt");
  const name = path.slice(dir.length + 1);
  if (dir === "rules" && !/^[A-Z0-9_-]{1,8}\.TXT$/.test(name)) return fail(3, "8.3-Format .TXT");
  const old = state.files[path];
  if (old !== undefined && header.expected_hash !== undefined) {
    if (crc16Xmodem(Buffer.from(old)) !== header.expected_hash)
      return fail(6, "expected_hash stimmt nicht");
  }
  const bak = path.replace(/\.[^.]+$/, ".BAK");
  if (old !== undefined) state.files[bak] = old;
  state.files[path] = text;
  return {
    ok: true,
    result: {
      path,
      bytes: sofar.length,
      backup: bak.slice(dir.length + 1),
      is_root: name === state.root,
    },
  };
}

function answer(state: FakeDeviceState, req: IncomingMessage, body: string): Answer {
  const { method, params } = JSON.parse(body) as {
    method: string;
    params?: Record<string, unknown>;
  };
  state.calls.push(method);
  if (method !== "api.describe" && !authorized(state, req)) {
    return { ok: false, error: { code: 1, message: "Ungueltige Zugangsdaten" } };
  }
  if (state.busy > 0) {
    state.busy--;
    return { ok: false, error: { code: 5, message: "busy" } };
  }
  switch (method) {
    case "api.describe":
      return { ok: true, result: { device_variant: "ANALOG", firmware_version: "TEST" } };
    case "system.status":
      return { ok: true, result: state.status };
    case "system.control": {
      const command = String(params?.command);
      if (command === "NTPSYNC") return fail(6, "NTP ist nicht aktiviert (time_source)");
      if (command === "STOP") state.status = { ...STATUS.STOP };
      else if (["RUN", "REINIT", "REBOOT"].includes(command)) state.status = { ...STATUS.RUN };
      else if (command !== "RMLOG") return fail(3, `Ungültiger Command: ${command}`);
      return { ok: true, result: { command, success: true } };
    }
    case "system.set_time":
      return { ok: true, result: { ...params } };
    case "io.write": {
      const writes = (params?.writes as { channel: string; value: string }[] | undefined) ?? [];
      return {
        ok: true,
        result: {
          writes: writes.map(({ channel, value }) => {
            const v = Number(value);
            if (/^(AA|SW)\d/.test(channel)) {
              if (v < 0 || v > 100) {
                return { channel, success: false, error: "Wertebereich 0-100 verletzt" };
              }
            } else if (/^[SMVU]\d/.test(channel)) {
              if (v !== 0 && v !== 1) return { channel, success: false, error: "0 oder 1" };
            } else {
              return { channel, success: false, error: "nicht schreibbar" };
            }
            state.bits[channel] = v;
            const mirrored = state.mirror[channel];
            if (mirrored !== undefined) state.bits[mirrored] = v;
            return { channel, value: v, success: true };
          }),
        },
      };
    }
    case "data.clear_recording":
      return { ok: true, result: { channel: params?.channel, clear_requested: true } };
    case "io.label_set": {
      const channel = String(params?.channel);
      const label = String(params?.label ?? "");
      if (label === "") delete state.labels[channel];
      else state.labels[channel] = label;
      return { ok: true, result: { channel, label, deleted: label === "" } };
    }
    case "config.set": {
      const key = String(params?.key);
      if (!(key in state.config)) return fail(4, `Unbekannter Config-Schluessel: ${key}`);
      state.config[key] = params?.value;
      return { ok: true, result: { key, restart_required: false } };
    }
    case "rules.get_root":
      return { ok: true, result: { configured_root: state.root, loaded_root: state.loaded } };
    case "rules.set_root": {
      const name = String(params?.name);
      if (state.files[`rules/${name}`] === undefined) return fail(4, "Datei nicht gefunden");
      state.root = name;
      return { ok: true, result: { configured_root: name, restart_required: true } };
    }
    case "rules.reload":
      return reload(state);
    case "rules.delete": {
      const name = String(params?.name);
      if (name === state.root && params?.force !== true)
        return fail(2, "Aktive Root-Datei nur mit force");
      if (state.files[`rules/${name}`] === undefined) return fail(4, "Datei nicht gefunden");
      delete state.files[`rules/${name}`];
      return { ok: true, result: { name, deleted: true } };
    }
    case "files.delete": {
      const path = `${params?.directory}/${params?.filename}`;
      if (state.files[path] === undefined) return fail(4, "Datei nicht gefunden");
      delete state.files[path];
      return {
        ok: true,
        result: { directory: params?.directory, filename: params?.filename, success: true },
      };
    }
    case "system.info":
      return { ok: true, result: { firmware_version: "TEST", rules_initialized: "TEST.TXT" } };
    case "system.mbox":
      return { ok: false, error: { code: 2, message: "keine Berechtigung" } };
    case "io.read_used":
      return { ok: true, result: state.used };
    case "system.log":
      return {
        ok: true,
        result: { entries: state.log.slice(-25).reverse(), limit: 25 },
      };
    case "logs.search": {
      const pattern = String(params?.pattern ?? "");
      const matches = state.log.filter((e) => e.message.includes(pattern)).map((e) => e.message);
      // Like current firmware: only the end of the file unless full_scan is requested.
      const full = params?.full_scan === true;
      return {
        ok: true,
        result: {
          pattern,
          total_matches: matches.length,
          searched_from_byte: full ? 0 : 4000,
          file_size: 5000,
          matches: matches.slice(-2),
          returned: 2,
        },
      };
    }
    case "rules.operators":
      return { ok: true, result: { operators: [{ code: 1, token: "&&", params: [] }], count: 1 } };
    case "rules.list":
      return {
        ok: true,
        result: {
          root: "TEST.TXT",
          files: Object.entries(state.files)
            .filter(([path]) => path.startsWith("rules/"))
            .map(([path, content]) => ({
              name: path.slice("rules/".length),
              size: Buffer.byteLength(content),
              is_root: path === "rules/TEST.TXT",
            })),
        },
      };
    case "files.list": {
      // Pages of names padded with "-", like the device (small page size to exercise paging).
      const prefix = `${params?.directory}/`;
      const names = Object.keys(state.files)
        .filter((path) => path.startsWith(prefix))
        .map((path) => path.slice(prefix.length));
      const page = Number(params?.page ?? 0);
      const files = names.slice(page * 2, page * 2 + 2);
      while (files.length < 2) files.push("-");
      return { ok: true, result: { directory: params?.directory, page, limit: 2, files } };
    }
    case "config.get_section": {
      const section = String(params?.section);
      const keys = CONFIG_FIELDS.filter((f) => f.section === section).map((f) => f.name);
      return { ok: true, result: Object.fromEntries(keys.map((k) => [k, state.config[k]])) };
    }
    case "config.schema": {
      const page = Number(params?.page ?? 0);
      const fields = CONFIG_FIELDS.slice(page * SCHEMA_PAGE_SIZE, (page + 1) * SCHEMA_PAGE_SIZE);
      return {
        ok: true,
        result: { page, page_size: SCHEMA_PAGE_SIZE, total: CONFIG_FIELDS.length, fields },
      };
    }
    case "config.get_multi": {
      const keys = (params?.keys as string[] | undefined) ?? [];
      return {
        ok: true,
        result: Object.fromEntries(
          keys.filter((k) => k in state.config).map((k) => [k, state.config[k]]),
        ),
      };
    }
    case "io.labels":
      return { ok: true, result: { labels: state.labels } };
    case "io.read_all":
      return { ok: true, result: state.readAll };
    case "io.read": {
      const channels = (params?.channels as string[] | undefined) ?? [];
      return {
        ok: true,
        result: {
          channels: channels.map((channel) =>
            channel in state.bits
              ? { channel, value: state.bits[channel] }
              : { channel, error: "unbekannter Kanal" },
          ),
          timestamp: "2026-01-01T00:00:00Z",
        },
      };
    }
    default:
      return { ok: false, error: { code: 3, message: `unknown method ${method}` } };
  }
}

/** Content containing "FAIL" passes validation but fails to load, like a runtime rules error. */
function reload(state: FakeDeviceState): Answer {
  const path = `rules/${state.root}`;
  state.loaded = state.root;
  if (!(state.files[path] ?? "").includes("FAIL")) {
    if (state.status.status_code < 0) state.status = { ...STATUS.STOP };
    return { ok: true, result: { root: state.root, reloaded: true } };
  }
  const bak = state.files[path.replace(/\.TXT$/, ".BAK")];
  if (bak === undefined) {
    state.status = { ...STATUS.RULES };
    return fail(6, `RULES_ERROR beim Neuladen von ${state.root} - keine Sicherungskopie`);
  }
  state.files[path] = bak;
  state.status = { ...STATUS.STOP };
  return fail(6, `RULES_ERROR beim Neuladen von ${state.root} - zurueckgerollt, Zustand STOP`);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}
