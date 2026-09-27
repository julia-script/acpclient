/** Keep published-package documentation examples typecheckable and in sync. */
import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import * as BunServices from "@effect/platform-bun/BunServices"
import * as Console from "effect/Console"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import * as Schema from "effect/Schema"

class DocumentationError extends Schema.TaggedError<DocumentationError>()("DocumentationError", {
  message: Schema.String
}) {}
class UriDecodeFailure extends Schema.TaggedError<UriDecodeFailure>()("UriDecodeFailure", {
  cause: Schema.Defect()
}) {}

const program = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const root = path.resolve(import.meta.dir, "..")
  const files = [path.join(root, "README.md")]
  const directories = [path.join(root, "docs")]
  while (directories.length > 0) {
    const directory = directories.pop()
    if (directory === undefined) break
    for (const name of yield* fs.readDirectory(directory)) {
      const file = path.join(directory, name)
      const stat = yield* fs.stat(file)
      if (stat.type === "Directory") directories.push(file)
      else if (name.endsWith(".md")) files.push(file)
    }
  }
  let examples = 0
  const issues: Array<string> = []
  for (const file of files) {
    const content = yield* fs.readFileString(file)
    const label = path.relative(root, file)
    const blocks = [...content.matchAll(/```(?:ts|typescript)\n([\s\S]*?)\n```/g)]
    for (const block of blocks) {
      const prefix = content.slice(0, block.index)
      const marker = /<!-- example: ([^\n]+) -->\n$/.exec(prefix)?.[1]
      if (marker === undefined) {
        issues.push(`${label}: TypeScript block has no source example marker`)
        continue
      }
      const sourcePath = path.resolve(path.dirname(file), marker)
      if (!(yield* fs.exists(sourcePath))) {
        issues.push(`${label}: missing example ${marker}`)
        continue
      }
      const source = yield* fs.readFileString(sourcePath)
      if (source.trimEnd() !== block[1]) issues.push(`${label}: example differs from ${marker}`)
      examples++
    }
    // Only prose links, not string literals or example program contents.
    const prose = content.replace(/```[\s\S]*?```/g, "")
    for (const link of prose.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      const target = link[1]
      if (target === undefined || /^(?:[a-z]+:|\/\/)/i.test(target)) continue
      const [pathname = "", fragment] = target.split("#")
      const decodedPathname = yield* Effect.try({
        try: () => decodeURI(pathname),
        catch: (cause) => new UriDecodeFailure({ cause })
      }).pipe(Effect.catch((failure) =>
        failure.cause instanceof URIError ? Effect.succeed(failure.cause) : Effect.die(failure.cause)))
      if (decodedPathname instanceof URIError) {
        issues.push(`${label}: invalid link URI ${target}`)
        continue
      }
      const destination = pathname === "" ? file : path.resolve(path.dirname(file), decodedPathname)
      if (!(yield* fs.exists(destination))) {
        issues.push(`${label}: broken link ${target}`)
      } else if (fragment && destination.endsWith(".md")) {
        const linked = yield* fs.readFileString(destination)
        const headings = [...linked.matchAll(/^#{1,6} (.+)$/gm)].map((match) =>
          (match[1] ?? "").toLowerCase().replace(/[^\p{L}\p{N}_\- ]/gu, "").replaceAll(" ", "-")
        )
        if (!headings.includes(fragment)) issues.push(`${label}: missing heading ${target}`)
      }
    }
  }
  if (issues.length > 0) return yield* new DocumentationError({ message: issues.join("\n") })
  yield* Console.log(`Checked ${files.length} documentation pages and ${examples} embedded TypeScript examples`)
})

BunRuntime.runMain(program.pipe(Effect.provide(BunServices.layer)))
