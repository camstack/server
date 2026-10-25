/**
 * The display palette (D939). One table of colours, three presets, one
 * validator. Taxonomy colours and every consumer read this — there is no
 * second hex table.
 */
import { z } from 'zod'
import {
  AUDIO_ENTRY_ID,
  AUDIO_GRADIENT_ALPHAS,
  AUDIO_LEAF_PREFIX,
  PALETTE_ENTRY_IDS,
  PALETTE_FALLBACK_COUNT,
  PALETTE_PRESET_IDS,
  isPaletteEntryId,
  isPalettePresetId,
  type PalettePresetId,
} from './palette-entries.js'
import {
  PALETTE_BACKGROUNDS,
  PALETTE_MARK_PAIR,
  PALETTE_MIN_CONTRAST,
  PALETTE_MIN_DELTA_E,
  PALETTE_MIN_DELTA_E_MARK,
  type PaletteBackground,
  contrastRatio,
  deltaE00,
} from './palette-cie.js'
import {
  CAMSTACK_FALLBACK,
  CAMSTACK_HEX,
  HIGH_CONTRAST_FALLBACK,
  HIGH_CONTRAST_HEX,
  OKABE_ITO_FALLBACK,
  OKABE_ITO_HEX,
} from './display-palette-tables.js'

export {
  AUDIO_GRADIENT_ALPHAS,
  PALETTE_BACKGROUNDS,
  PALETTE_ENTRY_IDS,
  PALETTE_MIN_CONTRAST,
  PALETTE_MIN_DELTA_E,
  PALETTE_MIN_DELTA_E_MARK,
  PALETTE_PRESET_IDS,
}
export type { PaletteBackground } from './palette-cie.js'
export type { PaletteEntryId, PalettePresetId } from './palette-entries.js'

export const paletteHexSchema = z.string().regex(/^#[0-9a-f]{6}$/)

export const paletteSolidSchema = z.object({
  form: z.literal('solid'),
  hex: paletteHexSchema,
})

export const paletteGradientSchema = z.object({
  form: z.literal('gradient'),
  hex: paletteHexSchema,
  alphas: z.array(z.number().gt(0).lte(1)).length(AUDIO_GRADIENT_ALPHAS.length),
})

export const paletteSwatchSchema = z.discriminatedUnion('form', [
  paletteSolidSchema,
  paletteGradientSchema,
])

export type PaletteSwatch = z.infer<typeof paletteSwatchSchema>
export type PaletteSwatchMap = Readonly<Record<string, PaletteSwatch>>

export type PaletteViolation =
  | {
      readonly code: 'too-close'
      readonly left: string
      readonly right: string
      readonly deltaE: number
    }
  | {
      readonly code: 'low-contrast'
      readonly entry: string
      readonly background: PaletteBackground
      readonly contrast: number
    }
  | { readonly code: 'missing-entry'; readonly entry: string }
  | { readonly code: 'unknown-entry'; readonly entry: string }
  | { readonly code: 'bad-gradient'; readonly entry: string }
  | { readonly code: 'bad-fallbacks' }
  | { readonly code: 'unknown-preset'; readonly presetId: string }

export type PaletteVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly violations: readonly PaletteViolation[] }

export const paletteReadySchema = z.object({
  status: z.literal('ready'),
  presetId: z.enum(PALETTE_PRESET_IDS),
  customized: z.boolean(),
  source: z.enum(['stored', 'unconfigured']),
  swatches: z.record(z.string(), paletteSwatchSchema),
  fallbacks: z.array(paletteHexSchema).length(PALETTE_FALLBACK_COUNT),
})

export const paletteUnknownSchema = z.object({
  status: z.literal('unknown'),
  reason: z.string(),
})

export const paletteResultSchema = z.discriminatedUnion('status', [
  paletteReadySchema,
  paletteUnknownSchema,
])

export type PaletteResult = z.infer<typeof paletteResultSchema>
export type PaletteReady = z.infer<typeof paletteReadySchema>

export const setPaletteInputSchema = z.union([
  z.object({ presetId: z.string() }),
  z.object({
    presetId: z.string(),
    overrides: z.record(z.string(), paletteSwatchSchema),
  }),
])

export type SetPaletteInput = z.infer<typeof setPaletteInputSchema>

export const storedPaletteSchema = z.object({
  presetId: z.string(),
  overrides: z.record(z.string(), paletteSwatchSchema),
})

export type StoredPalette = z.infer<typeof storedPaletteSchema>

export interface DisplayPreset {
  readonly id: PalettePresetId
  readonly name: string
  readonly swatches: PaletteSwatchMap
  readonly fallbacks: readonly string[]
}

function solid(hex: string): PaletteSwatch {
  return { form: 'solid', hex }
}

function audioGradient(hex: string): PaletteSwatch {
  return { form: 'gradient', hex, alphas: [...AUDIO_GRADIENT_ALPHAS] }
}

