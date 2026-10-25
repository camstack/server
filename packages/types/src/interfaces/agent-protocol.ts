/**
 * Agent-protocol types.
 *
 * Historical shim: this file used to carry a bespoke WebSocket wire
 * protocol between the hub and remote agents (HubToAgentMessage /
 * AgentToHubMessage unions plus supporting `AgentRegistrationInfo`,
 * `AgentRuntimeStatus`, `RecordingSegmentInfo`, `DetectionResult`,
 * `BINARY_FRAME_*` constants). That wire protocol was replaced by the
 * Moleculer-based cluster transport — all of the wire types became
 * orphan declarations with zero imports across packages/ + server/.
 *
 * They were removed on 2026-04-14. The only types that survived here
 * are `AgentCapability`, `RolePriority` and `CameraRoleAssignment`,
 * which are still consumed by `server/backend/src/core/agent/
 * agent-registry.service.ts` to track camera→agent role bindings.
 */

// --- Agent capabilities & roles ---
export type AgentCapability = 'decoder' | 'transcoder' | 'detector' | 'recorder'
export type RolePriority = 'primary' | 'backup' | 'overflow'

export interface CameraRoleAssignment {
  cameraId: number
  role: AgentCapability
  agentId: string
  priority: RolePriority
  rtspUrl?: string
  detectionConfig?: {
    modelId: string
    runtime: string
    confidence: number
    fps: number
    classes?: string[]
  }
}
