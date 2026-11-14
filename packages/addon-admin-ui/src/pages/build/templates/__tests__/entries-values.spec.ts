/** An entries list is read back per kind; what a picker cannot draw is left out, not rewritten. */
import { describe, expect, it } from "vitest";
import {
  commandStepsOf,
  entriesValueOf,
  firedLeavesOf,
} from "../entries-values";

const FIRED = {
  kind: "device-fired",
  id: "ev-a",
  deviceId: 5656,
  eventIds: ["press_short"],
};
const DOMAIN = {
  kind: "command",
  target: { kind: "domain", deviceType: "light", roomId: "Kitchen" },
  actionId: "switch.off",
};

describe("entries values", () => {
  it("reads device-fired leaves and drops other triggers", () => {
    expect(
      firedLeavesOf([FIRED, { kind: "manual" }, { nonsense: true }]),
    ).toEqual([FIRED]);
  });

  it("reads a domain-target command step whole", () => {
    expect(
      commandStepsOf([DOMAIN, { kind: "command", actionId: "nope.nope" }]),
    ).toEqual([DOMAIN]);
  });

  it("an empty list is no value; a list is copied", () => {
    expect(entriesValueOf([])).toBeUndefined();
    expect(entriesValueOf([FIRED])).toEqual([FIRED]);
  });
});
