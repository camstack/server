/**
 * Tags become records with an id (D1089, the last step of the tags migration).
 *
 * Before: a tag was a NAME on the records it labelled; its only registry was a style row
 * (`tag-styles`: colour and icon). After: one `tags` record per tag in use or styled, whose
 * id is the one the per-owner steps already wrote into `tagIds` (`tagIdFromKey` of the folded
 * name), carrying the colour and icon of its style. The style rows are then deleted.
 *
 * Idempotent and ordered so a crash loses nothing: every record is written BEFORE any style
 * row is deleted, an existing record is never overwritten (a seed never overwrites), and a
 * rerun finds no style row and every tag present. The display spelling is the style's, else
 * the one used most (the first alphabetically on a tie).
 *
 * `dependsOn` the owner steps that add `tagIds`, so a record exists under the id they used.
 * Names held by owners outside this addon (the device manager, the notification rules) are
 * read best effort: one that cannot be reached right now is logged and skipped, because its
 * tag is created on first use by `ensureTag` and its rows keep the kept names meanwhile; a
 * styled tag is carried either way.
 */
import {
  type IScopedLogger,
  type MigrationProcedureResult,
  type RecordKindHandle,
  type TagBody,
  type TagStyle,
  tagIdFromKey,
  tagKey,
} from '@camstack/types'
import { readAllRows } from '../../../records/read-all-rows.js'
import type { TagStyleRowBody } from '../record-kinds.js'
import type { TagIdsPorts } from './tag-ids.js'

export const TAGS_AS_RECORDS_ID = 'core-blocks/2026-11-23-tags-as-records'

export interface TagsAsRecordsPorts {
  /** Every tag name carried by the core-blocks records, repeats kept (they weigh the spelling). */
  localNames(): Promise<readonly string[]>
  /** The names the other owners carry, or `null` when they cannot be read right now. */
  externalNames(): Promise<readonly string[] | null>
  listStyles(): Promise<readonly { readonly id: string; readonly style: TagStyle }[]>
  existingTagIds(): Promise<ReadonlySet<string>>
  /** Create the record `id`; refused when it exists. */
  createTag(id: string, body: TagBody): Promise<void>
  deleteStyle(id: string): Promise<void>
  info(message: string, meta: Readonly<Record<string, unknown>>): void
  warn(message: string, meta: Readonly<Record<string, unknown>>): void
}

export function tagsAsRecordsPortsOver(input: {
  readonly tagIds: TagIdsPorts
  readonly external: () => Promise<readonly string[]>
  readonly styles: RecordKindHandle<TagStyleRowBody>
  readonly tags: RecordKindHandle<TagBody>
  readonly logger: IScopedLogger
}): TagsAsRecordsPorts {
  return {
    localNames: async () => (await input.tagIds.listTaggedRows()).flatMap((row) => [...row.tags]),
    externalNames: async () => {
      try {
        return await input.external()
      } catch (err: unknown) {
        input.logger.warn('tags migration: another owner could not be read, skipped', {
          meta: { error: err instanceof Error ? err.message : String(err) },
        })
        return null
      }
    },
    listStyles: async () =>
      (await readAllRows(input.styles)).map((row) => ({ id: row.id, style: row.data })),
    existingTagIds: async () => new Set((await readAllRows(input.tags)).map((row) => row.id)),
    createTag: async (id, body) => {
      await input.tags.put({ id, data: body }, { ifRev: 0 })
    },
    deleteStyle: async (id) => {
      await input.styles.delete(id)
    },
    info: (message, meta) => {
      input.logger.info(message, { meta })
    },
    warn: (message, meta) => {
      input.logger.warn(message, { meta })
    },
  }
}

function mostUsed(counts: ReadonlyMap<string, number>): string {
  const best = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]
  return best === undefined ? '' : best[0]
}

export async function writeTagRecords(
  ports: TagsAsRecordsPorts,
): Promise<MigrationProcedureResult> {
  const styles = await ports.listStyles()
  const external = await ports.externalNames()
  if (external === null) {
    // The devices and rules already carry ids derived from their names: without their names a
    // record could be named from a partial count, and the styles are the only copy of the colours.
    // Nothing is written and nothing is deleted; the step runs again on the next boot.
    ports.warn('tags migration: another owner could not be read, will retry on the next boot', {})
    throw new Error('tags migration: names of other owners could not be read, retrying next boot')
  }
  const spellings = new Map<string, Map<string, number>>()
  for (const name of [...(await ports.localNames()), ...external]) {
    const trimmed = name.trim()
    if (trimmed.length === 0) continue
    const counts = spellings.get(tagKey(trimmed)) ?? new Map<string, number>()
    counts.set(trimmed, (counts.get(trimmed) ?? 0) + 1)
    spellings.set(tagKey(trimmed), counts)
  }
  const styleOf = new Map(styles.map((row) => [tagKey(row.style.name), row.style]))
  const existing = await ports.existingTagIds()
  const keys = new Set([...spellings.keys(), ...styleOf.keys()])
  let created = 0
  for (const key of [...keys].sort()) {
    const id = tagIdFromKey(key)
    if (existing.has(id)) continue
    const style = styleOf.get(key)
    const counts = spellings.get(key)
    const name = style?.name ?? (counts === undefined ? key : mostUsed(counts))
    await ports.createTag(id, {
      name,
      ...(style === undefined ? {} : { colour: style.color, icon: style.icon }),
    })
    created += 1
  }
  // Every record is written: only now do the style rows go.
  for (const row of styles) await ports.deleteStyle(row.id)
  if (created === 0 && styles.length === 0) {
    return { outcome: 'already-done', summary: { tags: 0, styles: 0 } }
  }
  ports.info('tags are records', { tags: created, styles: styles.length })
  return { outcome: 'done', summary: { tags: created, styles: styles.length } }
}
