/**
 * Independent codec-conformance oracle: validates against the pinned upstream
 * JSON Schema with a validator configured for the source dialect (2020-12,
 * formats and `x-*` extensions as annotations).
 */
import Ajv2020 from "ajv/dist/2020.js"
import v1 from "../../repos/agent-client-protocol/schema/v1/schema.json"
import v2 from "../../repos/agent-client-protocol/schema/v2/schema.json"

const ajv = new Ajv2020({ strict: false, validateFormats: false, allErrors: false })
ajv.addSchema(v1 as object, "v1")
ajv.addSchema(v2 as object, "v2")

export const oracle = (version: 1 | 2, definition: string, value: unknown): boolean => {
  const validate = ajv.getSchema(`v${version}#/$defs/${definition}`)
  if (!validate) throw new Error(`unknown definition v${version} ${definition}`)
  return validate(value) as boolean
}
