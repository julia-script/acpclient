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
import type * as SchemaAST from "effect/SchemaAST"

/** Attaches the upstream definition name and fixes the static type. */
export const def = <T>(identifier: string, schema: Schema.Top): Schema.Codec<T> =>
  schema.annotate({ identifier }) as unknown as Schema.Codec<T>

/** JSON Schema `integer`: any finite number without a fractional part. */
export const integer = Schema.Finite.check(
  Schema.makeFilter((n: number) => Number.isInteger(n), { expected: "an integer" })
)

/**
 * JSON Schema object. Objects are open unless the upstream schema restricts
 * additional properties, so undeclared keys are kept rather than stripped.
 */
export const object = (fields: Schema.Struct.Fields): Schema.Top =>
  Schema.StructWithRest(Schema.Struct(fields), [Schema.Record(Schema.String, Schema.Unknown)])

/** JSON Schema object whose keys are all constrained by `additionalProperties`. */
export const record = (value: Schema.Top): Schema.Top => Schema.Record(Schema.String, value)

/** JSON Schema `allOf`: the first member decodes, the others must also accept the input. */
export const allOf = (first: Schema.Top, ...rest: ReadonlyArray<Schema.Top>): Schema.Top =>
  rest.length === 0 ? first : first.check(
    ...rest.map((member) =>
      Schema.makeFilter((input: unknown) => {
        const result = Schema.decodeUnknownResult(member as Schema.Codec<unknown>)(input)
        return Result.isSuccess(result) ? undefined : result.failure.issue
      })
    ) as [SchemaAST.Filter<unknown>]
  )

/** JSON Schema `not`: the input must not satisfy `excluded`. */
export const not = (base: Schema.Top, excluded: Schema.Top): Schema.Top => {
  const matches = Schema.is(excluded as Schema.Codec<unknown>)
  return base.check(
    Schema.makeFilter((input: unknown) => !matches(input), { expected: "a value outside the known variants" })
  )
}
