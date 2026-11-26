/**
 * A power source, a lock door sensor and a follow-switch opt-out name their kind (D1098).
 *
 * Before, each was recognised only by the SHAPE of a stored fields feature: cap `power-source`,
 * cap `lock-control` with a `state` expression reading a source as `x`, and a disabled
 * `running-state` feature with no field. The feature now carries `customizeKind`, and the
 * readers (`powerSourceLinkOfComposition`, `lockDoorLinkOfComposition`, `isRunningOptOut`)
 * require it: there is no second reader for the old shape, so this step is the only thing
 * that carries a stored composition across.
 *
 * Each block is rewritten once: a feature that already names a kind is left exactly as it is,
 * and a block with nothing to stamp is not written, so a rerun edits nothing. The block's
 * `updatedAt` moves (it is the version an editor's `expectedUpdatedAt` is checked against);
 * every other field, the name and the enabled flag included, is kept.
 */
import {
  type Composition,
  type CompositionCustomizeKind,
  type CompositionFeature,
  type CoreBlock,
  CoreBlockSchema,
  type MigrationProcedureResult,
} from '@camstack/types'
import type { CoreBlockRowBody } from '../record-kinds.js'
import type { CoreBlocksMigrationPorts, StoredBlockRow } from './pump-cycle-split.js'

export const CUSTOMIZE_KIND_DISCRIMINANT_ID = 'core-blocks/2026-11-26-customize-kind-discriminant'

/** The kind the OLD shape of `feature` stood for, or null when it is none of the three. */
function kindOfOldShape(feature: CompositionFeature): CompositionCustomizeKind | null {
  if (feature.kind !== 'fields' || feature.customizeKind !== undefined) return null
  if (feature.cap === 'power-source') return 'power-source'
  if (feature.cap === 'lock-control') {
    const state = feature.fields['state']
    const x = state?.kind === 'expression' ? state.bindings['x'] : undefined
    return x !== undefined && x.kind === 'from' ? 'lock-door-sensor' : null
  }
  if (
    feature.cap === 'running-state' &&
    feature.enabled === false &&
    Object.keys(feature.fields).length === 0
  ) {
    return 'follow-switch'
  }
  return null
}

function stampComposition(composition: Composition): Composition | null {
  let changed = false
  const features = composition.features.map((feature): CompositionFeature => {
    const kind = kindOfOldShape(feature)
    if (kind === null || feature.kind !== 'fields') return feature
    changed = true
    return { ...feature, customizeKind: kind }
  })
  return changed ? { ...composition, features } : null
}

function stampBlock(block: CoreBlock): CoreBlock | null {
  const source = block.source
  if (source === undefined || source.kind !== 'composition') return null
  const composition = stampComposition(source.composition)
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
  const stamped = stampBlock(parsed.data)
  if (stamped === null) return null
  const updatedAt = Math.max(parsed.data.updatedAt + 1, ports.now())
  const next = CoreBlockSchema.safeParse({ ...stamped, updatedAt })
  if (!next.success) {
    ports.warn('core block left as it is: the stamped composition does not validate', {
      blockId: row.id,
      error: next.error.message,
    })
    return null
  }
  return { row, data: { ...row.data, updatedAt, block: next.data } }
}

export async function stampCustomizeKinds(
  ports: CoreBlocksMigrationPorts,
): Promise<MigrationProcedureResult> {
  const rows = await ports.listBlockRows()
  const rewrites = rows.flatMap((row) => {
    const rewrite = rewriteOf(row, ports)
    return rewrite === null ? [] : [rewrite]
  })
  if (rewrites.length === 0) return { outcome: 'already-done', summary: { blocks: 0 } }
  for (const { row, data } of rewrites) await ports.replaceBlockRow(row.id, data, row.rev)
  ports.info('customize kinds stamped on stored compositions', { blocks: rewrites.length })
  return { outcome: 'done', summary: { blocks: rewrites.length } }
}
