/** Inspect an unknown wire value without asserting an unchecked payload type. */
export const field = (value: unknown, path: string): unknown => {
  for (const key of path.split(".")) {
    if (!isRecord(value)) return undefined
    value = value[key]
  }
  return value
}
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null
