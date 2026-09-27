import { expect, it } from "@effect/vitest"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import { SubmissionSnapshot } from "../src/AcpApp.ts"
import { AcpTimeoutError } from "../src/AcpError.ts"
import { RequestId } from "../src/AcpSchema.ts"

it("request ID codecs agree at snapshot and timeout boundaries", () => {
  const submission = {
    id: "submission-1", prompt: [], status: { _tag: "pending" },
    requestId: 1.25, agentMessageId: null, acceptanceUnavailable: false, foreground: "inferred"
  }
  const timeout = { _tag: "AcpTimeoutError", method: "test/request", requestId: 1.25 }
  expect(Result.isFailure(Schema.decodeResult(RequestId)(1.25))).toBe(true)
  expect(Result.isFailure(Schema.decodeUnknownResult(SubmissionSnapshot)(submission))).toBe(true)
  expect(Result.isFailure(Schema.decodeUnknownResult(AcpTimeoutError)(timeout))).toBe(true)

  for (const id of ["request-1", 4, null]) {
    expect(Result.isSuccess(Schema.decodeResult(RequestId)(id))).toBe(true)
    expect(Result.isSuccess(Schema.decodeUnknownResult(SubmissionSnapshot)({ ...submission, requestId: id }))).toBe(true)
    expect(Result.isSuccess(Schema.decodeUnknownResult(AcpTimeoutError)({ ...timeout, requestId: id }))).toBe(true)
  }
})
