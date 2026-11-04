/**
 * The Home Assistant connections as `integration-instances` (planning#408 P3): one instance per
 * `brokers` record, over the SAME records and ids (`ha_NNN`) the `broker` cap serves. The body is
 * flat, so the form the instances page edits is the stored shape.
 */
import {
  type IntegrationInstanceStatus,
  type IntegrationTestConnectionResult,
  type RecordsAccess,
  RecordIntegrationInstances,
  REDACTED_SECRET,
} from '@camstack/types'
import { type HaBrokerBody, haBrokersEntryKind } from './broker-record-kinds.js'
import { haBrokerSettingsSchema } from './ha-broker-settings-schema.js'
import type { HaBrokerInfo } from './ha-integration-manager.js'

export const HA_INSTANCE_KIND = 'home-assistant'

export interface HaInstancesDeps {
  readonly mintId: () => string
  /** The runtime's view of one broker; null while it has no manager. */
  readonly infoOf: (id: string) => HaBrokerInfo | null
  /** Bring the runtime in line with the records after a change. */
  readonly onChanged: (id: string) => Promise<void>
  /** Throwaway handshake with the typed settings. */
  readonly probe: (
    settings: Readonly<Record<string, unknown>>,
  ) => Promise<{ readonly ok: boolean; readonly error?: string; readonly latencyMs?: number }>
}

export function isHaBodyConfigured(body: HaBrokerBody): boolean {
  return body.authKind === 'supervisor'
    ? (body.supervisorToken ?? '').length > 0
    : (body.baseUrl ?? '').length > 0 && (body.accessToken ?? '').length > 0
}

function statusOf(info: HaBrokerInfo | null): IntegrationInstanceStatus {
  if (info === null) return { state: 'unknown', label: 'Not connected' }
  if (info.status === 'connected') return { state: 'ok', label: 'Connected' }
  if (info.status === 'connecting') return { state: 'unknown', label: 'Connecting' }
  return {
    state: 'error',
    label: info.status,
    ...(info.error !== null ? { detail: info.error } : {}),
  }
}

export function buildHaInstances(
  records: Pick<RecordsAccess, 'kind' | 'owner'>,
  deps: HaInstancesDeps,
): RecordIntegrationInstances<HaBrokerBody> {
  return new RecordIntegrationInstances<HaBrokerBody>(records, haBrokersEntryKind, {
    description: {
      instanceMode: 'multiple',
      kind: 'connection',
      canTest: true,
      kinds: [{ id: HA_INSTANCE_KIND, label: 'Home Assistant' }],
      allowRestoreId: true,
    },
    formSchema: () => haBrokerSettingsSchema,
    initialBody: (name): HaBrokerBody => ({ name, authKind: 'long-lived' }),
    mintId: () => deps.mintId(),
    kindOf: () => HA_INSTANCE_KIND,
    health: (_body, id) => {
      const info = deps.infoOf(id)
      return {
        status: statusOf(info),
        ...(info?.lastCheckedAt != null ? { lastCheckedAt: info.lastCheckedAt } : {}),
      }
    },
    configured: isHaBodyConfigured,
    onChanged: deps.onChanged,
    test: async ({ id, values }): Promise<IntegrationTestConnectionResult> => {
      const typed = ['accessToken', 'supervisorToken'].some((key) => {
        const v = values[key]
        return typeof v === 'string' && v.length > 0 && v !== REDACTED_SECRET
      })
      if (typed) {
        const r = await deps.probe(values)
        return r.ok
          ? {
              success: true,
              status: 'validated',
              ...(r.latencyMs !== undefined ? { latencyMs: r.latencyMs } : {}),
            }
          : {
              success: false,
              status: 'rejected',
              error: r.error ?? 'Home Assistant rejected the connection',
            }
      }
      const info = id === null ? null : deps.infoOf(id)
      if (info === null) {
        return {
          success: false,
          status: 'inconclusive',
          error: 'Not connected: save the connection first',
        }
      }
      return info.status === 'connected'
        ? { success: true, status: 'validated' }
        : { success: false, status: 'rejected', error: info.error ?? `status: ${info.status}` }
    },
  })
}
