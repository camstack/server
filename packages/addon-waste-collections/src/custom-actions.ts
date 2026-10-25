import {
  customAction,
  defineCustomActions,
  RawSecretMigrationInputSchema,
  RawSecretMigrationReportSchema,
} from '@camstack/types'
import { z } from 'zod'

const SourceIdSchema = z
  .string()
  .min(1)
  .regex(/^[a-z0-9][a-z0-9-]{0,63}$/, 'id must be a lowercase slug')

/**
 * A source as the admin list shows it. No `args`: a credential never leaves the
 * addon - `formValues` carries the redaction token where one is stored (D880).
 */
const WasteSourceRowSchema = z.object({
  id: z.string(),
  label: z.string(),
  module: z.string(),
  enabled: z.boolean(),
  formValues: z.record(z.string(), z.unknown()).optional(),
  serviceId: z.string().optional(),
  countryId: z.string().optional(),
})

export const wasteCollectionsActions = defineCustomActions({
  fetchNow: customAction(
    z
      .object({
        /** When set, refresh only this configured source id; otherwise all enabled. */
        sourceId: z.string().min(1).optional(),
      })
      .optional(),
    z.object({
      ok: z.literal(true),
      refreshed: z.array(
        z.object({
          sourceId: z.string(),
          entryCount: z.number().int(),
          error: z.string().optional(),
        }),
      ),
    }),
    { kind: 'mutation', auth: 'admin' },
  ),

  listSources: customAction(z.object({}), z.array(WasteSourceRowSchema).readonly(), {
    kind: 'mutation',
    auth: 'admin',
  }),

  listCountries: customAction(
    z.object({}),
    z.array(z.object({ id: z.string(), label: z.string() })).readonly(),
    { kind: 'mutation', auth: 'admin' },
  ),

  listServices: customAction(
    z.object({ countryId: z.string().min(1) }),
    z
      .array(
        z.object({
          id: z.string(),
          /** Operator list label — may include `(serviceCode)`. */
          label: z.string(),
          /** Catalog title without the service-code suffix (calendar default). */
          title: z.string(),
          module: z.string(),
        }),
      )
      .readonly(),
    { kind: 'mutation', auth: 'admin' },
  ),

  serviceFormSchema: customAction(z.object({ serviceId: z.string().min(1) }), z.unknown(), {
    kind: 'mutation',
    auth: 'admin',
  }),

  createSource: customAction(
    z.object({
      /** Optional override; when omitted the id is derived from `label`. */
      id: SourceIdSchema.optional(),
      label: z.string().min(1),
      serviceId: z.string().min(1),
      args: z.record(z.string(), z.unknown()).default({}),
      enabled: z.boolean().optional(),
    }),
    z.object({ id: z.string() }),
    { kind: 'mutation', auth: 'admin' },
  ),

  updateSource: customAction(
    z.object({
      id: z.string().min(1),
      label: z.string().min(1),
      serviceId: z.string().min(1).optional(),
      args: z.record(z.string(), z.unknown()).optional(),
      enabled: z.boolean().optional(),
    }),
    z.object({ ok: z.literal(true) }),
    { kind: 'mutation', auth: 'admin' },
  ),

  /**
   * D880: rewrite every legacy source (free `argsJson`) as typed `args`, moving its
   * credentials into the keychain. Dry run unless `apply`; idempotent; counts only.
   */
  migrateSources: customAction(RawSecretMigrationInputSchema, RawSecretMigrationReportSchema, {
    kind: 'mutation',
    auth: 'admin',
  }),

  deleteSource: customAction(
    z.object({ id: z.string().min(1) }),
    z.object({ ok: z.literal(true) }),
    { kind: 'mutation', auth: 'admin' },
  ),
})

export type WasteCollectionsActions = typeof wasteCollectionsActions
