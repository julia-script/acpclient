import type { ConnectOptions } from "../../src/AcpClient.ts"

/** Correlated initialization options for a contract suite's chosen version. */
export const connectOptions = (
  version: 1 | 2,
  options: Omit<ConnectOptions, "versions" | "params"> = {}
): ConnectOptions => version === 2
  ? { ...options, versions: [2], params: { info: { name: "test", version: "1.0.0" } } }
  : { ...options, versions: [1], params: { clientInfo: { name: "test", version: "1.0.0" } } }
