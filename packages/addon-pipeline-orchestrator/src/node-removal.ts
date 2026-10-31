/**
 * The pipeline orchestrator's side of `node-removal-hook` (#265).
 *
 * It owns four things keyed on a node: the per-node pipeline settings, the
 * per-node capability bindings, the automatic-benchmark retry ledger, and the
 * node pins written into each camera's device store (`pipelineNodeId`,
 * `pipelineDeviceKey`, `preferredAgent`, `audioNodeId`).
 *
 * The first three only mean something on that node: they are REMOVED. A camera
 * pin merely MENTIONS the node as a preference: it is re-pointed to "unset"
 * (`'auto'` / `null`) — the camera stays and is balanced like any other.
 *
 * Idempotent. A failed read throws so the hub retries; nothing is ever deleted
 * from an unanswered read (D49). The hub is never forgotten.
 */
import type { INodeRemovalHookProvider, IScopedLogger } from '@camstack/types'
import { PREFERRED_AGENT_SETTING } from './placement-service.js'
import { AUDIO_NODE_SETTING } from './audio-subscription-controller.js'

const PIPELINE_NODE_SETTING = 'pipelineNodeId'
const PIPELINE_DEVICE_SETTING = 'pipelineDeviceKey'
const HUB_NODE_ID = 'hub'

export interface NodeRemovalDeps {
  /** The addon's own `removeAgentSettings` (also refreshes the derived node sets). */
  readonly removeAgentSettings: (nodeId: string) => Promise<boolean>
  readonly removeCapabilityBindings: (nodeId: string) => Promise<boolean>
  readonly removeAutoBenchmarkAttempts: (nodeId: string) => Promise<boolean>
  /** Rejects when the camera list cannot be read. */
  readonly listCameraDeviceIds: () => Promise<readonly number[]>
  readonly readDeviceStore: (deviceId: number) => Promise<Readonly<Record<string, unknown>>>
  readonly writeDeviceStore: (deviceId: number, patch: Record<string, unknown>) => Promise<void>
  readonly logger: IScopedLogger
}

/** The patch that un-pins a camera from `nodeId`; `null` when it names another node. */
function unpinPatch(
  store: Readonly<Record<string, unknown>>,
  nodeId: string,
): Record<string, unknown> | null {
  const patch: Record<string, unknown> = {}
  if (store[PIPELINE_NODE_SETTING] === nodeId) {
    patch[PIPELINE_NODE_SETTING] = 'auto'
    // A device key names a device OF the pinned node.
    if (typeof store[PIPELINE_DEVICE_SETTING] === 'string') patch[PIPELINE_DEVICE_SETTING] = 'auto'
  }
  if (store[PREFERRED_AGENT_SETTING] === nodeId) patch[PREFERRED_AGENT_SETTING] = null
  if (store[AUDIO_NODE_SETTING] === nodeId) patch[AUDIO_NODE_SETTING] = 'auto'
  return Object.keys(patch).length > 0 ? patch : null
}

export function createNodeRemovalHook(deps: NodeRemovalDeps): INodeRemovalHookProvider {
  const { logger } = deps
  return {
    onNodeRemoved: async ({ nodeId }) => {
      if (nodeId === HUB_NODE_ID) {
        logger.warn('refused to clear node-scoped data of the hub', { tags: { nodeId } })
        return {
          counts: {
            'agent-settings': 0,
            'node-bindings': 0,
            'auto-benchmark-attempts': 0,
            'camera-node-pins': 0,
          },
        }
      }
      const agentSettings = (await deps.removeAgentSettings(nodeId)) ? 1 : 0
      const nodeBindings = (await deps.removeCapabilityBindings(nodeId)) ? 1 : 0
      const attempts = (await deps.removeAutoBenchmarkAttempts(nodeId)) ? 1 : 0

      let pins = 0
      for (const deviceId of await deps.listCameraDeviceIds()) {
        const patch = unpinPatch(await deps.readDeviceStore(deviceId), nodeId)
        if (patch === null) continue
        await deps.writeDeviceStore(deviceId, patch)
        pins += 1
        logger.info('re-pointed a camera node pin to auto: its node was forgotten', {
          tags: { deviceId, nodeId },
          meta: { cleared: Object.keys(patch) },
        })
      }
      logger.info('cleared node-scoped pipeline data of a forgotten node', {
        tags: { nodeId },
        meta: { agentSettings, nodeBindings, attempts, pins },
      })
      return {
        counts: {
          'agent-settings': agentSettings,
          'node-bindings': nodeBindings,
          'auto-benchmark-attempts': attempts,
          'camera-node-pins': pins,
        },
      }
    },
  }
}
