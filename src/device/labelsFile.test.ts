import { describe, expect, it } from "vitest";
import { applyLabelChanges, checkLabel, labelChannel } from "./labelsFile.js";

const ini = "\r\n[LABELS]\r\nS0.0=Pump on\r\n; note\r\nH0.0=Status\r\n[OTHER]\r\nkeep=me\r\n";

describe("applyLabelChanges", () => {
  it("changes only [LABELS] entries and keeps everything else", () => {
    const { content, changes } = applyLabelChanges(
      ini,
      new Map([
        ["S0.0", "Pump switch"],
        ["H0.0", ""],
        ["M9.0", "New"],
      ]),
      false,
    );
    expect(content).toBe(
      "\r\n[LABELS]\r\nS0.0=Pump switch\r\n; note\r\nM9.0=New\r\n[OTHER]\r\nkeep=me\r\n",
    );
    expect(changes).toEqual([
      { channel: "S0.0", label: "Pump switch", previous_label: "Pump on" },
      { channel: "H0.0", label: "", previous_label: "Status" },
      { channel: "M9.0", label: "New", previous_label: null },
    ]);
  });

  it("removes unlisted labels with replaceAll, but not other sections", () => {
    const { content } = applyLabelChanges(ini, new Map([["A0.0", "Light"]]), true);
    expect(content).toBe("\r\n[LABELS]\r\n; note\r\nA0.0=Light\r\n[OTHER]\r\nkeep=me\r\n");
  });

  it("creates the section in an empty or foreign file", () => {
    expect(applyLabelChanges("", new Map([["S0.0", "x"]]), false).content).toBe(
      "[LABELS]\r\nS0.0=x\r\n",
    );
    expect(applyLabelChanges("[OTHER]\r\na=b\r\n", new Map([["S0.0", "x"]]), false).content).toBe(
      "[OTHER]\r\na=b\r\n[LABELS]\r\nS0.0=x\r\n",
    );
  });

  it("reports no changes when nothing differs", () => {
    expect(applyLabelChanges(ini, new Map([["S0.0", "Pump on"]]), false).changes).toEqual([]);
  });
});

describe("label checks", () => {
  it("allows ';' in channel names but not in labels", () => {
    expect(labelChannel(" X;1 ")).toBe("X;1");
    expect(() => labelChannel("S0=0")).toThrow();
    expect(() => labelChannel("A".repeat(16))).toThrow();
    expect(() => checkLabel("S0.0", "a;b")).toThrow();
    expect(() => checkLabel("S0.0", "x".repeat(101))).toThrow("100 bytes");
    expect(() => checkLabel("S0.0", "Pumpe Ein")).not.toThrow();
  });
});
