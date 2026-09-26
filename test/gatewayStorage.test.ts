import { describe, expect, test } from "bun:test"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Result from "effect/Result"
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

  test("a throwing getter remains a defect and does not replace the saved value", () =>
    Effect.runPromise(Effect.gen(function*() {
      const storage = GatewayClient.memoryStorage()
      yield* storage.save("identity", { value: "original" })
      const defect = new Error("getter bug")
      const value = { get data(): string { throw defect } }

      const exit = yield* Effect.exit(storage.save("identity", value))
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isSuccess(exit)) throw new Error("Expected a getter defect")
      expect(Result.isFailure(Cause.findError(exit.cause))).toBe(true)
      const found = Cause.findDefect(exit.cause)
      expect(Result.isSuccess(found)).toBe(true)
      if (Result.isSuccess(found)) expect(found.success).toBe(defect)
      expect(yield* storage.load("identity")).toEqual({ value: "original" })
    })))
})
