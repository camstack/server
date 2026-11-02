/**
 * The pump duty cycle leaves the `pet-fountain` feature of a stored composition
 * (planning#366).
 *
 * A fountain composed by the previous preset carries `pumpIntervalEnabled`,
 * `pumpOnTime` and `pumpOffTime` as fields of `pet-fountain` and the three
 * forwards `setPumpInterval`, `setPumpOnMinutes`, `setPumpOffMinutes`. The cap no
 * longer has them: the cycle is the optional `pump-cycle` cap. This rewrites each
 * such block so it validates against the new cap and keeps working:
 *
 *  - the three fields and three forwards leave `pet-fountain`;
 *  - when all three forwards existed, a `pump-cycle` feature is inserted right after
 *    it, carrying the old cycle switch as `enabled`, the two times unknown (a number
 *    box cannot be read back) and the three forwards renamed to the new methods;
 *  - when they did not all exist there is no cycle to keep: the three fields go and
 *    no `pump-cycle` is added.
 *
 * Only compositions that BUILD a pet fountain are touched. A row that does not parse,
 * a code block, a customization of an existing device, and a fountain already in the
 * new shape are left exactly as they are, so a rerun edits nothing. The block's
 * `updatedAt` moves (it is the version an editor's `expectedUpdatedAt` is checked
 * against); every other field, the name and the enabled flag included, is kept.
 */
import {
  type Composition,
  type CompositionCommandTarget,
  type CompositionFieldSource,
  type CompositionFieldsFeature,
  type CoreBlock,
  CoreBlockSchema,
  DeviceType,
  type IScopedLogger,
  type MigrationProcedureResult,
  type RecordKindHandle,
} from '@camstack/types'
import { readAllRows } from '../../../records/read-all-rows.js'
import type { CoreBlockRowBody } from '../record-kinds.js'

export const PUMP_CYCLE_SPLIT_ID = 'core-blocks/2026-11-02-pump-cycle-split'

/** A stored block row as the migration reads it: the version it read is the version it writes over. */
export interface StoredBlockRow {
  readonly id: string
  readonly rev: number
  readonly data: CoreBlockRowBody
}

export interface CoreBlocksMigrationPorts {
  /** Every stored block row. Throws when they cannot be read in full. */
  listBlockRows(): Promise<readonly StoredBlockRow[]>
  /** Replace a row's body, refused when the row changed since it was read. */
  replaceBlockRow(id: string, data: CoreBlockRowBody, ifRev: number): Promise<void>
  now(): number
  warn(message: string, meta: Readonly<Record<string, unknown>>): void
}

/** The ports over the real `core_blocks` kind. */
export function coreBlocksMigrationPorts(
  blocks: RecordKindHandle<CoreBlockRowBody>,
  logger: IScopedLogger,
  now: () => number,
): CoreBlocksMigrationPorts {
  return {
    listBlockRows: async () => {
      const rows = await readAllRows(blocks)
      return rows.map((row) => ({ id: row.id, rev: row.rev, data: row.data }))
    },
    replaceBlockRow: async (id, data, ifRev) => {
      await blocks.put({ id, data }, { ifRev })
    },
    now,
    warn: (message, meta) => {
      logger.warn(message, { meta })
    },
  }
}

const OLD_FIELDS = ['pumpIntervalEnabled', 'pumpOnTime', 'pumpOffTime'] as const
const OLD_COMMANDS = ['setPumpInterval', 'setPumpOnMinutes', 'setPumpOffMinutes'] as const

const UNKNOWN: CompositionFieldSource = { kind: 'expression', expr: 'null', bindings: {} }
const NOW: CompositionFieldSource = { kind: 'expression', expr: 'now', bindings: {} }

function without<T>(
  record: Readonly<Record<string, T>>,
  keys: readonly string[],
): Record<string, T> {
  return Object.fromEntries(Object.entries(record).filter(([key]) => !keys.includes(key)))
}

function hasOldShape(feature: CompositionFieldsFeature): boolean {
  const commands = feature.commands ?? {}
  return (
    OLD_FIELDS.some((key) => key in feature.fields) || OLD_COMMANDS.some((key) => key in commands)
  )
}

function cycleFeature(old: CompositionFieldsFeature): CompositionFieldsFeature | null {
  const enabled = old.fields['pumpIntervalEnabled']
  const commands = old.commands ?? {}
  const setEnabled = commands['setPumpInterval']
  const setOn = commands['setPumpOnMinutes']
  const setOff = commands['setPumpOffMinutes']
  if (
    enabled === undefined ||
    setEnabled === undefined ||
    setOn === undefined ||
    setOff === undefined
  )
    return null
  const forwarded: Record<string, CompositionCommandTarget> = {
    setEnabled,
    setOnMinutes: setOn,
    setOffMinutes: setOff,
  }
  return {
    kind: 'fields',
    cap: 'pump-cycle',
    fields: { enabled, onTime: UNKNOWN, offTime: UNKNOWN, lastFetchedAt: NOW },
    commands: forwarded,
  }
}

/** The split composition, or null when this one has nothing to split. */
function splitComposition(composition: Composition): Composition | null {
  if (composition.target.kind !== 'new' || composition.target.type !== DeviceType.PetFountain)
    return null
  const features: Composition['features'] = composition.features.flatMap((feature) => {
    if (feature.kind !== 'fields' || feature.cap !== 'pet-fountain' || !hasOldShape(feature))
      return [feature]
    const core: CompositionFieldsFeature = {
      ...feature,
      fields: without(feature.fields, OLD_FIELDS),
      commands: without(feature.commands ?? {}, OLD_COMMANDS),
    }
    const cycle = cycleFeature(feature)
    return cycle === null ? [core] : [core, cycle]
  })
  const changed =
    features.length !== composition.features.length ||
    features.some((feature, index) => feature !== composition.features[index])
  return changed ? { ...composition, features } : null
}

function splitBlock(block: CoreBlock): CoreBlock | null {
  const source = block.source
  if (source === undefined || source.kind !== 'composition') return null
  const composition = splitComposition(source.composition)
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
  const split = splitBlock(parsed.data)
  if (split === null) return null
  const updatedAt = Math.max(parsed.data.updatedAt + 1, ports.now())
  const next = CoreBlockSchema.safeParse({ ...split, updatedAt })
  if (!next.success) {
    ports.warn('core block left as it is: the split composition does not validate', {
      blockId: row.id,
      error: next.error.message,
    })
    return null
  }
  return { row, data: { ...row.data, updatedAt, block: next.data } }
}

export async function splitPumpCycleFromFountain(
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
