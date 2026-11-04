/**
 * The Alexa accounts as `integration-instances` (planning#408 P3): one instance per `brokers`
 * record, over the SAME records and ids (`alexa_NNN`) the `broker` cap serves. The body is flat, so
 * the form the instances page edits is the stored shape. Signing in (device code or the Amazon
 * login proxy) goes through the routes the addon already serves under `/addon/import-alexa/login`.
 */
import {
  type IntegrationInstanceStatus,
  type IntegrationTestConnectionResult,
  type RecordsAccess,
  RecordIntegrationInstances,
  REDACTED_SECRET,
} from '@camstack/types'
import { alexaBrokersEntryKind, type AlexaBrokerBody } from './broker-record-kinds.js'
import { buildConnectionFormSchema } from './config.js'
import type { AlexaBrokerInfo } from './alexa-integration-manager.js'

export const ALEXA_INSTANCE_KIND = 'alexa'
export const ALEXA_SIGN_IN_PATH = '/addon/import-alexa/login'

export interface AlexaInstancesDeps {
  readonly mintId: () => string
  readonly infoOf: (id: string) => AlexaBrokerInfo | null
  /** Bring the runtime in line with the records after a change. */
  readonly onChanged: (id: string) => Promise<void>
}

export function isAlexaBodyConfigured(body: AlexaBrokerBody): boolean {
  return body.cookie.length > 0 || body.refreshToken.length > 0
}

function statusOf(info: AlexaBrokerInfo | null, configured: boolean): IntegrationInstanceStatus {
  if (!configured) return { state: 'unknown', label: 'Not signed in' }
  if (info === null) return { state: 'unknown', label: 'Not connected' }
  if (info.status === 'connected') return { state: 'ok', label: 'Connected' }
  if (info.status === 'connecting') return { state: 'unknown', label: 'Connecting' }
  return {
    state: 'error',
    label: info.status,
    ...(info.error !== null ? { detail: info.error } : {}),
  }
}

export function buildAlexaInstances(
  records: Pick<RecordsAccess, 'kind' | 'owner'>,
  deps: AlexaInstancesDeps,
): RecordIntegrationInstances<AlexaBrokerBody> {
  return new RecordIntegrationInstances<AlexaBrokerBody>(records, alexaBrokersEntryKind, {
    description: {
      role: 'both',
      instanceMode: 'multiple',
      kind: 'account',
      canTest: true,
      kinds: [
        {
          id: ALEXA_INSTANCE_KIND,
          label: 'Alexa',
          signIn: { basePath: ALEXA_SIGN_IN_PATH, methods: ['device-code', 'proxy'] },
        },
      ],
      allowRestoreId: true,
    },
    formSchema: () => buildConnectionFormSchema(),
    initialBody: (name): AlexaBrokerBody => ({
      name,
      amazonDomain: 'amazon.com',
      cookie: '',
      refreshToken: '',
      macDms: '',
      pollIntervalMs: 60_000,
    }),
    mintId: () => deps.mintId(),
    kindOf: () => ALEXA_INSTANCE_KIND,
    health: (body, id) => {
      const info = deps.infoOf(id)
      return {
        status: statusOf(info, isAlexaBodyConfigured(body)),
        ...(info?.lastCheckedAt != null ? { lastCheckedAt: info.lastCheckedAt } : {}),
      }
    },
    configured: isAlexaBodyConfigured,
    onChanged: deps.onChanged,
    test: async ({ id, values }): Promise<IntegrationTestConnectionResult> => {
      const typed = ['cookie', 'refreshToken'].some((key) => {
        const v = values[key]
        return typeof v === 'string' && v.length > 0 && v !== REDACTED_SECRET
      })
      if (typed) {
        return {
          success: true,
          status: 'inconclusive',
          error: 'Save the account to check the sign-in',
        }
      }
      const info = id === null ? null : deps.infoOf(id)
      if (info === null) {
        return { success: false, status: 'inconclusive', error: 'Not connected: sign in first' }
      }
      return info.status === 'connected'
        ? { success: true, status: 'validated' }
        : { success: false, status: 'rejected', error: info.error ?? `status: ${info.status}` }
    },
  })
}
