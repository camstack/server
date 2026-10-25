/**
 * Unified event-kind taxonomy — THE single source of truth for
 * `kind → { parentKind, category, level, color, iconId, labelKey, label,
 * icon }`.
 *
 * This dictionary folds together what used to be scattered across four
 * copies:
 *   - `capabilities/sensor-event-kinds.ts` (sensor cap colors)
 *   - `addon-post-analysis/.../services/event-kinds.ts`
 *     (MOTION/PERSON/VEHICLE… _COLOR constants)
 *   - `ui-library/composites/detection-colors.ts` (CLASS_COLORS)
 *   - `addon-post-analysis/shared/frame/box-drawer.ts` (DEFAULT_COLOR)
 *   - the COCO / audio class maps (macro ↔ sub relationships)
 *
 * The DATA (serializable — parentKind / iconId / labelKey) lives here in
 * `@camstack/types`. Colour is NOT a second table: each entry's `color` is
 * the bundled CamStack display palette (D939). The effective cluster palette
 * is the `display-palette` capability. The UI-side mapping `iconId → lucide
 * component` and `labelKey → t()` lives in `@camstack/ui-library`.
 *
 * Two levels only (v1 YAGNI): macro → sub. `person` is a leaf macro.
 */
import { COCO_TO_MACRO } from './coco-classmap.js'
import { AUDIO_MACRO_LABELS } from './audio-classmap.js'
import { bundledCamstack, paintHex } from './display-palette.js'

// ── Category / level vocab ──────────────────────────────────────────

export type EventTaxonomyCategory =
  | 'motion'
  | 'audio'
  | 'detection'
  | 'sensor'
  | 'control'
  | 'package'
  | 'custom'

export type EventTaxonomyLevel = 'macro' | 'sub'

/**
 * The static, serializable half of an event kind. Descriptors surfaced by
 * `listEventKinds` extend this with a per-device `source`.
 */
export interface EventTaxonomyEntry {
  /** Unique kind id ('vehicle', 'car', 'lock', 'audio-dog', …). */
  readonly kind: string
  /** Macro parent ('car' → 'vehicle'); null for a macro. */
  readonly parentKind: string | null
  /** Derived from `parentKind` — explicit for the UI. */
  readonly level: EventTaxonomyLevel
  readonly category: EventTaxonomyCategory
  /** Hex color for timeline/legend rendering. */
  readonly color: string
  /** Dictionary id → lucide component on the UI side. */
  readonly iconId: string
  /** i18n key; `label` is the English fallback. */
  readonly labelKey: string
  /** English fallback label (UI translates `labelKey` when it can). */
  readonly label: string
}

// ── Bundled palette colour (the default preset, not a second table) ──

const BUNDLED_PALETTE = bundledCamstack()

function kindColor(kind: string): string {
  return paintHex(BUNDLED_PALETTE.swatches, BUNDLED_PALETTE.fallbacks, kind)
}

function firstFallback(fallbacks: readonly string[]): string {
  const hex = fallbacks[0]
  if (hex === undefined) {
    throw new Error('display palette has no fallback colour')
  }
  return hex
}

/** Global default when a kind is unknown — the palette's first fallback. */
export const DEFAULT_EVENT_COLOR: string = firstFallback(BUNDLED_PALETTE.fallbacks)

function titleCase(id: string): string {
  return id
    .split(/[-_ ]/)
    .filter((p) => p.length > 0)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(' ')
}

// ── Builder ─────────────────────────────────────────────────────────

const entries = new Map<string, EventTaxonomyEntry>()

function macro(kind: string, category: EventTaxonomyCategory, iconId: string, label: string): void {
  entries.set(kind, {
    kind,
    parentKind: null,
    level: 'macro',
    category,
    color: kindColor(kind),
    iconId,
    labelKey: `eventKind.${kind}`,
    label,
  })
}

function sub(
  kind: string,
  parentKind: string,
  category: EventTaxonomyCategory,
  iconId: string,
  label: string,
): void {
  entries.set(kind, {
    kind,
    parentKind,
    level: 'sub',
    category,
    color: kindColor(kind),
    iconId,
    labelKey: `eventKind.${kind}`,
    label,
  })
}

