import { describe, expect, it } from "vitest";
import { crc16Xmodem } from "./crc16.js";

const bytes = (s: string) => new TextEncoder().encode(s);

describe("crc16Xmodem", () => {
  it("matches the CRC-16/XMODEM check value", () => {
    expect(crc16Xmodem(bytes("123456789"))).toBe(0x31c3);
  });

  it("is 0 for empty input", () => {
    expect(crc16Xmodem(new Uint8Array())).toBe(0);
  });

  it("can be continued across chunks", () => {
    const whole = crc16Xmodem(bytes("A0.0 = E0.0;\r\nA0.1 = E0.1;\r\n"));
    const first = crc16Xmodem(bytes("A0.0 = E0.0;\r\n"));
    expect(crc16Xmodem(bytes("A0.1 = E0.1;\r\n"), first)).toBe(whole);
  });
});
