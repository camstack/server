/**
 * The Loki connection as a record (D985): one `destinations` row per Loki instance, owned by
 * `loki-logging`, listed on the Integrations page like any other connection. The row id is the
 * `integrations` registry id (`int_NNNN`). The password is a keychain marker bound to the row.
 *
 * The kind name is `destinations` (kind names are lower-case-dashed); the owner is `loki-logging`.
 */
import { type DefinedRecordKind, defineEntryKind } from '@camstack/types'
import { z } from 'zod'

export interface LokiBound {
  readonly min: number
  readonly max: number
}

/** The inclusive bounds of the numeric fields: the schema and the settings migration read ONE copy. */
export const LOKI_BOUNDS: Readonly<
  Record<'batchIntervalMs' | 'batchSize' | 'timeoutMs', LokiBound>
> = {
  batchIntervalMs: { min: 250, max: 60_000 },
  batchSize: { min: 1, max: 5_000 },
  timeoutMs: { min: 1_000, max: 60_000 },
}

export type LokiDestinationBody = {
  readonly name: string
  readonly url: string
  readonly level: 'debug' | 'info' | 'warn' | 'error'
  readonly job: string
  readonly extraLabels: string
  readonly tenantId: string
  readonly username: string
  readonly password?: string | undefined
  readonly batchIntervalMs: number
  readonly batchSize: number
  readonly timeoutMs: number
  /** The instance's own switch (D996). Absent means on, so no data migration was needed. */
  readonly enabled?: boolean | undefined
}

/** The schema is checked against the interface by its annotation: a drifted field fails the typecheck. */
export const LokiDestinationBodySchema: z.ZodType<LokiDestinationBody> = z.object({
  name: z.string().min(1),
  url: z.string(),
  level: z.enum(['debug', 'info', 'warn', 'error']),
  job: z.string(),
  extraLabels: z.string(),
  tenantId: z.string(),
  username: z.string(),
  password: z.string().optional().meta({ secret: true }),
  batchIntervalMs: z
    .number()
    .int()
    .min(LOKI_BOUNDS.batchIntervalMs.min)
    .max(LOKI_BOUNDS.batchIntervalMs.max),
  batchSize: z.number().int().min(LOKI_BOUNDS.batchSize.min).max(LOKI_BOUNDS.batchSize.max),
  timeoutMs: z.number().int().min(LOKI_BOUNDS.timeoutMs.min).max(LOKI_BOUNDS.timeoutMs.max),
  enabled: z.boolean().optional(),
})

export const LOKI_DESTINATIONS_KIND_NAME = 'destinations'

export const lokiDestinationsKind: DefinedRecordKind<z.ZodType<LokiDestinationBody>> =
  defineEntryKind(LOKI_DESTINATIONS_KIND_NAME, {
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
