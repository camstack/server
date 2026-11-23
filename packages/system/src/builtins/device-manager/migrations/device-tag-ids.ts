/**
 * A device row gets the ids of its tags (D1089, the device-manager step of the tags
 * migration): `tagIds` is added beside the kept `tags` names, aligned by index, with each id
 * derived from the folded name (`tagIdFromKey`) so every owner of that name mints the same
 * one. The names stay for one release; the `tags` records are written later by the
 * core-blocks tags-as-records procedure, which `dependsOn` this step.
 *
 * ONE plan, one transaction. A row that already has `tagIds` is left alone (a rerun is
 * empty); a row whose names repeat one tag in two spellings is rewritten with both columns
 * de-duplicated, so the index alignment holds.
 */
import {
  type MigrationEdit,
  type MigrationPlan,
  normalizeTags,
  preconditionOf,
  tagIdFromKey,
  tagKey,
} from '@camstack/types'
import { DEVICE_ROWS_COLLECTION } from '../device-row-store.js'

export const DEVICE_TAG_IDS_ID = 'device-manager/2026-11-23-device-tag-ids'

export interface DeviceTagColumns {
  readonly deviceId: number
  /** The kept names, as the column decodes. Empty = none. */
  readonly tags: readonly string[]
  /** True when the row already carries `tagIds`. */
  readonly hasTagIds: boolean
}

export interface DeviceTagIdsPorts {
  /** Every device row's `tags` and whether it has `tagIds`. Throws when unreadable. */
  readDeviceTags(): Promise<readonly DeviceTagColumns[]>
}

export async function planDeviceTagIds(ports: DeviceTagIdsPorts): Promise<MigrationPlan> {
  const rows = await ports.readDeviceTags()
  const edits: MigrationEdit[] = []
  for (const row of rows) {
    if (row.hasTagIds) continue
    const names = normalizeTags(row.tags)
    if (names.length === 0) continue
    const sameNames = names.length === row.tags.length
    edits.push({
      op: 'putRow',
      table: DEVICE_ROWS_COLLECTION,
      key: { deviceId: row.deviceId },
      row: {
        tagIds: names.map((name) => tagIdFromKey(tagKey(name))),
        ...(sameNames ? {} : { tags: names }),
      },
      // The column this edit adds: a row that gained `tagIds` since the read refuses the plan.
      preconditionColumns: ['tagIds'],
      precondition: preconditionOf({ tagIds: null }),
    })
  }
  return { edits }
}
