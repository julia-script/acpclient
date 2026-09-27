/**
 * Combinators used by the generated ACP wire schemas.
 *
 * Every generated schema is an identity codec over JSON data: decoding validates
 * and returns a structurally equal value, so excess keys, explicit `null`s, and
 * omitted keys survive round trips.
 *
 * @internal
 */
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"

/** Attach a definition name while checking its declared type against the codec. */
export const def = <T>(identifier: string, schema: Schema.Codec<T>): Schema.Codec<T> =>
  schema.annotate({ identifier })

/**
 * JSON Schema `allOf` and `not` filter values at runtime, but their TypeScript
 * result is broader than the intersection/refinement emitted from the source.
 * The generator uses this cast only for definitions containing those keywords.
 */
export const refinedDef = <T>(identifier: string, schema: Schema.Codec<unknown>): Schema.Codec<T> =>
  schema.annotate({ identifier }) as Schema.Codec<T>

/** JSON Schema `integer`: any finite number without a fractional part. */
export const integer = Schema.Finite.check(
  Schema.makeFilter((n: number) => Number.isInteger(n), { expected: "an integer" })
)

/**
 * JSON Schema object. Objects are open unless the upstream schema restricts
 * additional properties, so undeclared keys are kept rather than stripped.
 */
export const object = <const Fields extends Schema.Struct.Fields>(fields: Fields) =>
  Schema.StructWithRest(Schema.Struct(fields), [Schema.Record(Schema.String, Schema.Unknown)])

/** JSON Schema object whose keys are all constrained by `additionalProperties`. */
export const record = <A>(value: Schema.Codec<A>) => Schema.Record(Schema.String, value)

/** JSON Schema `allOf`: the first member decodes, the others must also accept the input. */
export const allOf = <A>(first: Schema.Codec<A>, ...rest: ReadonlyArray<Schema.Codec<unknown>>): Schema.Codec<A> =>
  rest.reduce<Schema.Codec<A>>((result, member) => result.check(Schema.makeFilter((input: unknown) => {
    const decoded = Schema.decodeUnknownResult(member)(input)
    return Result.isSuccess(decoded) ? undefined : decoded.failure.issue
  })), first)

/** JSON Schema `not`: the input must not satisfy `excluded`. */
export const not = <A>(base: Schema.Codec<A>, excluded: Schema.Codec<unknown>): Schema.Codec<A> => {
  const matches = Schema.is(excluded)
  return base.check(
    Schema.makeFilter((input: unknown) => !matches(input), { expected: "a value outside the known variants" })
  )
}
