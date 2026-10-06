import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

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
}

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
      if (req.url === "/system/html/dat_vis.htm") {
        res.writeHead(200, { "content-type": "text/html" }).end(VARIABLE_TABLE_HTML);
      } else {
        res.writeHead(404).end("not found");
      }
      return;
    }
    res
      .writeHead(200, { "content-type": "text/plain" })
      .end(JSON.stringify(answer(state, req, body)));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    state,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

function answer(state: FakeDeviceState, req: IncomingMessage, body: string): Answer {
  const expected = `Basic ${Buffer.from(`${state.user}:${state.password}`).toString("base64")}`;
  const { method, params } = JSON.parse(body) as {
    method: string;
    params?: Record<string, unknown>;
  };
  state.calls.push(method);
  if (method !== "api.describe" && req.headers.authorization !== expected) {
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
      return { ok: true, result: { status_code: 1, status_text: "RUN" } };
    case "system.info":
      return { ok: true, result: { firmware_version: "TEST", rules_initialized: "TEST.TXT" } };
    case "system.mbox":
      return { ok: false, error: { code: 2, message: "keine Berechtigung" } };
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
