/**
 * Browser import smoke check: bundles every package entry point for the
 * browser, refusing any Node/Bun or platform-package import, then evaluates
 * each bundle in a sandbox exposing only web globals.
 */
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import * as Data from "effect/Data"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as BunServices from "@effect/platform-bun/BunServices"
import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import * as vm from "node:vm"
import pkg from "../package.json"

const forbidden = /^(node:|bun$|bun:|fs$|path$|os$|child_process$|crypto$|stream$|net$|@effect\/platform-)/

const guard: Bun.BunPlugin = {
  name: "forbid-runtime-imports",
  setup(build) {
    build.onResolve({ filter: forbidden }, (args) => {
      throw new Error(`browser entry imports ${args.path} (from ${args.importer})`)
    })
  }
}

const sandboxGlobals = () => ({
  console,
  TextEncoder,
  TextDecoder,
  URL,
  AbortController,
  queueMicrotask,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  structuredClone,
  crypto: globalThis.crypto
})

class BrowserBuildFailure extends Data.TaggedError("BrowserBuildFailure")<{
  readonly message: string
}> {}

class BrowserEvaluationFailure extends Data.TaggedError("BrowserEvaluationFailure")<{
  readonly message: string
}> {}

class BrowserCheckFailure extends Data.TaggedError("BrowserCheckFailure")<{
  readonly issues: ReadonlyArray<string>
  readonly message: string
}> {
  constructor(issues: ReadonlyArray<string>) {
    super({ issues, message: issues.join("\n") })
  }
}

const build = (entry: string) => Effect.tryPromise({
  try: () => Bun.build({ entrypoints: [entry], target: "browser", format: "iife", plugins: [guard] }),
  catch: (cause) => new BrowserBuildFailure({
    message: cause instanceof AggregateError ? cause.errors.map(String).join("\n") : String(cause)
  })
}).pipe(Effect.filterOrFail(
  (result) => result.success,
  (result) => new BrowserBuildFailure({ message: result.logs.map(String).join("\n") })
))

const program = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const dir = yield* fs.makeTempDirectoryScoped({ prefix: "acp-browser-" })
  const root = path.resolve(import.meta.dir, "..")

  // The guard itself must reject a process import.
  const probe = path.join(dir, "probe.ts")
  yield* fs.writeFileString(probe, `import "@effect/platform-bun/BunChildProcessSpawner"\n`)
  if (Result.isSuccess(yield* Effect.result(build(probe)))) {
    return yield* new BrowserCheckFailure(["import guard did not reject a platform import"])
  }

  const sourceExports = Object.fromEntries(Object.entries(pkg.exports).map(([name, target]) => [
    name, target.replace("./dist/", "./src/").replace(/\.js$/, ".ts")
  ]))
  const issues: Array<string> = []
  for (const [surface, exports] of Object.entries({ source: sourceExports, dist: pkg.exports })) {
    for (const [name, target] of Object.entries(exports)) {
      const entry = path.join(dir, `${surface}_${name.replaceAll(/[^\w]/g, "_") || "root"}.ts`)
      const importPath = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.String))(path.join(root, target))
      yield* fs.writeFileString(entry, `import * as M from ${importPath}\nglobalThis.__exports = Object.keys(M)\n`)
      const result = yield* Effect.result(build(entry))
      if (Result.isFailure(result)) {
        issues.push(`✗ ${surface} ${name}: ${result.failure.message}`)
        continue
      }
      const evaluated = yield* Effect.result(Effect.gen(function*() {
        const context = yield* Effect.try({
          try: () => vm.createContext(sandboxGlobals()),
          catch: (cause) => new BrowserEvaluationFailure({ message: String(cause) })
        })
        const output = result.success.outputs[0]
        if (output === undefined) return yield* new BrowserEvaluationFailure({ message: "build produced no output" })
        const source = yield* Effect.tryPromise({
          try: () => output.text(),
          catch: (cause) => new BrowserEvaluationFailure({ message: String(cause) })
        })
        yield* Effect.try({
          try: () => vm.runInContext(source, context),
          catch: (cause) => new BrowserEvaluationFailure({ message: String(cause) })
        })
        return yield* Schema.decodeUnknownEffect(Schema.Array(Schema.String))(context.__exports).pipe(
          Effect.mapError((cause) => new BrowserEvaluationFailure({ message: String(cause) }))
        )
      }))
      if (Result.isFailure(evaluated)) {
        issues.push(`✗ ${surface} ${name}: evaluation failed: ${evaluated.failure.message}`)
      } else {
        yield* Effect.log(`✓ ${surface} ${name} (${evaluated.success.length} exports)`)
      }
    }
  }
  if (issues.length > 0) return yield* new BrowserCheckFailure(issues)
})

if (import.meta.main) {
  BunRuntime.runMain(program.pipe(Effect.scoped, Effect.provide(BunServices.layer)))
}
