/**
 * Reviewed, handwritten replacements for individual upstream definitions,
 * keyed by protocol version and definition name.
 *
 * Use an override only when a definition needs interpretation the emitter
 * cannot derive mechanically. Every entry must state why, and emission fails if
 * the named definition disappears upstream so stale overrides are noticed.
 * The pinned inputs currently need none.
 */
export interface Override {
  readonly reason: string
  /** TypeScript type expression. */
  readonly ts: string
  /** Effect Schema expression; may use `Schema`, `W` (internal/wire), and other definitions. */
  readonly schema: string
}

export type Overrides = Readonly<Record<number, Readonly<Record<string, Override>>>>

export const overrides: Overrides = {
  1: {},
  2: {}
}
