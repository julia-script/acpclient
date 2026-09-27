import * as Result from "effect/Result"
import * as Data from "effect/Data"
import * as Json from "../../src/internal/json.ts"
/**
 * ACP-specific JSON Schema (2020-12) to Effect Schema emitter.
 *
 * Only the vocabulary used by the pinned ACP schemas is supported. Any other
 * validation keyword fails generation with the affected definition named, so an
 * upstream change can never silently widen what the codecs accept. Annotation
 * keywords (and `x-*` extensions, which the source dialect ignores) are skipped.
 */
import type { JsonSchemaDocument, Manifest, ManifestInput } from "./inputs.ts"
import { overrides as defaultOverrides, type Overrides } from "./overrides.ts"

export class UnsupportedSchemaError extends Data.TaggedError("UnsupportedSchemaError")<{ readonly message: string }> {
  constructor(readonly definition: string, readonly construct: string, detail?: string) {
    super({ message: `Unsupported JSON Schema construct "${construct}" in definition ${definition}${detail ? `: ${detail}` : ""}` })
  }
}

export class UnknownOverrideError extends Data.TaggedError("UnknownOverrideError")<{
  readonly definition: string
  readonly version: number
  readonly message: string
}> {
  constructor(definition: string, version: number) {
    super({ definition, version, message: `Override for unknown definition ${definition} in v${version}` })
  }
}

export type EmitError = UnsupportedSchemaError | UnknownOverrideError

const annotationKeywords = new Set([
  "$schema",
  "$comment",
  "title",
  "description",
  "default",
  "examples",
  "deprecated",
  "format", // annotation-only in the 2020-12 source dialect
  "contentEncoding", // annotation-only in 2020-12
  "discriminator" // OpenAPI hint; the variants themselves carry the constraint
])

const validationKeywords = new Set([
  "$ref",
  "type",
  "const",
  "enum",
  "properties",
  "required",
  "additionalProperties",
  "unevaluatedProperties",
  "items",
  "minItems",
  "minimum",
  "maximum",
  "pattern",
  "allOf",
  "anyOf",
  "oneOf",
  "not"
])

const typeScoped: Record<string, ReadonlyArray<string>> = {
  properties: ["object"],
  required: ["object"],
  additionalProperties: ["object"],
  unevaluatedProperties: ["object"],
  items: ["array"],
  minItems: ["array"],
  minimum: ["integer", "number"],
  maximum: ["integer", "number"],
  pattern: ["string"]
}

const reserved = new Set(["Schema", "Wire", "AcpSchema", "version", "provenance", "agentMethods", "clientMethods", "protocolMethods"])

type Node = Readonly<Record<string, unknown>>

interface Emitted {
  readonly ts: string
  readonly schema: string
  /** A nested allOf/not prevents Effect from inferring the full declared type. */
  readonly refined?: boolean
}

const isNode = (u: unknown): u is Node => typeof u === "object" && u !== null && !Array.isArray(u)
// Generation is a synchronous compiler: invalid literals stop it with its
// declared diagnostic, just like unsupported schema constructs below.
const str = (u: unknown): string => {
  const encoded = Json.encodeResult(u)
  if (Result.isFailure(encoded)) throw new UnsupportedSchemaError("literal", "JSON", encoded.failure.message)
  return encoded.success
}
const indent = (s: string, by = "  ") => s.split("\n").join(`\n${by}`)
const propertyKey = (k: string) => {
  if (k === "__proto__") return `[${str(k)}]`
  return /^[A-Za-z_$][\w$]*$/.test(k) ? k : str(k)
}
const methodKey = (k: string) => k === "__proto__" ? propertyKey(k) : str(k)

class Emitter {
  constructor(readonly definitions: Readonly<Record<string, unknown>>, readonly definition: string) {}

  fail(construct: string, detail?: string): never {
    throw new UnsupportedSchemaError(this.definition, construct, detail)
  }

