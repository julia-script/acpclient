/** Assert failure without moving an untyped response into the Effect error channel. */
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Option from "effect/Option"

export const failure = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<E, never, R> =>
  Effect.flatMap(Effect.exit(effect), (exit) => {
    if (Exit.isSuccess(exit)) return Effect.die("Expected the effect to fail")
    const error = Cause.findErrorOption(exit.cause)
    return Option.isSome(error) ? Effect.succeed(error.value) : Effect.die(Cause.squash(exit.cause))
  })
