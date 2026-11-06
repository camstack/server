/**
 * The drink counters leave the `pet-fountain` feature of a stored composition.
 *
 * The cap no longer has `lastDrink`, `currentHourDrink`, `last24hDrink` or
 * `todayDrink`, nor the `resetDailyConsumption` method (a fountain's tank is now a
 * `water` consumable derived from `waterLevel`). A fountain composed by the
 * previous preset still names them as fields and forwards the reset to a button,
 * which no longer validates. This removes the four fields and the one forward from
 * the `pet-fountain` feature and nothing else: the pump forward, the other fields,
 * the other features, the name and the enabled flag are kept.
 *
 * Only compositions that BUILD a pet fountain are touched. A row that does not
 * parse, a code block, a customization of an existing device, and a fountain
 * already without the counters are left exactly as they are, so a rerun edits
 * nothing. The block's `updatedAt` moves (it is the version an editor's
 * `expectedUpdatedAt` is checked against).
 */
import {
  type Composition,
  type CoreBlock,
  CoreBlockSchema,
  DeviceType,
  type MigrationProcedureResult,
} from '@camstack/types'
import type { CoreBlockRowBody } from '../record-kinds.js'
import type { CoreBlocksMigrationPorts, StoredBlockRow } from './pump-cycle-split.js'

export const FOUNTAIN_DRINK_DROP_ID = 'core-blocks/2026-11-06-fountain-drink-drop'

const DROPPED_FIELDS = ['lastDrink', 'currentHourDrink', 'last24hDrink', 'todayDrink'] as const
const DROPPED_COMMANDS = ['resetDailyConsumption'] as const

function without<T>(
  record: Readonly<Record<string, T>>,
  keys: readonly string[],
): Record<string, T> {
  return Object.fromEntries(Object.entries(record).filter(([key]) => !keys.includes(key)))
}

/** The composition without the counters, or null when this one has none. */
function dropCounters(composition: Composition): Composition | null {
  if (composition.target.kind !== 'new' || composition.target.type !== DeviceType.PetFountain)
    return null
  let changed = false
  const features: Composition['features'] = composition.features.map((feature) => {
    if (feature.kind !== 'fields' || feature.cap !== 'pet-fountain') return feature
    const commands = feature.commands ?? {}
    const present =
      DROPPED_FIELDS.some((key) => key in feature.fields) ||
      DROPPED_COMMANDS.some((key) => key in commands)
    if (!present) return feature
    changed = true
    return {
      ...feature,
      fields: without(feature.fields, DROPPED_FIELDS),
      commands: without(commands, DROPPED_COMMANDS),
    }
  })
  return changed ? { ...composition, features } : null
}

function dropFromBlock(block: CoreBlock): CoreBlock | null {
  const source = block.source
  if (source === undefined || source.kind !== 'composition') return null
  const composition = dropCounters(source.composition)
  if (composition === null) return null
  return { ...block, source: { kind: 'composition', composition } }
}

interface Rewrite {
  readonly row: StoredBlockRow
  readonly data: CoreBlockRowBody
}

function rewriteOf(row: StoredBlockRow, ports: CoreBlocksMigrationPorts): Rewrite | null {
  const parsed = CoreBlockSchema.safeParse(row.data.block)
  if (!parsed.success) return null
  const dropped = dropFromBlock(parsed.data)
  if (dropped === null) return null
  const updatedAt = Math.max(parsed.data.updatedAt + 1, ports.now())
  const next = CoreBlockSchema.safeParse({ ...dropped, updatedAt })
  if (!next.success) {
    ports.warn('core block left as it is: the fountain without drink counters does not validate', {
      blockId: row.id,
      error: next.error.message,
    })
    return null
  }
  return { row, data: { ...row.data, updatedAt, block: next.data } }
}

export async function dropFountainDrinkCounters(
  ports: CoreBlocksMigrationPorts,
): Promise<MigrationProcedureResult> {
  const rows = await ports.listBlockRows()
  const rewrites = rows.flatMap((row) => {
    const rewrite = rewriteOf(row, ports)
    return rewrite === null ? [] : [rewrite]
  })
  if (rewrites.length === 0) return { outcome: 'already-done', summary: { blocks: 0 } }
  for (const { row, data } of rewrites) await ports.replaceBlockRow(row.id, data, row.rev)
  return { outcome: 'done', summary: { blocks: rewrites.length } }
}