  node(input: unknown): Emitted {
    if (input === true) return { ts: "unknown", schema: "Schema.Unknown" }
    if (!isNode(input)) return this.fail(str(input), "schema must be an object or true")
    for (const key of Object.keys(input)) {
      if (key.startsWith("x-") || annotationKeywords.has(key)) continue
      if (!validationKeywords.has(key)) this.fail(key)
    }
    const inputTypes = Array.isArray(input.type) ? input.type : [input.type]
    const types = input.type === undefined ? undefined : inputTypes.map((type) => {
      if (typeof type !== "string") return this.fail("type", "expected a string or array of strings")
      return type
    })
    for (const [keyword, applicable] of Object.entries(typeScoped)) {
      if (keyword in input && !(types?.some((t) => applicable.includes(t)) ?? false)) {
        this.fail(keyword, `requires an explicit ${applicable.join("/")} type`)
      }
    }
    if ("unevaluatedProperties" in input && input.unevaluatedProperties !== true) this.fail("unevaluatedProperties")

    const parts: Array<Emitted> = []
    const base = this.base(input, types)
    if (base) parts.push(base)
    if (typeof input.$ref === "string") parts.push(this.ref(input.$ref))
    if (input.allOf !== undefined) for (const member of this.list(input.allOf, "allOf")) parts.push(this.node(member))
    if (input.anyOf !== undefined) parts.push(this.union(this.list(input.anyOf, "anyOf"), "anyOf"))
    if (input.oneOf !== undefined) parts.push(this.union(this.list(input.oneOf, "oneOf"), "oneOf"))

    let result: Emitted = { ts: "unknown", schema: "Schema.Unknown" }
    if (parts.length === 1) result = parts[0]!
    if (parts.length > 1) result = { ts: parts.map((p) => `(${p.ts})`).join(" & "), schema: `Wire.allOf(\n  ${parts.map((p) => indent(p.schema)).join(",\n  ")}\n)`, refined: true }
    if (input.not !== undefined) {
      const excluded = this.node(input.not)
      result = { ts: result.ts, schema: `Wire.not(\n  ${indent(result.schema)},\n  ${indent(excluded.schema)}\n)`, refined: true }
    }
    return result
  }

  list(u: unknown, keyword: string): ReadonlyArray<unknown> {
    if (!Array.isArray(u) || u.length === 0) return this.fail(keyword, "expected a non-empty array")
    return u
  }

  ref(ref: string): Emitted {
    const match = /^#\/\$defs\/([A-Za-z_][\w]*)$/.exec(ref)
    if (!match || !Object.hasOwn(this.definitions, match[1]!)) this.fail("$ref", ref)
    const name = match[1]!
    const definition = this.definitions[name]
    const unconstrained = isNode(definition) && Object.keys(definition).every((key) => annotationKeywords.has(key) || key.startsWith("x-"))
    return { ts: unconstrained ? "unknown" : name, schema: name }
  }

  union(members: ReadonlyArray<unknown>, mode: "anyOf" | "oneOf"): Emitted {
    const emitted = members.map((m) => this.node(m))
    if (emitted.length === 1) return emitted[0]!
    return {
      ts: unionType(emitted.map((e) => e.ts)),
      schema: `Schema.Union([\n  ${emitted.map((e) => indent(e.schema)).join(",\n  ")}\n]${mode === "oneOf" ? `, { mode: "oneOf" }` : ""})`,
      refined: emitted.some((e) => e.refined)
    }
  }

  base(input: Node, types: ReadonlyArray<string> | undefined): Emitted | undefined {
    if (input.const !== undefined || input.enum !== undefined) {
      const values = input.const !== undefined ? [input.const] : this.list(input.enum, "enum")
      for (const v of values) {
        if (v !== null && typeof v === "object") this.fail("const", "only primitive constants are supported")
        let constantType: string = typeof v
        if (v === null) constantType = "null"
        else if (Number.isInteger(v) && types?.includes("integer")) constantType = "integer"
        if (types && !types.includes(constantType)) {
          this.fail("const", `constant ${str(v)} contradicts type ${str(input.type)}`)
        }
      }
      return {
        ts: values.map(str).join(" | "),
        schema: values.length === 1 ? `Schema.Literal(${str(values[0])})` : `Schema.Literals([${values.map(str).join(", ")}])`
      }
    }
    if (!types) return undefined
    const branches = types.map((t) => this.typed(input, t))
    return branches.length === 1 ? branches[0] : {
      ts: branches.map((b) => b.ts).join(" | "),
      schema: `Schema.Union([${branches.map((b) => b.schema).join(", ")}])`,
      refined: branches.some((b) => b.refined)
    }
  }

