/**
 * Which tailnet port the Inbox's door takes (inbox-tailnet-door.ts): the
 * first free one of 8443 to 8450, or the one its record says is its own; a
 * port mapped to anything else is never taken.
 */
import { describe, expect, test } from "bun:test";
import { chooseTailnetDoorPort } from "./inbox-tailnet-door";

/** `tailscale serve status --json` with these mappings. */
const status = (mappings: Record<number, string>) =>
  JSON.stringify({
    TCP: Object.fromEntries(Object.keys(mappings).map((p) => [p, { HTTPS: true }])),
    Web: Object.fromEntries(Object.entries(mappings).map(([p, proxy]) => [`mac.tail0000.ts.net:${p}`, { Handlers: { "/": { Proxy: proxy } } }])),
  });
const DOOR = "http://127.0.0.1:52900";
const THEIRS = "http://127.0.0.1:62440";

describe("chooseTailnetDoorPort", () => {
  test("8443 when it is free; the next free port when another mapping holds it", () => {
    expect(chooseTailnetDoorPort("{}", null)).toEqual({ state: "usable", port: 8443, own: null });
    expect(chooseTailnetDoorPort(status({ 8443: THEIRS, 8444: THEIRS }), null)).toEqual({ state: "usable", port: 8445, own: null });
  });

  test("a mapping is the Inbox's only when the record names its port and its target", () => {
    const record = { https_port: 8443, target: DOOR };
    expect(chooseTailnetDoorPort(status({ 8443: DOOR }), record)).toEqual({ state: "usable", port: 8443, own: DOOR });
    // The same target with no record, or on a port the record does not name, is someone else's.
    expect(chooseTailnetDoorPort(status({ 8443: DOOR }), null)).toEqual({ state: "usable", port: 8444, own: null });
    expect(chooseTailnetDoorPort(status({ 8443: DOOR }), { https_port: 8444, target: DOOR })).toEqual({ state: "usable", port: 8444, own: null });
    // The recorded port, now pointing elsewhere, is skipped.
    expect(chooseTailnetDoorPort(status({ 8443: THEIRS }), record)).toEqual({ state: "usable", port: 8444, own: null });
  });

  test("the recorded port, then the switch's, come before 8443, so the address stays the same", () => {
    expect(chooseTailnetDoorPort(status({ 8446: DOOR }), { https_port: 8446, target: DOOR })).toEqual({ state: "usable", port: 8446, own: DOOR });
    expect(chooseTailnetDoorPort("{}", null, 8445)).toEqual({ state: "usable", port: 8445, own: null });
    // A port outside the list is never taken, whatever was kept.
    expect(chooseTailnetDoorPort("{}", { https_port: 443, target: DOOR }, 59812)).toEqual({ state: "usable", port: 8443, own: null });
  });

  test("every port held is taken; output it cannot read is malformed, never a guess", () => {
    const all = Object.fromEntries([8443, 8444, 8445, 8446, 8447, 8448, 8449, 8450].map((p) => [p, THEIRS]));
    expect(chooseTailnetDoorPort(status(all), null)).toEqual({ state: "taken" });
    expect(chooseTailnetDoorPort("not json", null)).toEqual({ state: "malformed" });
  });
});
