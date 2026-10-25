/**
 * Does the HUB's rule router speak D642 — per-rule consumable thresholds?
 * (D642 review I2; D934 dropped the tank-kind probe.)
 *
 * The admin and the notification centre are self-contained bundles: they
 * load, and look current, on a hub whose `@camstack/server` closure predates
 * D642. The hub's generated router validates rule input with the Zod schemas
 * of THAT closure, and it fails silently: it strips `consumableLowPercent`
 * (z.object drops unknown keys), so a rule saves "fine" and judges at 15 %.
 *
 * The probe is `previewTemplate` (pure, sends nothing, `view` access) with a
 * consumable kind in its context. An old router answers BAD_REQUEST; a D642+
 * router renders. Four answers, D315-style: a probe that has not answered is
 * `pending`, and one that failed for any other reason is `unknown`, never
 * "the hub is old".
 */
import type { NcTemplatePreviewInput } from '@camstack/types'
import { useSystem } from '@camstack/ui-library'
import { useQuery } from '@tanstack/react-query'

export type HubRuleSchemaVerdict = 'pending' | 'current' | 'outdated' | 'unknown'

/** The one input the probe sends: a consumable kind in a device-events context. */
export const HUB_RULE_SCHEMA_PROBE: NcTemplatePreviewInput = {
  context: {
    family: 'rule',
    field: 'body',
    kind: 'device-events',
    systemEventKinds: ['device-consumable-low'],
  },
  template: { body: '{{deviceName}}' }, // i18n-ignore: template token in a probe payload
}

/** The tRPC error code on a rejected call, read without a cast. */
function trpcCodeOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('data' in error)) return undefined
  const data: unknown = error.data
  if (typeof data !== 'object' || data === null || !('code' in data)) return undefined
  return typeof data.code === 'string' ? data.code : undefined
}

/** The verdict from the probe's query state. Pure. */
export function hubRuleSchemaVerdictOf(
  status: 'pending' | 'success' | 'error',
  error: unknown,
): HubRuleSchemaVerdict {
  if (status === 'pending') return 'pending'
  if (status === 'success') return 'current'
  return trpcCodeOf(error) === 'BAD_REQUEST' ? 'outdated' : 'unknown'
}

/** Ask the hub once (per 5 min); `enabled: false` asks nothing. */
export function useHubRuleSchemaVerdict(enabled: boolean): HubRuleSchemaVerdict {
  const system = useSystem()
  const query = useQuery({
    queryKey: ['nc', 'hub-rule-schema-probe'],
    enabled,
    staleTime: 5 * 60_000,
    retry: false,
    queryFn: () =>
      system.trpcClient.notificationRules.previewTemplate.mutate(HUB_RULE_SCHEMA_PROBE),
  })
  if (!enabled) return 'pending'
  return hubRuleSchemaVerdictOf(query.status, query.error)
}