  typed(input: Node, type: string): Emitted {
    switch (type) {
      case "null":
        return { ts: "null", schema: "Schema.Null" }
      case "boolean":
        return { ts: "boolean", schema: "Schema.Boolean" }
      case "string": {
        const checks = typeof input.pattern === "string" ? [`Schema.isPattern(new RegExp(${str(input.pattern)}, "u"))`] : []
        return { ts: "string", schema: withChecks("Schema.String", checks) }
      }
      case "integer":
      case "number": {
        const checks: Array<string> = []
        if (input.minimum !== undefined) checks.push(`Schema.isGreaterThanOrEqualTo(${this.number(input.minimum, "minimum")})`)
        if (input.maximum !== undefined) checks.push(`Schema.isLessThanOrEqualTo(${this.number(input.maximum, "maximum")})`)
        return { ts: "number", schema: withChecks(type === "integer" ? "Wire.integer" : "Schema.Finite", checks) }
      }
      case "array": {
        const item = input.items === undefined ? { ts: "unknown", schema: "Schema.Unknown" } : this.node(input.items)
        const checks = input.minItems !== undefined ? [`Schema.isMinLength(${this.number(input.minItems, "minItems")})`] : []
        return { ts: `ReadonlyArray<${item.ts}>`, schema: withChecks(`Schema.Array(${item.schema})`, checks), refined: item.refined }
      }
      case "object":
        return this.object(input)
      default:
        return this.fail("type", str(type))
    }
  }

  number(u: unknown, keyword: string): number {
    if (typeof u !== "number" || !Number.isFinite(u)) return this.fail(keyword, "expected a finite number")
    return u
  }

  object(input: Node): Emitted {
    const properties = input.properties ?? {}
    if (!isNode(properties)) return this.fail("properties", "expected an object")
    const requiredInput = input.required ?? []
    if (!Array.isArray(requiredInput)) return this.fail("required", "expected an array of strings")
    const required = new Set(requiredInput.map((key) => {
      if (typeof key !== "string") return this.fail("required", "expected a string")
      return key
    }))
    const keys = [...new Set([...Object.keys(properties), ...required])]
    const additional = input.additionalProperties
    if (additional !== undefined && additional !== true) {
      if (keys.length > 0) this.fail("additionalProperties", "a constrained additionalProperties alongside declared properties")
      const value = this.node(additional)
      return { ts: `{ readonly [key: string]: ${value.ts} }`, schema: `Wire.record(${value.schema})`, refined: value.refined }
    }
    if (keys.length === 0) return { ts: "{ readonly [key: string]: unknown }", schema: "Wire.object({})" }
    const fields = keys.map((key) => {
      const value = Object.hasOwn(properties, key) ? this.node(properties[key]) : { ts: "unknown", schema: "Schema.Unknown" }
      const optional = !required.has(key)
      return {
        ts: `${docComment(Object.hasOwn(properties, key) ? properties[key] : undefined)}readonly ${propertyKey(key)}${optional ? "?" : ""}: ${value.ts}`,
        schema: `${propertyKey(key)}: ${optional ? `Schema.optionalKey(${value.schema})` : value.schema}`,
        refined: value.refined
      }
    })
    return {
      ts: `{\n  ${fields.map((f) => indent(f.ts)).join("\n  ")}\n}`,
      schema: `Wire.object({\n  ${fields.map((f) => indent(f.schema)).join(",\n  ")}\n})`,
      refined: fields.some((f) => f.refined)
    }
  }
}

const withChecks = (schema: string, checks: ReadonlyArray<string>) =>
  checks.length === 0 ? schema : `${schema}.check(${checks.join(", ")})`

const docComment = (node: unknown, prefix = ""): string => {
  const description = isNode(node) && typeof node.description === "string" ? node.description.trim() : ""
  if (!description) return ""
  const body = description.replaceAll("*/", "*\\/").split("\n").map((l) => `${prefix} *${l ? ` ${l}` : ""}`).join("\n")
  return `/**\n${body}\n${prefix} */\n${prefix}`
}

