import { describe, expect, test } from "bun:test"
import * as Effect from "effect/Effect"
import * as GatewayClient from "../src/AcpGatewayClient.ts"

describe("gateway memory storage", () => {
  test("a value that cannot be cloned fails in the typed channel without changing stored state", () =>
    Effect.runPromise(Effect.gen(function*() {
      const storage = GatewayClient.memoryStorage()
      yield* storage.save("identity", { value: "original" })
      const failure = yield* Effect.flip(storage.save("identity", { callback: () => undefined }))
      expect(failure).toMatchObject({ _tag: "AcpGatewayError", code: "Invalid" })
      expect(failure.message).toContain("identity")
      expect(yield* storage.load("identity")).toEqual({ value: "original" })
    })))
})
