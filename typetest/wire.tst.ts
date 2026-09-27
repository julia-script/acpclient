import { describe, expect, it } from "tstyche"
import * as Schema from "effect/Schema"
import * as Wire from "../src/internal/wire.ts"
import * as V2 from "../src/protocol/v2/Schema.ts"

const ordinary = Wire.def<{ readonly id: string; readonly note?: string }>("Ordinary", Wire.object({
  id: Schema.String,
  note: Schema.optionalKey(Schema.String)
}))
const withExtra = { id: "x", extra: true }
const mismatchedIntersection = Wire.allOf(
  Wire.object({ message: Schema.Finite }),
  Wire.object({ mode: Schema.Literal("url") })
)

describe("generated wire codec types", () => {
  it("links ordinary definitions and preserves open, readonly, optional objects", () => {
    expect(Schema.Finite).type.not.toBeAssignableTo<Parameters<typeof Wire.def<{ readonly id: string }>>[1]>()
    expect(mismatchedIntersection).type.not.toBeAssignableTo<Parameters<typeof Wire.def<{
      readonly message: string
      readonly mode: "url"
    }>>[1]>()
    expect(ordinary).type.toBeAssignableTo<Schema.Codec<{ readonly id: string; readonly note?: string }>>()
    expect(withExtra).type.toBeAssignableTo<Schema.Schema.Type<typeof ordinary>>()
    expect({ id: "x", note: undefined }).type.toBeAssignableTo<Schema.Schema.Type<typeof ordinary>>()
    expect({ id: 1 }).type.not.toBeAssignableTo<Schema.Schema.Type<typeof ordinary>>()
    expect({ id: "x", note: 1 }).type.not.toBeAssignableTo<Schema.Schema.Type<typeof ordinary>>()
  })

  it("preserves generated refinement and intersection contracts", () => {
    expect(V2.CreateElicitationRequest).type.toBeAssignableTo<Schema.Codec<V2.CreateElicitationRequest>>()
    expect(V2.ContentBlock).type.toBeAssignableTo<Schema.Codec<V2.ContentBlock>>()
  })
})