const references = (value: unknown, refs = new Set<string>()): Set<string> => {
  if (Array.isArray(value)) {
    for (const item of value) references(item, refs)
  } else if (isNode(value)) {
    if (typeof value.$ref === "string") {
      const match = /^#\/\$defs\/([\w]+)$/.exec(value.$ref)
      if (match?.[1]) refs.add(match[1])
    }
    for (const item of Object.values(value)) references(item, refs)
  }
  return refs
}

/** Dependency order of definitions; alphabetical among independent ones. */
const orderDefinitions = (definitions: Readonly<Record<string, unknown>>): ReadonlyArray<string> => {
  const deps = new Map<string, Set<string>>()
  for (const name of Object.keys(definitions)) {
    deps.set(name, references(definitions[name]))
  }
  const ordered: Array<string> = []
  const state = new Map<string, "visiting" | "done">()
  const visit = (name: string, path: ReadonlyArray<string>) => {
    if (state.get(name) === "done") return
    if (state.get(name) === "visiting") throw new UnsupportedSchemaError(name, "$ref", `recursive reference ${[...path, name].join(" -> ")}`)
    state.set(name, "visiting")
    for (const dep of [...deps.get(name)!].sort()) {
      if (!deps.has(dep)) throw new UnsupportedSchemaError(name, "$ref", `unknown definition ${dep}`)
      visit(dep, [...path, name])
    }
    state.set(name, "done")
    ordered.push(name)
  }
  for (const name of Object.keys(definitions).sort()) visit(name, [])
  return ordered
}

interface MethodEntry {
  readonly method: string
  readonly side: "agent" | "client" | "protocol"
  params?: string
  result?: string
  kind?: "request" | "notification"
}

const envelopeRefs = (definitions: Readonly<Record<string, unknown>>, name: string): ReadonlySet<string> => {
  if (!Object.hasOwn(definitions, name)) throw new UnsupportedSchemaError(name, "$defs", "missing JSON-RPC envelope definition")
  const def = definitions[name]
  return references(def)
}

/** Derives method declarations from `x-method`/`x-side` plus the envelope unions. */
const collectMethods = (definitions: Readonly<Record<string, unknown>>): ReadonlyArray<MethodEntry> => {
  const requests = new Set([...envelopeRefs(definitions, "ClientRequest"), ...envelopeRefs(definitions, "AgentRequest")])
  const results = new Set([...envelopeRefs(definitions, "AgentResponse"), ...envelopeRefs(definitions, "ClientResponse")])
  const notifications = new Set([
    ...envelopeRefs(definitions, "ClientNotification"),
    ...envelopeRefs(definitions, "AgentNotification")
  ])
  const methods = new Map<string, MethodEntry>()
  for (const name of Object.keys(definitions).sort()) {
    const def = definitions[name]
    if (!isNode(def) || typeof def["x-method"] !== "string") continue
    const side = def["x-side"]
    if (side !== "agent" && side !== "client" && side !== "protocol") {
      throw new UnsupportedSchemaError(name, "x-side", str(side))
    }
    const key = `${side} ${def["x-method"]}`
    const entry = methods.get(key) ?? { method: def["x-method"], side }
    methods.set(key, entry)
    let role: "params" | "result" | "notification" | undefined
    if (requests.has(name)) role = "params"
    else if (results.has(name)) role = "result"
    else if (notifications.has(name) || side === "protocol") role = "notification"
    if (role === undefined) throw new UnsupportedSchemaError(name, "x-method", "not referenced by any JSON-RPC envelope")
    if (role === "result") {
      entry.result = name
    } else {
      if (entry.params) throw new UnsupportedSchemaError(name, "x-method", `duplicate params for ${entry.method}`)
      entry.params = name
      entry.kind = role === "params" ? "request" : "notification"
    }
  }
  for (const entry of methods.values()) {
    if (!entry.params || (entry.kind === "request") !== (entry.result !== undefined)) {
      throw new UnsupportedSchemaError(entry.params ?? entry.result ?? entry.method, "x-method", `incomplete method ${entry.method}`)
    }
  }
  return [...methods.values()]
}

export interface EmitOptions {
  readonly manifest: Pick<Manifest, "generator" | "upstream">
  readonly input: ManifestInput
  readonly overrides?: Overrides
}

