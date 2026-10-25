/**
 * Pure helpers for the OSD Manager page — no React, no I/O. Kept separate
 * from the components so the operator-facing logic (which cameras are
 * pickable, what a fresh binding looks like, how a render outcome reads)
 * is unit-testable without mounting anything.
 */
import { translate } from '../i18n/index.js'
import {
  type NcConditions,
  type OsdRenderOutcome,
  type OsdSlotBinding,
  type OsdSlotView,
  type OsdSource,
  type OsdSourceOption,
} from '@camstack/types'

export interface CameraOption {
  readonly id: number
  readonly name: string
}

/** One camera row on the OSD Manager table (list + accordion detail). */
export interface OsdCameraRow {
  readonly id: number
  readonly name: string
  readonly supportsOsd: boolean
}

/** A fresh, unsaved binding draft — the form's starting point for an unbound slot. */
export function emptyBindingDraft(): OsdSlotBinding {
  return {
    enabled: true,
    source: { kind: 'none' },
    template: '${value}',
    maxDecimals: 1,
  }
}

/** Camera slot dialog content tab — Layer (incl. Preview) | Binding. */
export type SlotContentPanel = 'layer' | 'binding'

/** Parse `?panel=` for the camera slot editor; unknown / absent → layer. */
export function parseSlotContentPanel(raw: string | null): SlotContentPanel {
  return raw === 'binding' ? 'binding' : 'layer'
}

/** Named-template dialog content tab. */
export type TemplateContentPanel = 'template' | 'bindings'

/** Parse `?panel=` for the template editor; unknown / absent → template. */
export function parseTemplateContentPanel(raw: string | null): TemplateContentPanel {
  return raw === 'bindings' ? 'bindings' : 'template'
}

/** The draft a slot editor opens with: its saved binding, or a fresh one. */
export function draftForSlot(slot: OsdSlotView): OsdSlotBinding {
  if (slot.binding === null) return emptyBindingDraft()
  if (slot.binding.conditions?.devices === undefined) return slot.binding
  return {
    ...slot.binding,
    conditions: withoutCondition(slot.binding.conditions, 'devices'),
  }
}

/** Structural equality for slot binding drafts (stable JSON round-trip). */
export function slotBindingsEqual(a: OsdSlotBinding, b: OsdSlotBinding): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

export interface DirtySlotBinding {
  readonly slotId: string
  readonly binding: OsdSlotBinding
}

/**
 * Bindings the camera dialog must persist on Save.
 *
 * Unbound slots open as `{ kind: 'none' }` drafts. Persisting those on every
 * Save claimed firmware-only static text and wiped other layers — only slots
 * the operator actually changed (draft ≠ baseline) are written.
 */
export function dirtySlotBindings(
  slotIds: readonly string[],
  drafts: Readonly<Record<string, OsdSlotBinding>>,
  baseline: Readonly<Record<string, OsdSlotBinding>>,
): readonly DirtySlotBinding[] {
  const out: DirtySlotBinding[] = []
  for (const slotId of slotIds) {
    const draft = drafts[slotId]
    if (draft === undefined) continue
    const base = baseline[slotId]
    if (base !== undefined && slotBindingsEqual(draft, base)) continue
    out.push({ slotId, binding: draft })
  }
  return out
}

/** Suggested `valueMap` seed when the operator points a binding at a source. */
export function suggestedValueMap(
  option: OsdSourceOption | undefined,
): Record<string, string> | undefined {
  if (option === undefined) return undefined
  if (option.valueType === 'boolean') return { true: 'ON', false: 'OFF' }
  if (option.valueType === 'enum' && option.enumValues && option.enumValues.length > 0) {
    return Object.fromEntries(option.enumValues.map((v) => [v, v]))
  }
  return undefined
}

function valueMapsEqual(
  a: Record<string, string> | undefined,
  b: Record<string, string> | undefined,
): boolean {
  if (a === b) return true
  if (a === undefined || b === undefined) return false
  const aKeys = Object.keys(a)
  const bKeys = Object.keys(b)
  if (aKeys.length !== bKeys.length) return false
  return aKeys.every((key) => a[key] === b[key])
}

