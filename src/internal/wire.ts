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

type Intersection<Members extends ReadonlyArray<Schema.Codec<unknown>>> =
  Members extends readonly [infer First extends Schema.Codec<unknown>, ...infer Rest extends ReadonlyArray<Schema.Codec<unknown>>]
    ? Schema.Schema.Type<First> & Intersection<Rest>
    : unknown

/**
 * JSON Schema `allOf`: each member validates the same identity-decoded input.
 * Effect's `check` keeps the first codec's type, so the cast exposes the
 * intersection established by the remaining successful validations.
 */
export const allOf = <A, const Rest extends ReadonlyArray<Schema.Codec<unknown>>>(
  first: Schema.Codec<A>,
  ...rest: Rest
): Schema.Codec<A & Intersection<Rest>> =>
  rest.reduce<Schema.Codec<A>>((result, member) => result.check(Schema.makeFilter((input: unknown) => {
    const decoded = Schema.decodeUnknownResult(member)(input)
    return Result.isSuccess(decoded) ? undefined : decoded.failure.issue
  })), first) as Schema.Codec<A & Intersection<Rest>>

/** JSON Schema `not`: the input must not satisfy `excluded`. */
export const not = <A>(base: Schema.Codec<A>, excluded: Schema.Codec<unknown>): Schema.Codec<A> => {
  const matches = Schema.is(excluded)
  return base.check(
    Schema.makeFilter((input: unknown) => !matches(input), { expected: "a value outside the known variants" })
  )
}
