/**
 * The appliance and heater helper compositions become plain Customize
 * compositions (D1004, planning#402 phase 4).
 *
 * A washer, dryer, dishwasher or heater built from the old template stores a
 * compiled composition PLUS the `helper` spec the editor reads. D1004 retires
 * those templates: running, power and the power source are Customize
 * extensions of a plain composed device. This rewrites each stored block so
 * the same device keeps working with no helper:
 *
 *  - `running-state` is recompiled in the Customize catalog format
 *    (`compileScalarOverride`, target `running`) with the SAME threshold and
 *    start and stop dwells, reading the SAME meter;
 *  - `power-meter` is recompiled the same way (target `power`) from the meter;
 *  - an appliance's `power-source` is recompiled (target `switch`) from the SAME
 *    plug, keeping its `offSeconds`;
 *  - a heater's `switch` feature, the read of the plug and the forward of
 *    `setState` to it, is kept exactly as it is;
 *  - a heater with no meter runs while its plug is on (the plug as a `switch`
 *    source, identity): it never used the threshold, so none is stored;
 *  - the `helper` key leaves the composition.
 *
 * The block id, and with it the composed device stableId and the deviceId
 * the device registry holds, never moves, so the history stays attached. Only
 * a `new`-target block with an appliance or heater `helper` is touched; an
 * aggregator helper, a free composition, a customization of an existing device
 * and a block already rewritten (no `helper`) are left as they are, so a rerun
 * edits nothing. A block that IS an appliance or heater helper but cannot be
 * rewritten (it does not parse, or does not compile) THROWS: the migration
 * refuses rather than guess, and the owner does not start.
 */
import {
  type Composition,
  type CompositionFieldSource,
  type CompositionFieldsFeature,
  type CompositionSourceRef,
  compileScalarOverride,
  composedDeviceRef,
  CompositionSchema,
  type CoreBlock,
  CoreBlockSchema,
  type HelperMember,
  HelperMemberSchema,
  type MigrationProcedureResult,
  type ScalarCompileInput,
} from '@camstack/types'
import { z } from 'zod'
import type { CoreBlockRowBody } from '../record-kinds.js'
import type { CoreBlocksMigrationPorts, StoredBlockRow } from './pump-cycle-split.js'

export const HELPER_TO_CUSTOMIZE_ID = 'core-blocks/2026-11-03-helper-to-customize'

/**
 * The documented read-only boundary (D1004 phase 5): the appliance and heater
 * helper templates are deleted from `@camstack/types`, but a stored block can
 * still carry their `helper` spec until this migration has run. These two
 * schemas READ that old shape and nothing else; no live code builds it.
 */
const LegacyApplianceSchema = z.object({
  kind: z.literal('appliance'),
  thresholdWatts: z.number(),
  startDwellMs: z.number(),
  stopDwellMs: z.number(),
  member: HelperMemberSchema,
  powerSwitch: HelperMemberSchema.optional(),
})
const LegacyHeaterSchema = z.object({
  kind: z.literal('heater'),
  plug: HelperMemberSchema,
  meter: HelperMemberSchema.optional(),
  thresholdWatts: z.number(),
  startDwellMs: z.number(),
  stopDwellMs: z.number(),
})
const LegacyHelperSchema = z.discriminatedUnion('kind', [LegacyApplianceSchema, LegacyHeaterSchema])
type RewritableHelper = z.infer<typeof LegacyHelperSchema>

/** A stored block whose composition carries an appliance or heater `helper`, read raw. */
const LegacyHelperBlockSchema = z.looseObject({
  source: z.looseObject({
    kind: z.literal('composition'),
    composition: z.looseObject({ helper: LegacyHelperSchema }),
  }),
})

/** The raw shape of a helper block, enough to refuse one the schema cannot read. */
const RawHelperBlockSchema = z.object({
  source: z.object({
    composition: z.object({
      helper: z.object({ kind: z.enum(['appliance', 'heater']) }),
    }),
  }),
})

