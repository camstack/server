/**
 * `loki_query` — LogQL against a Loki the hub is configured to ship to.
 *
 * Exists only when a Loki `log-destination` provider is configured (operator
 * decision 4); the hub is asked, nothing is assumed. The Loki URL is read from
 * that provider's settings. Credentials are NOT: an authenticated Loki keeps
 * them in the keychain (D783), no tool reads them, and the request is refused
 * rather than sent unauthenticated. TLS verification is the platform's.
 *
 * There is no Prometheus tool: the repository has no Prometheus provider, so by
 * the same rule there is nothing to gate it on.
 */
import { z } from 'zod'
import type { OpsHub } from './hub.js'
import { listLogProviders } from './logs.js'
import { toToolOutput } from './redact.js'
import { parseWire } from './wire.js'

export const LOKI_PROVIDER_ID = 'loki-logging'
const MAX_RESPONSE_CHARS = 5_000_000

const SettingsSchema = z
  .looseObject({
    sections: z.array(
      z.looseObject({
        fields: z
          .array(z.looseObject({ key: z.string(), value: z.unknown().optional() }))
          .optional(),
      }),
    ),
  })
  .nullable()

export interface LokiTarget {
  readonly baseUrl: string
  readonly tenantId: string | undefined
}

export type LokiTargetResult =
  | { readonly ok: true; readonly target: LokiTarget }
  | { readonly ok: false; readonly reason: string }

function fieldValue(settings: z.infer<typeof SettingsSchema>, key: string): unknown {
  for (const section of settings?.sections ?? []) {
    const hit = section.fields?.find((f) => f.key === key)
    if (hit) return hit.value
  }
  return undefined
}

const isSet = (v: unknown): boolean =>
  v !== undefined &&
  v !== null &&
  v !== '' &&
  !(typeof v === 'object' && v !== null && Object.keys(v).length === 0)

/** Decide whether a Loki target can be queried, from the provider list and its settings. */
export async function resolveLokiTarget(hub: OpsHub): Promise<LokiTargetResult> {
  const providers = await listLogProviders(hub)
  if (!providers.some((p) => p.addonId === LOKI_PROVIDER_ID)) {
    return {
      ok: false,
      reason: `no Loki log-destination provider is configured on this hub (providers: ${providers.map((p) => p.addonId).join(', ') || 'none'}). Use hub_logs with one of those instead.`,
    }
  }
  const raw = await hub.query('addonSettings.getGlobalSettings', { addonId: LOKI_PROVIDER_ID })
  const settings = parseWire(SettingsSchema, raw, 'addonSettings.getGlobalSettings')
  const url = fieldValue(settings, 'url')
  if (typeof url !== 'string' || url.trim() === '') {
    return {
      ok: false,
      reason: `the ${LOKI_PROVIDER_ID} provider is registered but has no URL (it is inert).`,
    }
  }
  if (isSet(fieldValue(settings, 'username')) || isSet(fieldValue(settings, 'password'))) {
    return {
      ok: false,
      reason: `this Loki requires credentials; they live in the keychain and tools never read them (D783). Query it from Grafana, or use hub_logs.`,
    }
  }
  const tenant = fieldValue(settings, 'tenantId')
  return {
    ok: true,
    target: {
      baseUrl: url.trim().replace(/\/+$/, ''),
      tenantId: typeof tenant === 'string' && tenant.trim() !== '' ? tenant.trim() : undefined,
    },
  }
}

export interface LokiArgs {
  readonly logql: string
  readonly sinceMinutes?: number
  readonly limit?: number
}

export type FetchLike = (
  url: string,
  init: { headers: Record<string, string>; signal: AbortSignal },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>

const LokiResponseSchema = z.looseObject({
  data: z.looseObject({
    result: z.array(
      z.looseObject({
        stream: z.record(z.string(), z.string()).optional(),
        values: z.array(z.tuple([z.string(), z.string()])),
      }),
    ),
  }),
})

export async function lokiQuery(
  hub: OpsHub,
  args: LokiArgs,
  fetchImpl: FetchLike = globalThis.fetch,
  now: number = Date.now(),
): Promise<unknown> {
  const resolved = await resolveLokiTarget(hub)
  if (!resolved.ok) return { error: resolved.reason }
  const { baseUrl, tenantId } = resolved.target
  const endNs = BigInt(now) * 1_000_000n
  const startNs = endNs - BigInt((args.sinceMinutes ?? 15) * 60_000) * 1_000_000n
  const params = new URLSearchParams({
    query: args.logql,
    start: startNs.toString(),
    end: endNs.toString(),
    limit: String(args.limit ?? 200),
    direction: 'backward',
  })
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 30_000)
  try {
    const res = await fetchImpl(`${baseUrl}/loki/api/v1/query_range?${params.toString()}`, {
      headers: tenantId ? { 'X-Scope-OrgID': tenantId } : {},
      signal: controller.signal,
    })
    const text = await res.text()
    if (!res.ok) return { error: `Loki answered HTTP ${res.status}`, body: text.slice(0, 300) }
    if (text.length > MAX_RESPONSE_CHARS)
      return { error: 'Loki response too large — narrow the query' }
    const parsed = parseWire(LokiResponseSchema, JSON.parse(text), 'loki query_range')
    const lines = parsed.data.result
      .flatMap((r) => r.values.map(([ts, line]) => ({ ts, stream: r.stream, line })))
      .toSorted((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0))
    return toToolOutput({ source: LOKI_PROVIDER_ID, count: lines.length, lines })
  } finally {
    clearTimeout(timer)
  }
}
