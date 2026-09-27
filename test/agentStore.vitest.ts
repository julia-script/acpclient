import { expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Store from "../src/agent/Store.ts"

it.effect("lists opaque session IDs in stable lexical order, including when filtered", () =>
  Effect.gen(function*() {
    const store = yield* Store.Store
    yield* store.create({ sessionId: "a", cwd: "/one" })
    yield* store.create({ sessionId: "z", cwd: "/two" })
    yield* store.create({ sessionId: "B", cwd: "/one" })
    const all = (yield* store.list()).map((session) => session.sessionId)
    const filtered = (yield* store.list("/one")).map((session) => session.sessionId)
    expect({ all, filtered }).toEqual({ all: ["B", "a", "z"], filtered: ["B", "a"] })
  }).pipe(Effect.provide(Store.layer)))
