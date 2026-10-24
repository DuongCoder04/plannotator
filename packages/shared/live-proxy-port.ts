import { parsePortSelection, type ParsedPortSelection } from "./port-range";

/** Live proxies never inherit the editor's remote-mode port or bind address. */
export function getLiveProxyPortSelection(): ParsedPortSelection {
  const value = process.env.PLANNOTATOR_LIVE_PORT;
  if (value) {
    const parsed = parsePortSelection(value);
    if (parsed) return parsed;
    console.error(`[Plannotator] Warning: Invalid PLANNOTATOR_LIVE_PORT "${value}", using default`);
  }
  return { kind: "fixed", ports: [0] };
}

export function isLiveProxyAddressInUseError(error: unknown): boolean {
  return error instanceof Error && (
    ("code" in error && error.code === "EADDRINUSE") ||
    error.message.includes("EADDRINUSE")
  );
}

export class LiveProxyPortInUseError extends Error {
  constructor(selection: ParsedPortSelection) {
    const detail = selection.kind === "range"
      ? `every port in PLANNOTATOR_LIVE_PORT ${selection.ports[0]}-${selection.ports.at(-1)} is already in use`
      : `port ${selection.ports[0]} (PLANNOTATOR_LIVE_PORT) is already in use`;
    super(`Plannotator: live app proxy ${detail}. Close another live annotation session or set PLANNOTATOR_LIVE_PORT to a different port or range.`);
    this.name = "LiveProxyPortInUseError";
  }
}
