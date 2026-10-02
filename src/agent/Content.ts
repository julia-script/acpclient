/**
 * Version-neutral content block used by AcpAgent handlers.
 *
 * **Details**
 *
 * The wire schemas for v1 and v2 describe overlapping but distinct content
 * blocks. Handlers receive their union, retaining each variant's fields.
 * The negotiated version's schema validates content at the wire boundary.
 */
import type * as V1 from "../protocol/v1/Schema.ts"
import type * as V2 from "../protocol/v2/Schema.ts"
/**
 * Union of v1 and v2 content blocks accepted by version-neutral agent handlers.
 *
 * **Details**
 *
 * The negotiated wire schema validates emitted content; membership in the union does not imply
 * support in both versions.
 *
 * @category models
 */
export type ContentBlock = V1.ContentBlock | V2.ContentBlock

/**
 * The neutral prompt shape passed to `prompt.insert` and `prompt.execute`.
 *
 * @category models
 */
export type Prompt = ReadonlyArray<ContentBlock>
