import { customAction, defineCustomActions } from '@camstack/types'
import { z } from 'zod'

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
})

export type WasteCollectionsActions = typeof wasteCollectionsActions
