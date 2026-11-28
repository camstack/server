/**
 * Every core-blocks record that carries tags gets the ids of those tags (D1089, the
 * core-blocks step of the tags migration): `tagIds` is added beside the kept `tags` names,
 * aligned by index, each id derived from the folded name (`tagIdFromKey`) so the device
 * manager and the notification rules mint the same id for the same name without reading each
 * other. The names stay for one release.
 *
 * Four owners: core blocks (the tags sit on the block inside the row body), schedulers,
 * templates and actions. A row with no tags, or one that already has `tagIds`, is left
 * alone, so a rerun edits nothing. A row whose names repeat one tag in two spellings is
 * rewritten with both fields de-duplicated, so the index alignment holds. Each row is
 * replaced only if it is still at the revision that was read; a row changed meanwhile fails
 * the run, which retries on the next boot.
 */
import {
  type IScopedLogger,
  type MigrationProcedureResult,
  normalizeTags,
  type RecordKindHandle,
  tagIdFromKey,
  tagKey,
} from '@dominevo/types'
import { readAllRows } from '../../../records/read-all-rows.js'
import type {
  ActionRowBody,
  CoreBlockRowBody,
  SchedulerRowBody,
  TemplateRowBody,
} from '../record-kinds.js'

export const CORE_BLOCKS_TAG_IDS_ID = 'core-blocks/2026-11-23-tag-ids'

export type TaggedOwner = 'blocks' | 'schedulers' | 'templates' | 'actions'

/** A record's tags as the migration reads them. */
export interface TaggedRow {
  readonly owner: TaggedOwner
  readonly id: string
  readonly rev: number
  readonly tags: readonly string[]
  readonly hasTagIds: boolean
}

export interface TagIdsPorts {
  /** Every record that carries tags, of the four owners. Throws when one cannot be read in full. */
  listTaggedRows(): Promise<readonly TaggedRow[]>
  /** Write the ids (and the de-duplicated names when `tags` is given), refused if the row moved. */
  writeTagIds(
    row: TaggedRow,
    tagIds: readonly string[],
    tags: readonly string[] | null,
  ): Promise<void>
  info(message: string, meta: Readonly<Record<string, unknown>>): void
}

function stringList(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

function tagsOfBlock(block: Readonly<Record<string, unknown>>): {
  readonly tags: readonly string[]
  readonly hasTagIds: boolean
} {
  return { tags: stringList(block['tags']), hasTagIds: Array.isArray(block['tagIds']) }
}

/** The four record kinds the migration walks. */
export interface TagIdsKinds {
  readonly blocks: RecordKindHandle<CoreBlockRowBody>
  readonly schedulers: RecordKindHandle<SchedulerRowBody>
  readonly templates: RecordKindHandle<TemplateRowBody>
  readonly actions: RecordKindHandle<ActionRowBody>
}

export function tagIdsPortsOver(kinds: TagIdsKinds, logger: IScopedLogger): TagIdsPorts {
  const rowOf = (
    owner: TaggedOwner,
    row: { id: string; rev: number },
    tags: readonly string[],
    hasTagIds: boolean,
  ): TaggedRow => ({ owner, id: row.id, rev: row.rev, tags, hasTagIds })
  return {
    listTaggedRows: async () => {
      const blocks = (await readAllRows(kinds.blocks)).map((row) => {
        const { tags, hasTagIds } = tagsOfBlock(row.data.block)
        return rowOf('blocks', row, tags, hasTagIds)
      })
      const schedulers = (await readAllRows(kinds.schedulers)).map((row) =>
        rowOf('schedulers', row, row.data.tags ?? [], row.data.tagIds !== undefined),
      )
      const templates = (await readAllRows(kinds.templates)).map((row) =>
        rowOf('templates', row, row.data.tags ?? [], row.data.tagIds !== undefined),
      )
      const actions = (await readAllRows(kinds.actions)).map((row) =>
        rowOf('actions', row, row.data.tags ?? [], row.data.tagIds !== undefined),
      )
      return [...blocks, ...schedulers, ...templates, ...actions]
    },
    writeTagIds: async (row, tagIds, tags) => {
      const ids = [...tagIds]
      const names = tags === null ? null : [...tags]
      switch (row.owner) {
        case 'blocks': {
          const current = await kinds.blocks.get(row.id)
          if (current === null || current.rev !== row.rev) throw movedError(row)
          const block = {
            ...current.data.block,
            tagIds: ids,
            ...(names === null ? {} : { tags: names }),
          }
          await kinds.blocks.put(
            { id: row.id, data: { ...current.data, block } },
            { ifRev: row.rev },
          )
          return
        }
        case 'schedulers': {
          const current = await kinds.schedulers.get(row.id)
          if (current === null || current.rev !== row.rev) throw movedError(row)
          await kinds.schedulers.put(
            {
              id: row.id,
              data: { ...current.data, tagIds: ids, ...(names === null ? {} : { tags: names }) },
            },
            { ifRev: row.rev },
          )
          return
        }
        case 'templates': {
          const current = await kinds.templates.get(row.id)
          if (current === null || current.rev !== row.rev) throw movedError(row)
          await kinds.templates.put(
            {
              id: row.id,
              data: { ...current.data, tagIds: ids, ...(names === null ? {} : { tags: names }) },
            },
            { ifRev: row.rev },
          )
          return
        }
        case 'actions': {
          const current = await kinds.actions.get(row.id)
          if (current === null || current.rev !== row.rev) throw movedError(row)
          await kinds.actions.put(
            {
              id: row.id,
              data: { ...current.data, tagIds: ids, ...(names === null ? {} : { tags: names }) },
            },
            { ifRev: row.rev },
          )
          return
        }
      }
    },
    info: (message, meta) => {
      logger.info(message, { meta })
    },
  }
}

function movedError(row: TaggedRow): Error {
  return new Error(`${row.owner} record ${row.id} changed since it was read`)
}

export async function addTagIds(ports: TagIdsPorts): Promise<MigrationProcedureResult> {
  const rows = await ports.listTaggedRows()
  let written = 0
  for (const row of rows) {
    if (row.hasTagIds) continue
    const names = normalizeTags(row.tags)
    if (names.length === 0) continue
    const sameNames = names.length === row.tags.length
    await ports.writeTagIds(
      row,
      names.map((name) => tagIdFromKey(tagKey(name))),
      sameNames ? null : names,
    )
    written += 1
  }
  if (written === 0) return { outcome: 'already-done', summary: { records: 0 } }
  ports.info('core-blocks tag ids added', { records: written })
  return { outcome: 'done', summary: { records: written } }
}