function swatchesFrom(hexes: Readonly<Record<string, string>>): PaletteSwatchMap {
  const out: Record<string, PaletteSwatch> = {}
  for (const id of PALETTE_ENTRY_IDS) {
    const hex = hexes[id]
    if (hex === undefined) throw new Error(`palette table missing ${id}`)
    out[id] = id === AUDIO_ENTRY_ID ? audioGradient(hex) : solid(hex)
  }
  return out
}

function preset(
  id: PalettePresetId,
  name: string,
  hexes: Readonly<Record<string, string>>,
  fallbacks: readonly string[],
): DisplayPreset {
  return { id, name, swatches: swatchesFrom(hexes), fallbacks }
}

export const DISPLAY_PRESETS: readonly DisplayPreset[] = [
  preset('camstack', 'CamStack', CAMSTACK_HEX, CAMSTACK_FALLBACK),
  preset('high-contrast', 'High contrast', HIGH_CONTRAST_HEX, HIGH_CONTRAST_FALLBACK),
  preset('okabe-ito', 'Colour-blind safe', OKABE_ITO_HEX, OKABE_ITO_FALLBACK),
]

export function presetById(id: string): DisplayPreset | undefined {
  return DISPLAY_PRESETS.find((item) => item.id === id)
}

export function bundledCamstack(): PaletteReady {
  const presetRow = presetById('camstack')
  if (presetRow === undefined) throw new Error('CamStack preset missing')
  return readyOf(presetRow, 'unconfigured', false)
}

function readyOf(
  row: DisplayPreset,
  source: PaletteReady['source'],
  customized: boolean,
): PaletteReady {
  return {
    status: 'ready',
    presetId: row.id,
    customized,
    source,
    swatches: row.swatches,
    fallbacks: [...row.fallbacks],
  }
}

export function swatchHex(swatch: PaletteSwatch): string {
  return swatch.hex
}

interface NamedHex {
  readonly name: string
  readonly hex: string
}

function namedColours(
  swatches: PaletteSwatchMap,
  fallbacks: readonly string[],
): readonly NamedHex[] {
  const rows: NamedHex[] = []
  for (const id of PALETTE_ENTRY_IDS) {
    const swatch = swatches[id]
    if (swatch !== undefined) rows.push({ name: id, hex: swatch.hex })
  }
  fallbacks.forEach((hex, index) => {
    rows.push({ name: `fallback-${index}`, hex })
  })
  return rows
}

function gradientViolations(swatches: PaletteSwatchMap): PaletteViolation[] {
  const audio = swatches[AUDIO_ENTRY_ID]
  if (audio === undefined) return []
  if (audio.form !== 'gradient') return [{ code: 'bad-gradient', entry: AUDIO_ENTRY_ID }]
  const same = AUDIO_GRADIENT_ALPHAS.every((alpha, index) => audio.alphas[index] === alpha)
  return same ? [] : [{ code: 'bad-gradient', entry: AUDIO_ENTRY_ID }]
}

function isMarkPair(left: string, right: string): boolean {
  const marks: readonly string[] = PALETTE_MARK_PAIR
  return marks.includes(left) && marks.includes(right)
}

/** Refuse a palette whose entries are not pairwise distinct on both themes. */
export function validatePalette(
  swatches: PaletteSwatchMap,
  fallbacks: readonly string[],
): PaletteVerdict {
  const violations: PaletteViolation[] = []
  for (const id of PALETTE_ENTRY_IDS) {
    if (swatches[id] === undefined) violations.push({ code: 'missing-entry', entry: id })
  }
  for (const key of Object.keys(swatches)) {
    if (!isPaletteEntryId(key)) violations.push({ code: 'unknown-entry', entry: key })
  }
  if (fallbacks.length !== PALETTE_FALLBACK_COUNT) violations.push({ code: 'bad-fallbacks' })
  violations.push(...gradientViolations(swatches))
  const rows = namedColours(swatches, fallbacks)
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      const left = rows[i]
      const right = rows[j]
      if (left === undefined || right === undefined) continue
      const deltaE = deltaE00(left.hex, right.hex)
      const markPair = isMarkPair(left.name, right.name)
      const floor = markPair ? PALETTE_MIN_DELTA_E_MARK : PALETTE_MIN_DELTA_E
      if (deltaE < floor) {
        violations.push({ code: 'too-close', left: left.name, right: right.name, deltaE })
      }
    }
  }
  for (const row of rows) {
    for (const background of ['dark', 'light'] as const) {
      const contrast = contrastRatio(row.hex, PALETTE_BACKGROUNDS[background])
      if (contrast < PALETTE_MIN_CONTRAST) {
        violations.push({ code: 'low-contrast', entry: row.name, background, contrast })
      }
    }
  }
  return violations.length === 0 ? { ok: true } : { ok: false, violations }
}

