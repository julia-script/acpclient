import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import type { AcpAgentConnection } from "effect-acp/AcpClient"
import type { Service } from "effect-acp/AcpConnection"
import * as AcpSchema from "effect-acp/AcpSchema"

// An application extension: this method must also exist on your agent.
export const ProjectInfo = AcpSchema.request(
  "_my_app/project_info",
  Schema.Struct({ sessionId: Schema.String }),
  Schema.Struct({ name: Schema.String, languages: Schema.Array(Schema.String) })
)

export const readFromPeer = (peer: Service, sessionId: string) =>
  peer.request(ProjectInfo, { sessionId })

// The high-level connection has a raw extension escape hatch. Decode its
// untrusted result at this boundary, keeping validation in the error channel.
export const readFromSessionClient = (connection: AcpAgentConnection, sessionId: string) =>
  connection.request(ProjectInfo.method, { sessionId }).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(ProjectInfo.result))
  )
