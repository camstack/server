/**
 * The Google accounts as `integration-instances` (planning#408 P3): one instance per broker
 * record, over the SAME `brokers` records and ids the `broker` cap serves (`google_NNN`), so
 * nothing moves. The OAuth session lives beside the record (`oauthAccounts`), so an instance's
 * status is the registry's answer and a change re-seeds the registry.
 */
import {
  type IntegrationInstanceKind,
  type IntegrationTestConnectionResult,
  type RecordsAccess,
  RecordIntegrationInstances,
  REDACTED_SECRET,
} from '@camstack/types'
import { type GoogleBrokerBody, googleBrokersEntryKind } from './broker-record-kinds.js'
import { buildGoogleBrokerSettingsSchema } from './google-broker-settings-schema.js'
import { GOOGLE_BROKER_KIND, GOOGLE_BROKER_KIND_LABEL } from './google-types.js'

export interface GoogleInstancesDeps {
  /** Hub-relative route that starts the account link (`{{brokerId}}` is replaced by the UI). */
  readonly connectPath: string
  readonly disconnectPath: string
  readonly publicOrigin: () => string | null
  readonly mintId: () => string
  /** Whether the account behind `id` is signed in / needs a new sign-in. */
  readonly session: (id: string) => 'connected' | 'reauth' | 'none'
  /** Re-seed the runtime from the records after any change. */
  readonly onChanged: (id: string) => Promise<void>
  /** Probe a saved broker, or an unsaved OAuth client. */
  readonly testSaved: (
    id: string,
  ) => Promise<{ readonly ok: boolean; readonly error?: string; readonly latencyMs?: number }>
  readonly testClient: (
    clientId: string,
    clientSecret: string,
  ) => Promise<{ readonly ok: boolean; readonly error?: string; readonly latencyMs?: number }>
}

function asTestResult(r: {
  readonly ok: boolean
  readonly error?: string
  readonly latencyMs?: number
}): IntegrationTestConnectionResult {
  return r.ok
    ? {
        success: true,
        status: 'validated',
        ...(r.latencyMs !== undefined ? { latencyMs: r.latencyMs } : {}),
      }
    : { success: false, status: 'rejected', error: r.error ?? 'Google rejected the check' }
}

/** The `account` kind of the composed provider: where the OAuth sign-in starts and ends. */
export function googleAccountKind(
  deps: Pick<GoogleInstancesDeps, 'connectPath' | 'disconnectPath'>,
): IntegrationInstanceKind {
  return {
    id: GOOGLE_BROKER_KIND,
    label: GOOGLE_BROKER_KIND_LABEL,
    functionCap: 'broker',
    brokerKind: GOOGLE_BROKER_KIND,
    connectPath: deps.connectPath,
    disconnectPath: deps.disconnectPath,
  }
}

export function buildGoogleInstances(
  records: Pick<RecordsAccess, 'kind' | 'owner'>,
  deps: GoogleInstancesDeps,
): RecordIntegrationInstances<GoogleBrokerBody> {
  return new RecordIntegrationInstances<GoogleBrokerBody>(records, googleBrokersEntryKind, {
    description: {
      role: 'services',
      instanceMode: 'multiple',
      kind: 'account',
      canTest: true,
      allowRestoreId: true,
      kinds: [googleAccountKind(deps)],
    },
    // The calendars an account imports are `calendars` records of their own (D1013).
    formSchema: () => buildGoogleBrokerSettingsSchema(deps.publicOrigin()),
    initialBody: (name): GoogleBrokerBody => ({
      name,
      clientId: '',
      clientSecret: '',
      calendarFilter: '',
      fromAddress: '',
      fromName: '',
    }),
    mintId: deps.mintId,
    kindOf: () => GOOGLE_BROKER_KIND,
    health: (_body, id) => {
      const session = deps.session(id)
      if (session === 'connected') return { status: { state: 'ok', label: 'Signed in' } }
      if (session === 'reauth') {
        return {
          status: { state: 'error', label: 'Sign in again', detail: 'Google session expired' },
        }
      }
      return { status: { state: 'unknown', label: 'Not signed in' } }
    },
    configured: (body) => body.clientId.length > 0 && (body.clientSecret ?? '').length > 0,
    onChanged: deps.onChanged,
    test: async ({ id, values }) => {
      const clientId = values['clientId']
      const secret = values['clientSecret']
      if (
        typeof clientId === 'string' &&
        clientId.length > 0 &&
        typeof secret === 'string' &&
        secret.length > 0 &&
        secret !== REDACTED_SECRET
      ) {
        return asTestResult(await deps.testClient(clientId, secret))
      }
      if (id === null)
        return asTestResult({ ok: false, error: 'Enter the Client ID and Client secret first' })
      return asTestResult(await deps.testSaved(id))
    },
  })
}
