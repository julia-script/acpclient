import { describe, expect, it } from "tstyche"
import type { NewSessionOptions, ResumeSessionOptions } from "../src/AcpClient.ts"

describe("client option compatibility", () => {
  it("continues to accept explicit undefined on public new and resume options", () => {
    const options = { cwd: "/work", additionalDirectories: undefined, mcpServers: undefined }
    expect(options).type.toBeAssignableTo<NewSessionOptions>()
    expect({ ...options, sessionId: "session-1" }).type.toBeAssignableTo<ResumeSessionOptions>()
  })
})
