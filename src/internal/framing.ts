/**
 * Incremental UTF-8 newline framing for ACP stdio.
 *
 * Splitting on the `\n` byte is safe for UTF-8: it never occurs inside a
 * multibyte sequence, so frames are decoded only once complete.
 *
 * @internal
 */
import { AcpTransportError } from "../AcpError.ts"

export interface Decoded {
  readonly frames: ReadonlyArray<string>
  /** Set when the stream cannot continue; `frames` precede it. */
  readonly error?: AcpTransportError | undefined
}

export const makeDecoder = (maxFrameBytes: number) => {
  const utf8 = new TextDecoder("utf-8", { fatal: true })
  let buffered: Array<Uint8Array> = []
  let bufferedBytes = 0

  const tooLarge = () =>
    new AcpTransportError({ reason: "FrameTooLarge", message: `Frame exceeds ${maxFrameBytes} bytes` })

  const complete = (tail: Uint8Array): string | AcpTransportError | undefined => {
    const bytes = new Uint8Array(bufferedBytes + tail.length)
    let offset = 0
    for (const part of buffered) {
      bytes.set(part, offset)
      offset += part.length
    }
    bytes.set(tail, offset)
    buffered = []
    bufferedBytes = 0
    let text: string
    try {
      text = utf8.decode(bytes)
    } catch (cause) {
      return new AcpTransportError({ reason: "InvalidFrame", message: "Frame is not valid UTF-8", cause })
    }
    if (text.endsWith("\r")) text = text.slice(0, -1)
    return text.trim() === "" ? undefined : text
  }

  return {
    push(chunk: Uint8Array): Decoded {
      const frames: Array<string> = []
      let start = 0
      for (let newline = chunk.indexOf(10); newline !== -1; newline = chunk.indexOf(10, start)) {
        const part = chunk.subarray(start, newline)
        start = newline + 1
        if (bufferedBytes + part.length > maxFrameBytes) return { frames, error: tooLarge() }
        const frame = complete(part)
        if (frame instanceof AcpTransportError) return { frames, error: frame }
        if (frame !== undefined) frames.push(frame)
      }
      const rest = chunk.subarray(start)
      if (bufferedBytes + rest.length > maxFrameBytes) return { frames, error: tooLarge() }
      if (rest.length > 0) {
        buffered.push(rest.slice())
        bufferedBytes += rest.length
      }
      return { frames }
    },
    /** Call at end of input: an unterminated frame is an error. */
    end(): AcpTransportError | undefined {
      return bufferedBytes === 0 ? undefined : new AcpTransportError({
        reason: "InvalidFrame",
        message: `Stream ended inside an unterminated ${bufferedBytes}-byte frame`
      })
    }
  }
}

const utf8Encoder = new TextEncoder()

/** Encodes one frame plus its delimiter. Frames must not contain newlines. */
export const encode = (frame: string, maxFrameBytes: number): Uint8Array | AcpTransportError => {
  if (frame.includes("\n")) {
    return new AcpTransportError({ reason: "InvalidFrame", message: "Frame contains an embedded newline" })
  }
  const bytes = utf8Encoder.encode(frame + "\n")
  return bytes.length - 1 > maxFrameBytes
    ? new AcpTransportError({ reason: "FrameTooLarge", message: `Frame exceeds ${maxFrameBytes} bytes` })
    : bytes
}