function refuse(blockId: string, why: string): never {
  throw new Error(`helper-to-customize: block ${blockId} is not rewritten: ${why}`)
}

function compileOrRefuse(blockId: string, input: ScalarCompileInput): CompositionFieldsFeature {
  const out = compileScalarOverride(input)
  if (!out.ok) return refuse(blockId, `${input.draft.cap}.${input.draft.targetId}: ${out.reason}`)
  return out.value
}

interface MeterInput {
  readonly blockId: string
  readonly device: CompositionSourceRef
  readonly meter: HelperMember
}

function powerMeterFeature(input: MeterInput): CompositionFieldsFeature {
  return compileOrRefuse(input.blockId, {
    draft: {
      kind: 'scalar',
      cap: 'power-meter',
      targetId: 'power',
      source: sourceOf(input.meter),
      transform: { kind: 'identity' },
    },
    device: input.device,
    apply: 'add',
    sourceValueKind: 'number',
    changedAtField: null,
    sourceUnit: 'W',
  })
}

function sourceOf(member: HelperMember) {
  return {
    addonId: member.source.addonId,
    stableId: member.source.stableId,
    cap: member.cap,
    fieldPath: member.fieldPath,
  }
}

interface ThresholdInput extends MeterInput {
  readonly thresholdWatts: number
  readonly startDwellMs: number
  readonly stopDwellMs: number
}

function thresholdRunning(input: ThresholdInput): CompositionFieldsFeature {
  return compileOrRefuse(input.blockId, {
    draft: {
      kind: 'scalar',
      cap: 'running-state',
      targetId: 'running',
      source: sourceOf(input.meter),
      transform: {
        kind: 'threshold',
        comparison: 'gte',
        threshold: input.thresholdWatts,
        startDwellMs: input.startDwellMs,
        stopDwellMs: input.stopDwellMs,
      },
    },
    device: input.device,
    apply: 'add',
    sourceValueKind: 'number',
    changedAtField: null,
    sourceUnit: 'W',
  })
}

function plugRunning(blockId: string, device: CompositionSourceRef, plug: HelperMember) {
  return compileOrRefuse(blockId, {
    draft: {
      kind: 'scalar',
      cap: 'running-state',
      targetId: 'running',
      source: sourceOf(plug),
      transform: { kind: 'identity' },
    },
    device,
    apply: 'add',
    sourceValueKind: 'boolean',
    changedAtField: 'lastChangedAt',
    sourceUnit: null,
  })
}

function powerSourceFeature(
  blockId: string,
  device: CompositionSourceRef,
  plug: HelperMember,
  original: CompositionFieldsFeature,
): CompositionFieldsFeature {
  const compiled = compileOrRefuse(blockId, {
    draft: {
      kind: 'scalar',
      cap: 'power-source',
      targetId: 'switch',
      source: sourceOf(plug),
      transform: { kind: 'identity' },
    },
    device,
    apply: 'add',
    sourceValueKind: 'boolean',
    changedAtField: null,
    sourceUnit: null,
  })
  const offSeconds: CompositionFieldSource | undefined = original.fields['offSeconds']
  if (offSeconds === undefined) return refuse(blockId, 'its power-source has no offSeconds')
  return { ...compiled, fields: { ...compiled.fields, offSeconds } }
}

type Replacements = Readonly<Record<string, CompositionFieldsFeature>>