// Macros (timeline lanes).
macro('motion', 'motion', 'motion', 'Motion')
macro('audio', 'audio', 'audio', 'Audio')
macro('person', 'detection', 'person', 'Person')
macro('vehicle', 'detection', 'vehicle', 'Vehicle')
macro('animal', 'detection', 'animal', 'Animal')
macro('package', 'package', 'package', 'Package')
macro('sensor', 'sensor', 'sensor', 'Sensor')
macro('control', 'control', 'control', 'Control')

// Detection subs — derived from the reverse of COCO_TO_MACRO so the tree
// stays in sync with the class map. Only the vehicle / animal macros carry
// leaf subs (person is a leaf macro; package subs are event types below).
for (const [cocoClass, macroClass] of Object.entries(COCO_TO_MACRO.mapping)) {
  if (macroClass !== 'vehicle' && macroClass !== 'animal') continue
  if (entries.has(cocoClass)) continue
  sub(cocoClass, macroClass, 'detection', cocoClass, titleCase(cocoClass))
}

// Package event types (modelled as subs so the tree groups them under the
// package macro). Delivered / picked-up are gated by the package zone rule.
sub('package-delivered', 'package', 'package', 'package', 'Package delivered')
sub('package-picked-up', 'package', 'package', 'package', 'Package picked up')

// Sensor subs (passive) — linked-device kinds.
sub('contact', 'sensor', 'sensor', 'door', 'Contact')
sub('motion-sensor', 'sensor', 'sensor', 'pir', 'Motion sensor')
sub('smoke', 'sensor', 'sensor', 'smoke', 'Smoke')
sub('flood', 'sensor', 'sensor', 'water', 'Water leak')
sub('gas', 'sensor', 'sensor', 'gas', 'Gas')
sub('carbon-monoxide', 'sensor', 'sensor', 'smoke', 'Carbon monoxide')
sub('vibration', 'sensor', 'sensor', 'vibration', 'Vibration')
sub('tamper', 'sensor', 'sensor', 'tamper', 'Tamper')
sub('presence', 'sensor', 'sensor', 'presence', 'Presence')
sub('enum-sensor', 'sensor', 'sensor', 'generic', 'Sensor state')
sub('device-event', 'sensor', 'sensor', 'button', 'Device event')

// Control subs (actuators).
sub('lock', 'control', 'control', 'lock', 'Lock')
// A cover (shutter, garage door, gate) is eventful so an opening reaches the
// alarm (D630). `door` is the existing glyph closest to it; a cover linked to a
// camera writes one sensor-event row per state change on that timeline.
sub('cover', 'control', 'control', 'door', 'Cover')
sub('switch', 'control', 'control', 'switch', 'Switch')
sub('siren', 'control', 'control', 'siren', 'Siren')
sub('button', 'control', 'control', 'button', 'Button')
sub('doorbell', 'control', 'control', 'doorbell', 'Doorbell')

// Audio subs — derived from the audio classifier macro vocabulary. Namespaced
// (`audio-<id>`) so ids never collide with detection subs (dog/cat/bird/…).
// They share the audio gradient; they are not their own colours (D939).
for (const l of AUDIO_MACRO_LABELS) {
  const kind = `audio-${l.id}`
  if (entries.has(kind)) continue
  sub(kind, 'audio', 'audio', kind, l.name)
}

/** The complete taxonomy dictionary, keyed by kind. */
export const EVENT_TAXONOMY: Readonly<Record<string, EventTaxonomyEntry>> = Object.freeze(
  Object.fromEntries(entries),
)

// ── Lookups ─────────────────────────────────────────────────────────

/** Taxonomy entry for a kind, or undefined when unknown. */
export function getTaxonomyEntry(kind: string): EventTaxonomyEntry | undefined {
  return EVENT_TAXONOMY[kind]
}

/** Color for a kind — the bundled palette, else a stable fallback. */
export function colorForKind(kind: string): string {
  return kindColor(kind)
}

/** The sub kinds whose `parentKind` is `macro` (empty for a leaf macro). */
export function subKindsOf(macro: string): readonly EventTaxonomyEntry[] {
  const out: EventTaxonomyEntry[] = []
  for (const e of Object.values(EVENT_TAXONOMY)) {
    if (e.parentKind === macro) out.push(e)
  }
  return out
}