/**
 * Whether a field change may replace `current` with a new `suggestedValueMap`.
 * Empty, identity (raw→raw), or still equal to the previous auto-seed → reseed;
 * a custom operator edit is kept.
 */
export function shouldReseedValueMap(
  current: Record<string, string> | undefined,
  previousSuggested?: Record<string, string> | undefined,
): boolean {
  if (current === undefined) return true
  const entries = Object.entries(current)
  if (entries.length === 0) return true
  if (entries.every(([key, value]) => key === value)) return true
  if (previousSuggested !== undefined && valueMapsEqual(current, previousSuggested)) return true
  return false
}

/** Catalog entry for a device-state pick (deviceId/capName/valuePath). */
export function sourceOptionForPick(
  sources: readonly OsdSourceOption[],
  pick: { readonly deviceId: number; readonly capName: string; readonly valuePath: string },
): OsdSourceOption | undefined {
  if (pick.deviceId <= 0 || pick.capName === '' || pick.valuePath === '') return undefined
  return sources.find(
    (s) =>
      s.deviceId === pick.deviceId && s.capName === pick.capName && s.valuePath === pick.valuePath,
  )
}

/** Find the catalog entry a device-state binding source currently points at. */
export function sourceOptionFor(
  sources: readonly OsdSourceOption[],
  binding: OsdSlotBinding,
): OsdSourceOption | undefined {
  if (binding.source.kind !== 'device-state') return undefined
  const { deviceId, capName, valuePath } = binding.source
  return sources.find(
    (s) => s.deviceId === deviceId && s.capName === capName && s.valuePath === valuePath,
  )
}

/** One-line human summary of a binding's source, for the slot list row. */
export function sourceSummary(
  binding: OsdSlotBinding | null,
  templateNameById?: ReadonlyMap<string, string>,
): string {
  if (binding === null) return translate('outcome.unbound')
  const source = binding.source
  if (source.kind === 'none') return translate('source.kind.none')
  if (source.kind === 'static') return translate('summary.static', { text: source.text })
  if (source.kind === 'clock') return translate('summary.clock', { pattern: source.pattern })
  if (source.kind === 'latest-recognition') {
    return source.recognition === 'person'
      ? translate('source.recognitionPerson')
      : translate('source.recognitionPlate')
  }
  if (source.kind === 'template') {
    const name = templateNameById?.get(source.templateId)
    return name !== undefined && name !== '' ? name : source.templateId
  }
  return `${source.capName} · ${source.valuePath}`
}

export type OsdCameraStatus = 'unsupported' | 'disabled' | 'partial' | 'enabled'

/**
 * Camera-level OSD status, rolled up from every probed slot's binding —
 * the collapsed table row shows exactly this, never a per-slot id.
 *
 *  - `unsupported`: the camera publishes no `osd` cap at all.
 *  - `disabled`: OSD-capable, but no writable slot has an active binding.
 *  - `enabled`: OSD-capable, every writable slot has an active binding.
 *  - `partial`: OSD-capable, some writable slots are bound and some are not
 *    (or are bound but switched off) — a state worth flagging on its own,
 *    since it usually means a copy or edit only got half done.
 */
export function cameraOsdStatus(
  supportsOsd: boolean,
  slots: readonly OsdSlotView[],
): OsdCameraStatus {
  if (!supportsOsd) return 'unsupported'
  const writable = slots.filter((slot) => !slot.readOnly)
  if (writable.length === 0) return 'disabled'
  const activeCount = writable.filter((slot) => slot.binding?.enabled === true).length
  if (activeCount === 0) return 'disabled'
  if (activeCount === writable.length) return 'enabled'
  return 'partial'
}

export function cameraStatusLabel(status: OsdCameraStatus): string {
  return translate(`cameraStatus.${status}`)
}

export type OsdCameraStatusTone = 'success' | 'warning' | 'default'

const CAMERA_STATUS_TONES: Record<OsdCameraStatus, OsdCameraStatusTone> = {
  unsupported: 'default',
  disabled: 'default',
  partial: 'warning',
  enabled: 'success',
}

export function cameraStatusTone(status: OsdCameraStatus): OsdCameraStatusTone {
  return CAMERA_STATUS_TONES[status]
}

