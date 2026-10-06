import { describe, expect, it } from "vitest";
import { writeValue } from "../tools/ioWrite.js";
import { lintRules } from "./rulesLint.js";

const operators = [
  { token: "&&", params: [] },
  { token: "TXT", params: ["text", "mboxlevel"] },
  { token: "NTY", params: ["title", "text", "prio"] },
  { token: "DOW", params: ["days", "on", "off"] },
];

describe("lintRules", () => {
  it("accepts complete lines, comments and quoted semicolons", () => {
    const content = [
      "/* header",
      "   NTY ;; inside a block comment */",
      'P9.0 = R9.0 TXT "a;b";13; // TXT ;;',
      "Z0.0 = E0.0 DOW 1111111;14:00;15:00;",
      "A0.0 = E0.0 && M0.0",
    ].join("\r\n");
    expect(lintRules(content, operators)).toEqual({ errors: [], warnings: [] });
  });

  it("reports empty middle parameters as errors", () => {
    const { errors } = lintRules('H0.0 = M0.0 NTY ;NULL;10;\nP9.0 = R9.0 TXT "x";;13;', operators);
    expect(errors).toEqual([
      { line: 1, message: expect.stringContaining("NTY: parameter 1 is empty") },
      { line: 2, message: expect.stringContaining("TXT: parameter 2 is empty") },
    ]);
  });

  it("warns about too few parameters", () => {
    const { warnings } = lintRules("Z0.0 = E0.0 DOW 1111111;14:00;", operators);
    expect(warnings[0]?.message).toContain("expects 3");
  });

  it("still finds ';;' without the operator list", () => {
    expect(lintRules('P9.0 = R9.0 TXT "x";;13;', []).errors).toHaveLength(1);
  });
});

describe("writeValue", () => {
  it("accepts only writable operand classes with valid values", () => {
    expect(writeValue("S0.0", true)).toBe("1");
    expect(writeValue("M9.7", 0)).toBe("0");
    expect(writeValue("SW3", 31.5)).toBe("31.5");
    expect(() => writeValue("S0.0", 2)).toThrow("0 or 1");
    expect(() => writeValue("AA0", Number.NaN)).toThrow("number");
    expect(() => writeValue("AA0", true)).toThrow("number");
    expect(() => writeValue("E0.0", 1)).toThrow("cannot be written");
    expect(() => writeValue("S0.8", 1)).toThrow("cannot be written");
  });
});