function replacementsOf(
  blockId: string,
  composition: Composition,
  helper: RewritableHelper,
): Replacements {
  const device = composedDeviceRef(blockId)
  if (helper.kind === 'appliance') {
    const base: Record<string, CompositionFieldsFeature> = {
      'running-state': thresholdRunning({
        blockId,
        device,
        meter: helper.member,
        thresholdWatts: helper.thresholdWatts,
        startDwellMs: helper.startDwellMs,
        stopDwellMs: helper.stopDwellMs,
      }),
      'power-meter': powerMeterFeature({ blockId, device, meter: helper.member }),
    }
    if (helper.powerSwitch === undefined) return base
    const original = composition.features.find((f) => f.cap === 'power-source')
    if (original === undefined || original.kind !== 'fields')
      return refuse(blockId, 'the helper names a power plug but no power-source feature is stored')
    return {
      ...base,
      'power-source': powerSourceFeature(blockId, device, helper.powerSwitch, original),
    }
  }
  const meter = helper.meter
  if (meter === undefined) return { 'running-state': plugRunning(blockId, device, helper.plug) }
  return {
    'running-state': thresholdRunning({
      blockId,
      device,
      meter,
      thresholdWatts: helper.thresholdWatts,
      startDwellMs: helper.startDwellMs,
      stopDwellMs: helper.stopDwellMs,
    }),
    'power-meter': powerMeterFeature({ blockId, device, meter }),
  }
}

function rewriteComposition(
  blockId: string,
  composition: Composition,
  helper: RewritableHelper,
): Composition {
  if (composition.target.kind !== 'new')
    return refuse(blockId, 'a helper that targets an existing device')
  const replacements = replacementsOf(blockId, composition, helper)
  const seen = new Set<string>()
  const features = composition.features.map((feature) => {
    const replacement = replacements[feature.cap]
    if (replacement === undefined) return feature
    seen.add(feature.cap)
    return replacement
  })
  const missing = Object.keys(replacements).filter((cap) => !seen.has(cap))
  if (missing.length > 0)
    return refuse(blockId, `no stored ${missing.join(', ')} feature to rewrite`)
  const parsed = CompositionSchema.safeParse({ ...composition, features })
  if (!parsed.success)
    return refuse(blockId, `the rewritten composition is invalid: ${parsed.error.message}`)
  return parsed.data
}

interface Rewrite {
  readonly row: StoredBlockRow
  readonly data: CoreBlockRowBody
}

interface LegacyHelperBlock {
  readonly helper: RewritableHelper
  /** The stored block with its `helper` spec taken out: the live schema reads it. */
  readonly withoutHelper: unknown
}

/** `null` when the row holds no appliance or heater helper; throws when it holds one it cannot read. */
function legacyHelperOf(row: StoredBlockRow): LegacyHelperBlock | null {
  if (!RawHelperBlockSchema.safeParse(row.data.block).success) return null
  const envelope = LegacyHelperBlockSchema.safeParse(row.data.block)
  if (!envelope.success)
    return refuse(row.id, `the stored helper spec does not parse: ${envelope.error.message}`)
  const { helper, ...composition } = envelope.data.source.composition
  return {
    helper,
    withoutHelper: { ...envelope.data, source: { ...envelope.data.source, composition } },
  }
}

function rewriteOf(row: StoredBlockRow, ports: CoreBlocksMigrationPorts): Rewrite | null {
  const legacy = legacyHelperOf(row)
  if (legacy === null) return null
  const parsed = CoreBlockSchema.safeParse(legacy.withoutHelper)
  if (!parsed.success)
    return refuse(row.id, `the stored block does not parse: ${parsed.error.message}`)
  const block: CoreBlock = parsed.data
  if (block.source === undefined || block.source.kind !== 'composition')
    return refuse(row.id, 'the helper block has no composition source')
  const composition = rewriteComposition(row.id, block.source.composition, legacy.helper)
  const updatedAt = Math.max(block.updatedAt + 1, ports.now())
  const next = CoreBlockSchema.safeParse({
    ...block,
    source: { kind: 'composition', composition },
    updatedAt,
  })
  if (!next.success) return refuse(row.id, `the rewritten block is invalid: ${next.error.message}`)
  return { row, data: { ...row.data, updatedAt, block: next.data } }
}

export async function rewriteHelpersToCustomize(
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
