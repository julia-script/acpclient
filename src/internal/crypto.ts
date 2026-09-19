/** Browser-safe default cryptography; applications can override the Effect service. */
import * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as PlatformError from "effect/PlatformError"

const web = Crypto.make({
  randomBytes: (size) => globalThis.crypto.getRandomValues(new Uint8Array(size)),
  digest: (algorithm, data) => Effect.tryPromise({
    try: () => globalThis.crypto.subtle.digest(algorithm, new Uint8Array(data)).then((buffer) => new Uint8Array(buffer)),
    catch: (cause) => PlatformError.systemError({ module: "Crypto", method: "digest", _tag: "Unknown", cause })
  })
})

export const randomUUID = Effect.flatMap(Effect.serviceOption(Crypto.Crypto), (service) =>
  Option.getOrElse(service, () => web).randomUUIDv4)