/** Short status word on a slot tab — never a raw binding blob. */
export type OsdSlotTabStatus = 'bound' | 'unbound' | 'readonly'

export function slotTabStatus(slot: OsdSlotView): OsdSlotTabStatus {
  if (slot.readOnly) return 'readonly'
  if (slot.binding !== null) return 'bound'
  return 'unbound'
}

export function slotTabStatusLabel(status: OsdSlotTabStatus): string {
  return translate(`slotStatus.${status}`)
}

/** Layers the single-camera editor may show — never template-owned / read-only. */
export function writableSlots(slots: readonly OsdSlotView[]): readonly OsdSlotView[] {
  return slots.filter((slot) => !slot.readOnly)
}

/** First writable slot, else the first slot — the tab the detail opens on. */
export function defaultActiveSlotId(slots: readonly OsdSlotView[]): string | undefined {
  const writable = slots.find((slot) => !slot.readOnly)
  return (writable ?? slots[0])?.slotId
}

export interface SourceChip {
  readonly key: string
  readonly label: string
}

/**
 * One human-facing chip per DISTINCT active source feeding this camera's
 * overlays — never a raw slot id, cap name, or value path. A `device-state`
 * source with no `deviceId` means "this camera" (the same self-reference the
 * binding schema uses to stay copyable between cameras); one WITH a
 * `deviceId` resolves through `deviceNameById` to that device's display
 * name, i.e. "a linked sensor/device", per the operator-facing vocabulary.
 */
export function activeSourceChips(
  slots: readonly OsdSlotView[],
  deviceNameById: ReadonlyMap<number, string>,
  templateNameById: ReadonlyMap<string, string> = new Map(),
): SourceChip[] {
  const chips = new Map<string, string>()
  for (const slot of slots) {
    const binding = slot.binding
    if (binding === null || !binding.enabled) continue
    const [key, label] = sourceChip(binding.source, deviceNameById, templateNameById)
    chips.set(key, label)
  }
  return [...chips.entries()].map(([key, label]) => ({ key, label }))
}

function sourceChip(
  source: OsdSource,
  deviceNameById: ReadonlyMap<number, string>,
  templateNameById: ReadonlyMap<string, string>,
): readonly [string, string] {
  if (source.kind === 'none') return ['none', translate('source.kind.none')]
  if (source.kind === 'static') return ['static', translate('source.kind.static')]
  if (source.kind === 'clock') return ['clock', translate('source.kind.clock')]
  if (source.kind === 'latest-recognition') {
    return source.recognition === 'person'
      ? ['recognition:person', translate('chip.person')]
      : ['recognition:plate', translate('chip.plate')]
  }
  if (source.kind === 'template') {
    const name = templateNameById.get(source.templateId)
    return [
      `template:${source.templateId}`,
      name !== undefined && name !== '' ? name : source.templateId,
    ]
  }
  if (source.deviceId === undefined) return ['device-state:self', translate('chip.thisCamera')]
  const name = deviceNameById.get(source.deviceId)
  return [
    `device-state:${source.deviceId}`,
    name !== undefined ? translate('chip.linked', { name }) : translate('chip.linkedDevice'),
  ]
}

export function outcomeLabel(outcome: OsdRenderOutcome): string {
  return translate(`outcome.${outcome}`)
}

export type OutcomeTone = 'success' | 'warning' | 'danger' | 'default'

const OUTCOME_TONES: Record<OsdRenderOutcome, OutcomeTone> = {
  written: 'success',
  unchanged: 'success',
  gated: 'warning',
  unreadable: 'warning',
  disabled: 'default',
  unbound: 'default',
  failed: 'danger',
}

export function outcomeTone(outcome: OsdRenderOutcome): OutcomeTone {
  return OUTCOME_TONES[outcome]
}

/** Drop a condition key, collapsing to `undefined` when nothing remains. */
export function withoutCondition(
  conditions: NcConditions | undefined,
  key: keyof NcConditions,
): NcConditions | undefined {
  if (conditions === undefined) return undefined
  const { [key]: _removed, ...rest } = conditions
  return Object.keys(rest).length === 0 ? undefined : rest
}
