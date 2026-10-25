/**
 * Hub logs — through the log-destination provider the OPERATOR chose.
 *
 * Nothing here assumes Grafana or Loki: a hub may have only the onboard winston
 * destination, or others. The tool lists the configured `log-destination`
 * providers and queries the one named (operator decision 4, 2026-10-09)
 * through `logs.query { source }` (D898). The in-RAM tail is a separate,
 * always-present source called `ring`.
 */
import { z } from 'zod'
import type { OpsHub } from './hub.js'
import { toToolOutput } from './redact.js'
import { LogDestinationProviderSchema, parseWire } from './wire.js'

export const RING_SOURCE = 'ring'
export const LOG_DESTINATION_CAP = 'log-destination'

export interface LogProvider {
  readonly addonId: string
  readonly isActive: boolean | undefined
}

export type LogSelection =
  | { readonly kind: 'ring' }
  | { readonly kind: 'provider'; readonly addonId: string }
  | { readonly kind: 'choose'; readonly options: readonly string[] }
  | { readonly kind: 'unknown'; readonly requested: string; readonly options: readonly string[] }

/** Which source a request names. No default: an unstated provider is a question, not a guess. */
export function selectLogSource(
  providers: readonly LogProvider[],
  requested: string | undefined,
): LogSelection {
  const options = [RING_SOURCE, ...providers.map((p) => p.addonId)]
  if (requested === undefined || requested.trim() === '') return { kind: 'choose', options }
  if (requested === RING_SOURCE) return { kind: 'ring' }
  const match = providers.find((p) => p.addonId === requested)
  return match
    ? { kind: 'provider', addonId: match.addonId }
    : { kind: 'unknown', requested, options }
}

export async function listLogProviders(hub: OpsHub): Promise<LogProvider[]> {
  const raw = await hub.query('addons.listCapabilityProviders', { capName: LOG_DESTINATION_CAP })
  return parseWire(
    z.array(LogDestinationProviderSchema),
    raw,
    'addons.listCapabilityProviders',
  ).map((p) => ({ addonId: p.addonId, isActive: p.isActive }))
}

export interface HubLogsArgs {
  /** `ring` or a log-destination provider's addonId. Omit to be shown the choices. */
  readonly provider?: string
  readonly level?: 'debug' | 'info' | 'warn' | 'error'
  readonly sinceMinutes?: number
  readonly limit?: number
  readonly deviceId?: number
  readonly addonId?: string
  readonly nodeId?: string
}

const RING_HINT =
  'ring = the hub in-RAM tail (recent lines); a provider name reads that log-destination (winston-logging = the rotated files, loki-logging when configured).'
const SHIP_ONLY_HINT =
  'This destination may only SHIP logs (console-logging, hub-forwarder): logs.sources says which can read. When the page says done:false, call again with before = nextBefore.'

function tagsOf(args: HubLogsArgs): Record<string, string> {
  const tags: Record<string, string> = {}
  if (args.deviceId !== undefined) tags['deviceId'] = String(args.deviceId)
  if (args.addonId) tags['addonId'] = args.addonId
  if (args.nodeId) tags['nodeId'] = args.nodeId
  return tags
}

export async function hubLogs(
  hub: OpsHub,
  args: HubLogsArgs,
  now: number = Date.now(),
): Promise<unknown> {
  const providers = await listLogProviders(hub)
  const selection = selectLogSource(providers, args.provider)
  if (selection.kind === 'choose') {
    return toToolOutput({
      question: 'Which log source should be queried? Re-call hub_logs with provider set.',
      options: selection.options,
      providers,
      hint: RING_HINT,
    })
  }
  if (selection.kind === 'unknown') {
    return toToolOutput({
      error: `unknown log provider "${selection.requested}"`,
      options: selection.options,
    })
  }
  const since = now - (args.sinceMinutes ?? 15) * 60_000
  const limit = args.limit ?? 100
  const tags = tagsOf(args)
  const source = selection.kind === 'ring' ? RING_SOURCE : selection.addonId
  const page = await hub.query('logs.query', {
    source,
    ...(args.level ? { level: args.level } : {}),
    since,
    limit,
    ...(Object.keys(tags).length > 0 ? { tags } : {}),
  })
  const empty =
    typeof page === 'object' &&
    page !== null &&
    'entries' in page &&
    Array.isArray(page.entries) &&
    page.entries.length === 0
  return toToolOutput({ source, page, ...(empty ? { note: SHIP_ONLY_HINT } : {}) })
}