const emitModuleUnsafe = (document: JsonSchemaDocument, options: EmitOptions): string => {
  const { input, manifest } = options
  const definitions = document.$defs
  const overrides = (options.overrides ?? defaultOverrides)[input.version] ?? {}
  for (const name of Object.keys(overrides)) {
    if (!Object.hasOwn(definitions, name)) throw new UnknownOverrideError(name, input.version)
  }
  const out: Array<string> = []
  out.push(
    `/**`,
    ` * ACP v${input.version} ${input.surface} wire schemas and method declarations.`,
    ` *`,
    ` * GENERATED by scripts/codegen/generate.ts from ${input.path}. Do not edit;`,
    ` * run \`bun run generate\` after updating scripts/codegen/manifest.json.`,
    ` */`,
    `import * as Schema from "effect/Schema"`,
    `import * as AcpSchema from "../../AcpSchema.ts"`,
    `import * as Wire from "../../internal/wire.ts"`,
    ``,
    `/** Protocol version described by this module. */`,
    `export const version = ${input.version} as const`,
    ``,
    `/** Upstream inputs this module was generated from. */`,
    `export const provenance = {`,
    `  version: ${input.version},`,
    `  surface: ${str(input.surface)},`,
    `  source: ${str(input.path)},`,
    `  sha256: ${str(input.sha256)},`,
    `  repository: ${str(manifest.upstream.repository)},`,
    `  revision: ${str(manifest.upstream.revision)},`,
    `  generator: ${str(manifest.generator)}`,
    `} as const`
  )
  for (const name of orderDefinitions(definitions)) {
    if (reserved.has(name)) throw new UnsupportedSchemaError(name, "$defs", "definition name collides with a generated export")
    const override = Object.hasOwn(overrides, name) ? overrides[name] : undefined
    const emitted = override ?? new Emitter(definitions, name).node(definitions[name])
    const doc = docComment(definitions[name])
    out.push(
      ``,
      override ? `// Reviewed override: ${override.reason.replaceAll("\n", " ")}` : "",
      `${doc}export type ${name} = ${emitted.ts}`,
      `export const ${name} = Wire.${"refined" in emitted && emitted.refined ? "refinedDef" : "def"}<${name}>(${str(name)}, ${emitted.schema})`
    )
  }
  const methods = collectMethods(definitions)
  for (const side of ["agent", "client", "protocol"] as const) {
    const handledBy = side === "protocol" ? "either peer" : `the ${side}`
    out.push(``, `/** Methods handled by ${handledBy}. */`, `export const ${side}Methods = {`)
    const entries = methods.filter((m) => m.side === side).sort((a, b) => a.method.localeCompare(b.method))
    out.push(
      entries.map((m) =>
        m.kind === "request"
          ? `  ${methodKey(m.method)}: AcpSchema.request(${str(m.method)}, ${m.params}, ${m.result})`
          : `  ${methodKey(m.method)}: AcpSchema.notification(${str(m.method)}, ${m.params})`
      ).join(",\n"),
      `} as const`
    )
  }
  return out.filter((line, i, all) => !(line === "" && all[i - 1] === "")).join("\n") + "\n"
}

/** Emits one pinned schema module, returning expected diagnostics as failures. */
export const emitModule = (document: JsonSchemaDocument, options: EmitOptions): Result.Result<string, EmitError> => {
  try {
    return Result.succeed(emitModuleUnsafe(document, options))
  } catch (error) {
    if (error instanceof UnsupportedSchemaError || error instanceof UnknownOverrideError) return Result.fail(error)
    throw error
  }
}

/** Collapse primitives that already include literal members; preserve runtime union validation. */
const unionType = (members: ReadonlyArray<string>): string => {
  if (members.includes("unknown")) return "unknown"
  const broadString = members.includes("string")
  const broadNumber = members.includes("number")
  const retained = [...new Set(members)].filter((member) => {
    if (broadString && /^"(?:[^"\\]|\\.)*"$/.test(member)) return false
    if (broadNumber && /^-?\d+(?:\.\d+)?$/.test(member)) return false
    return true
  })
  return retained.map((member) => `(${member})`).join(" | ")
}
