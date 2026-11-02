/**
 * The Loki connection as a record (D985): one `destinations` row per Loki instance, owned by
 * `loki-logging`, listed on the Integrations page like any other connection. The row id is the
 * `integrations` registry id (`int_NNNN`). The password is a keychain marker bound to the row.
 *
 * The kind name is `destinations` (kind names are lower-case-dashed); the owner is `loki-logging`.
 */
import { defineEntryKind } from '@camstack/types'
import { z } from 'zod'

export const LokiDestinationBodySchema = z.object({
  name: z.string().min(1),
  url: z.string(),
  level: z.enum(['debug', 'info', 'warn', 'error']),
  job: z.string(),
  extraLabels: z.string(),
  tenantId: z.string(),
  username: z.string(),
  password: z.string().optional().meta({ secret: true }),
  batchIntervalMs: z.number().int().min(250).max(60_000),
  batchSize: z.number().int().min(1).max(5_000),
  timeoutMs: z.number().int().min(1_000).max(60_000),
})

export type LokiDestinationBody = z.infer<typeof LokiDestinationBodySchema>

export const LOKI_DESTINATIONS_KIND_NAME = 'destinations'

export const lokiDestinationsKind = defineEntryKind(LOKI_DESTINATIONS_KIND_NAME, {
  title: 'Loki destinations',
  nameField: 'name',
  schema: LokiDestinationBodySchema,
})

export const LOKI_DEFAULT_BODY: Omit<LokiDestinationBody, 'name'> = {
  url: '',
  level: 'info',
  job: 'camstack',
  extraLabels: '',
  tenantId: '',
  username: '',
  batchIntervalMs: 5_000,
  batchSize: 200,
  timeoutMs: 10_000,
}