export function formatPaletteViolation(violation: PaletteViolation): string {
  switch (violation.code) {
    case 'too-close':
      return `${violation.left} vs ${violation.right} (ΔE ${violation.deltaE.toFixed(1)})`
    case 'low-contrast':
      return `${violation.entry} on ${violation.background} (${violation.contrast.toFixed(1)}:1)`
    case 'missing-entry':
      return `${violation.entry} is missing`
    case 'unknown-entry':
      return `${violation.entry} is not a palette entry`
    case 'bad-gradient':
      return `${violation.entry} gradient is not the six canonical steps`
    case 'bad-fallbacks':
      return 'fallback list must hold eight colours'
    case 'unknown-preset':
      return `${violation.presetId} is not a preset`
  }
}

export function formatPaletteViolations(violations: readonly PaletteViolation[]): string {
  return violations.map(formatPaletteViolation).join('; ')
}

export class PaletteRejectedError extends Error {
  readonly violations: readonly PaletteViolation[]

  constructor(violations: readonly PaletteViolation[]) {
    super(formatPaletteViolations(violations))
    this.name = 'PaletteRejectedError'
    this.violations = violations
  }
}

function hashFallback(kind: string, fallbacks: readonly string[]): string {
  let hash = 0
  for (let i = 0; i < kind.length; i++) {
    hash = (hash * 31 + (kind.codePointAt(i) ?? 0)) >>> 0
  }
  const hex = fallbacks[hash % fallbacks.length]
  if (hex === undefined) {
    throw new Error('display palette has no fallback colour')
  }
  return hex
}

/** Colour a kind paints with. Audio leaves share the audio gradient's hex. */
export function paintHex(
  swatches: PaletteSwatchMap,
  fallbacks: readonly string[],
  kind: string,
): string {
  const key = kind.trim().toLowerCase()
  if (key.startsWith(AUDIO_LEAF_PREFIX)) {
    const audio = swatches[AUDIO_ENTRY_ID]
    return audio !== undefined ? audio.hex : hashFallback(key, fallbacks)
  }
  const direct = swatches[key]
  if (direct !== undefined) return direct.hex
  return hashFallback(key, fallbacks)
}

export function mergeOverrides(
  base: PaletteSwatchMap,
  overrides: Readonly<Record<string, PaletteSwatch>>,
): PaletteSwatchMap {
  return { ...base, ...overrides }
}

function overridesOf(input: SetPaletteInput): Readonly<Record<string, PaletteSwatch>> {
  return 'overrides' in input ? input.overrides : {}
}

/** The palette a `setPalette` input would store. Invalid input is a refusal. */
export function paletteFromInput(input: SetPaletteInput): PaletteReady {
  const row = presetById(input.presetId)
  if (row === undefined || !isPalettePresetId(input.presetId)) {
    throw new PaletteRejectedError([{ code: 'unknown-preset', presetId: input.presetId }])
  }
  const overrides = overridesOf(input)
  const swatches = mergeOverrides(row.swatches, overrides)
  const verdict = validatePalette(swatches, row.fallbacks)
  if (!verdict.ok) throw new PaletteRejectedError(verdict.violations)
  const customized = Object.keys(overrides).length > 0
  return {
    status: 'ready',
    presetId: row.id,
    customized,
    source: 'stored',
    swatches,
    fallbacks: [...row.fallbacks],
  }
}

function isEmptyRecord(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 0
  )
}

/**
 * Interpret a settings blob. A missing row is the bundled preset and says so.
 * A blob that does not parse, names an unknown preset, or fails the rule is
 * `unknown` — never the default wearing the stored preset's name.
 */
export function paletteFromStored(value: unknown): PaletteResult {
  if (value === undefined || value === null || isEmptyRecord(value)) return bundledCamstack()
  const parsed = storedPaletteSchema.safeParse(value)
  if (!parsed.success) {
    return { status: 'unknown', reason: 'stored palette is unreadable' }
  }
  const row = presetById(parsed.data.presetId)
  if (row === undefined) {
    return { status: 'unknown', reason: `unknown preset ${parsed.data.presetId}` }
  }
  const swatches = mergeOverrides(row.swatches, parsed.data.overrides)
  const verdict = validatePalette(swatches, row.fallbacks)
  if (!verdict.ok) {
    return { status: 'unknown', reason: formatPaletteViolations(verdict.violations) }
  }
  const customized = Object.keys(parsed.data.overrides).length > 0
  return {
    status: 'ready',
    presetId: row.id,
    customized,
    source: 'stored',
    swatches,
    fallbacks: [...row.fallbacks],
  }
}

export function storedFromReady(
  ready: PaletteReady,
  overrides: Readonly<Record<string, PaletteSwatch>>,
): StoredPalette {
  return { presetId: ready.presetId, overrides: { ...overrides } }
}
