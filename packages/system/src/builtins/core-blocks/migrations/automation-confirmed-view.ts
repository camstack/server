/**
 * Stored generated automations move to the CONFIRMED view (D1061).
 *
 * An automation generated before D1061 read a device's slice in the effective
 * view: a command the hub still holds read as already done, so a condition on
 * it could pass before the device acted. The generator now asks for the
 * device's word. This regenerates each stored automation from the recipe its
 * code embeds (`AUTOMATION_RECIPE`), exactly as saving it in the editor would.
 *
 * Only code that is still what the generator writes is regenerated: its body
 * (the recipe literal blanked, as `instanceCodeHash` reads it) must equal what
 * the generator wrote before D1061 for that same recipe. Code edited by hand,
 * or written by a generator older than the one before D1061, is left exactly
 * as it is and logged per automation: regenerating it would lose what it does
 * differently. A hand-written script (no recipe) is not an automation here.
 * A rerun finds every regenerated automation already current and edits nothing.
 */
import {
  type CoreBlock,
  CoreBlockSchema,
  generateAutomationBlock,
  instanceCodeHash,
  type MigrationProcedureResult,
  readRecipeLiteral,
  resolveCoreBlockEntry,
} from '@camstack/types'
import type { CoreBlockRowBody } from '../record-kinds.js'
import type { CoreBlocksMigrationPorts, StoredBlockRow } from './pump-cycle-split.js'

export const AUTOMATION_CONFIRMED_VIEW_ID = 'core-blocks/2026-11-17-automation-confirmed-view'

/** What D1061 changed in the generated code: [before, after]. */
const D1061_EDITS: readonly (readonly [string, string])[] = [
  [
    'ctx.api.deviceState.getCapSlice.query({ deviceId, capName: cap })',
    'ctx.api.deviceState.getCapSlice.query({ deviceId, capName: cap, confirmed: true })',
  ],
  [
    "          mirror.apply(deviceId, capName, data['slice'])\n" +
      "          guardMirror.apply(deviceId, capName, data['slice'])",
    '          // what the device reported: a held command is never a condition (D1061)\n' +
      "          const slice = data['confirmed'] ?? data['slice']\n" +
      '          mirror.apply(deviceId, capName, slice)\n' +
      '          guardMirror.apply(deviceId, capName, slice)',
  ],
]

/** The code the generator wrote for the same recipe before D1061. */
export function beforeConfirmedView(current: string): string {
  return D1061_EDITS.reduce((code, [before, after]) => code.split(after).join(before), current)
}

/** What happened to one stored automation. */
type Verdict =
  | { readonly kind: 'skip' }
  | { readonly kind: 'regenerate'; readonly code: string }
  | { readonly kind: 'leave'; readonly reason: string }

function verdictOf(block: CoreBlock): Verdict {
  const read = readRecipeLiteral(block.code)
  if (read.status === 'none') return { kind: 'skip' }
  if (read.status === 'invalid')
    return { kind: 'leave', reason: `its recipe does not read: ${read.detail}` }
  const fresh = generateAutomationBlock({ name: block.name, recipe: read.recipe })
  const stored = instanceCodeHash(block.code)
  if (stored === instanceCodeHash(fresh)) return { kind: 'skip' }
  if (stored !== instanceCodeHash(beforeConfirmedView(fresh))) {
    return {
      kind: 'leave',
      reason:
        'the code is not what its recipe generates (edited by hand, or written by an older version); saving it in the editor moves it',
    }
  }
  return { kind: 'regenerate', code: fresh }
}

/** The block with its code (and, multi-file, its entry file) replaced. */
function withCode(block: CoreBlock, code: string, updatedAt: number): CoreBlock {
  if (block.files === undefined) return { ...block, code, updatedAt }
  const entry = resolveCoreBlockEntry(block.entry)
  return { ...block, code, files: { ...block.files, [entry]: code }, updatedAt }
}

interface Rewrite {
  readonly row: StoredBlockRow
  readonly data: CoreBlockRowBody
}

function rewriteOf(row: StoredBlockRow, ports: CoreBlocksMigrationPorts): Rewrite | null {
  const parsed = CoreBlockSchema.safeParse(row.data.block)
  if (!parsed.success) return null
  const block = parsed.data
  const verdict = verdictOf(block)
  if (verdict.kind === 'skip') return null
  if (verdict.kind === 'leave') {
    ports.warn('automation left as it was: not moved to the confirmed view', {
      blockId: row.id,
      name: block.name,
      reason: verdict.reason,
    })
    return null
  }
  const updatedAt = Math.max(block.updatedAt + 1, ports.now())
  const next = CoreBlockSchema.safeParse(withCode(block, verdict.code, updatedAt))
  if (!next.success) {
    ports.warn('automation left as it was: the regenerated block does not validate', {
      blockId: row.id,
      name: block.name,
      reason: next.error.message,
    })
    return null
  }
  return { row, data: { ...row.data, updatedAt, block: next.data } }
}

export async function regenerateAutomationsConfirmedView(
  ports: CoreBlocksMigrationPorts,
): Promise<MigrationProcedureResult> {
  const rows = await ports.listBlockRows()
  const rewrites = rows.flatMap((row) => {
    const rewrite = rewriteOf(row, ports)
    return rewrite === null ? [] : [rewrite]
  })
  if (rewrites.length === 0) return { outcome: 'already-done', summary: { automations: 0 } }
  let regenerated = 0
  for (const { row, data } of rewrites) {
    try {
      await ports.replaceBlockRow(row.id, data, row.rev)
    } catch (error: unknown) {
      ports.warn('automation left as it was: the regenerated code could not be saved', {
        blockId: row.id,
        name: data.name,
        reason: error instanceof Error ? error.message : String(error),
      })
      continue
    }
    regenerated += 1
    ports.info('automation regenerated: it reads the confirmed view (D1061)', {
      blockId: row.id,
      name: data.name,
    })
  }
  return { outcome: 'done', summary: { automations: regenerated } }
}
