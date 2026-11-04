/**
 * The Matter fabrics as `integration-instances` (planning#408 P3): one instance per `brokers`
 * record, over the SAME records and ids (`matter_NNN`) the `broker` cap serves. The body is flat.
 * A fabric needs no sign-in; commissioning a device stays on the adoption flow, behind the fabric.
 */
import {
  type IntegrationInstanceStatus,
  type IntegrationTestConnectionResult,
  type RecordsAccess,
  RecordIntegrationInstances,
} from '@camstack/types'
import { matterBrokersEntryKind, type MatterBrokerBody } from './broker-record-kinds.js'
import { buildConnectionFormSchema } from './config.js'
import type { MatterBrokerInfo } from './matter-integration-manager.js'

export const MATTER_INSTANCE_KIND = 'matter'

export interface MatterInstancesDeps {
  readonly mintId: () => string
  readonly infoOf: (id: string) => MatterBrokerInfo | null
  /** Bring the runtime in line with the records after a change. */
  readonly onChanged: (id: string) => Promise<void>
}

function statusOf(info: MatterBrokerInfo | null): IntegrationInstanceStatus {
  if (info === null) return { state: 'unknown', label: 'Not started' }
  if (info.status === 'connected') return { state: 'ok', label: 'Running' }
  if (info.status === 'connecting') return { state: 'unknown', label: 'Starting' }
  return {
    state: 'error',
    label: info.status,
    ...(info.error !== null ? { detail: info.error } : {}),
  }
}

export function buildMatterInstances(
  records: Pick<RecordsAccess, 'kind' | 'owner'>,
  deps: MatterInstancesDeps,
): RecordIntegrationInstances<MatterBrokerBody> {
  return new RecordIntegrationInstances<MatterBrokerBody>(records, matterBrokersEntryKind, {
    description: {
      role: 'both',
      instanceMode: 'multiple',
      kind: 'connection',
      canTest: true,
      kinds: [{ id: MATTER_INSTANCE_KIND, label: 'Matter' }],
      allowRestoreId: true,
    },
    formSchema: () => buildConnectionFormSchema(),
    initialBody: (name): MatterBrokerBody => ({
      name,
      threadDataset: '',
      wifiSsid: '',
      wifiPassword: '',
      reconcileIntervalMs: 300_000,
    }),
    mintId: () => deps.mintId(),
    kindOf: () => MATTER_INSTANCE_KIND,
    health: (_body, id) => {
      const info = deps.infoOf(id)
      return {
        status: statusOf(info),
        ...(info?.lastCheckedAt != null ? { lastCheckedAt: info.lastCheckedAt } : {}),
      }
    },
    configured: () => true,
    onChanged: deps.onChanged,
    test: async ({ id }): Promise<IntegrationTestConnectionResult> => {
      const info = id === null ? null : deps.infoOf(id)
      if (info === null) {
        return {
          success: false,
          status: 'inconclusive',
          error: 'Not started: save the fabric first',
        }
      }
      return info.status === 'connected'
        ? { success: true, status: 'validated' }
        : { success: false, status: 'rejected', error: info.error ?? `status: ${info.status}` }
    },
  })
}
