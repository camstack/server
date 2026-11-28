import { errMsg, type IBrokerProvider, type IScopedLogger } from '@dominevo/types'
import { publicMatterConnection } from './config.js'
import type { MatterBrokerEntry } from './config.js'
import type { MatterBrokerRegistry } from './matter-broker-registry.js'
import { parsePairingCode } from './matter-commissioning.js'

export interface MatterBrokerProviderDeps {
  readonly registry: Pick<
    MatterBrokerRegistry,
    'size' | 'connectedCount' | 'commissionNode' | 'getCommissionProgress'
  >
  readonly getBrokers: () => readonly MatterBrokerEntry[]
  readonly logger: IScopedLogger
}

/**
 * Construct the `broker` cap provider for the Matter addon: the bus only (D1013). The fabrics
 * themselves are the `account` kind of the addon's `integration-instances` provider. The defining
 * Matter operation, commissioning, is surfaced through `publish` with
 * `target: { action: 'commissionNode' }` and `payload: { pairingCode }`. `threadDataset` and
 * `wifiPassword` are redacted on config reads. Fabric keys stay in matter.js storage.
 */
export function buildMatterBrokerProvider(deps: MatterBrokerProviderDeps): IBrokerProvider {
  const { registry, getBrokers, logger } = deps

  const owns = (id: string): boolean => getBrokers().some((b) => b.id === id)

  const redact = (entry: MatterBrokerEntry): Record<string, unknown> =>
    publicMatterConnection(entry.connection)

  return {
    getBrokerConfig: async ({ id }) => {
      const entry = getBrokers().find((b) => b.id === id)
      return entry ? redact(entry) : null
    },

    /**
     * `publish` is the commissioning + control action channel.
     * `target: { action: 'commissionNode' }`, `payload: { pairingCode }` →
     * runs the controller's `commissionNode`. Other actions are a TODO.
     */
    publish: async ({ brokerId, target, payload }) => {
      if (!owns(brokerId)) {
        logger.warn('matter publish refused: this addon does not own that broker', {
          tags: { brokerId },
          meta: { reason: 'unknown-broker' },
        })
        throw new Error(`matter: unknown broker ${brokerId}`)
      }
      const action = typeof target['action'] === 'string' ? target['action'] : undefined
      if (action === 'commissionNode') {
        const code = pairingCodeFromPayload(payload)
        // Fail fast on a malformed code before touching the controller.
        try {
          parsePairingCode(code)
        } catch (err: unknown) {
          logger.warn('matter publish refused: the pairing code does not parse', {
            tags: { brokerId },
            meta: { reason: 'invalid-pairing-code', error: errMsg(err) },
          })
          throw err
        }
        return registry.commissionNode(brokerId, code)
      }
      logger.warn('matter publish refused: unsupported action', {
        tags: { brokerId },
        meta: { reason: 'unsupported-action', action: action ?? '(none)' },
      })
      throw new Error(`matter: unsupported publish action '${action ?? '(none)'}'`)
    },

    // ── Pub/sub: attribute reports flow over the event bus as broker.message ──
    subscribe: async () => ({ subscriptionId: '' }),
    unsubscribe: async () => undefined,
    getState: async ({ brokerId, key }) => {
      if (key !== 'commission') return null
      return registry.getCommissionProgress(brokerId)
    },

    getStatus: async () => ({
      brokerCount: registry.size(),
      connectedCount: registry.connectedCount(),
    }),
  }
}

function pairingCodeFromPayload(payload: unknown): string {
  if (typeof payload !== 'object' || payload === null || !('pairingCode' in payload)) return ''
  const code = payload.pairingCode
  if (typeof code === 'string') return code
  if (typeof code === 'number' && Number.isFinite(code)) return String(code)
  return ''
}
