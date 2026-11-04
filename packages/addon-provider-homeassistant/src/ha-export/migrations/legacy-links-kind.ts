/**
 * The `ha-export-links` record kind (planning#408 P4): one record per Home Assistant broker with
 * its export switch, media role and devices. Export targets (`ha-export-targets`) replaced it;
 * the kind is declared ONLY so the migrations can read it and delete its rows. No runtime code
 * outside `migrations/` names it (`no-legacy-links-reader.spec.ts`).
 */
import {
  type DefinedRecordKind,
  defineEntryKind,
  type RecordKindHandle,
  type RecordsAccess,
} from '@camstack/types'
import { z } from 'zod'
import { HA_MEDIA_ROLES, type HaMediaRole } from '../media-url.js'

export const HA_EXPORT_LINKS_KIND_NAME = 'ha-export-links'

export type HaExportLinksBody = {
  readonly name: string
  readonly exportTo: boolean
  readonly mediaRole: HaMediaRole
  readonly devices: readonly string[]
}

export const HaExportLinksBodySchema: z.ZodType<HaExportLinksBody> = z.object({
  name: z.string().min(1),
  exportTo: z.boolean(),
  mediaRole: z.enum(HA_MEDIA_ROLES),
  devices: z.array(z.string()),
})

export const haExportLinksKind: DefinedRecordKind<z.ZodType<HaExportLinksBody>> = defineEntryKind(
  HA_EXPORT_LINKS_KIND_NAME,
  {
    title: 'Home Assistant export links (retired)',
    nameField: 'name',
    schema: HaExportLinksBodySchema,
    writeTrigger: 'only the migrations that move the links into export targets write it',
  },
)

/** Declare the retired kind and hand back its handle, for the migration ports. */
export async function declareLegacyLinks(
  records: Pick<RecordsAccess, 'declare' | 'kind'>,
): Promise<RecordKindHandle<HaExportLinksBody>> {
  await records.declare({ [HA_EXPORT_LINKS_KIND_NAME]: haExportLinksKind })
  return records.kind(haExportLinksKind)
}

/** Every record of the kind, once; a failed read throws (the caller must not serve "nothing"). */
export async function readAllLinks(
  handle: RecordKindHandle<HaExportLinksBody>,
): Promise<ReadonlyMap<string, HaExportLinksBody>> {
  const rows = new Map<string, HaExportLinksBody>()
  let cursor: string | undefined
  do {
    const page = await handle.query({
      limit: 1000,
      ...(cursor === undefined ? {} : { cursor }),
    })
    for (const row of page.records) rows.set(row.id, row.data)
    cursor = page.nextCursor ?? undefined
  } while (cursor !== undefined)
  return rows
}

/** A link the operator has not touched: off, on the public endpoint, no device. */
export function defaultLinks(name: string): HaExportLinksBody {
  return { name, exportTo: false, mediaRole: 'publicEndpoint', devices: [] }
}
