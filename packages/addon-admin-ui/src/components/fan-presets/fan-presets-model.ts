/**
 * The pure half of the fan presets editor: which devices a preset step may
 * target, the list edits, and the same checks the hub applies on save (so a
 * refusal is rarely the first the operator hears of a problem).
 */
import type {
  ActionStep,
  FanCaptureGroup,
  FanCaptureItem,
  FanCaptureOmission,
  FanPreset,
  FanPresetCaptureResult,
} from '@camstack/types'

export interface FleetRef {
  readonly id: number
  readonly parentDeviceId: number | null
}

export interface FanRef {
  readonly id: number
  readonly parentDeviceId: number | null
}

/**
 * The devices a preset step may name: the fan itself and its siblings — the
 * children of its container, or its own children when it has no container.
 * The hub refuses anything else, so the picker never offers it.
 */
export function siblingIds(fleet: readonly FleetRef[], fan: FanRef): readonly number[] {
  const container = fan.parentDeviceId ?? fan.id
  const others = fleet
    .filter((d) => d.parentDeviceId === container && d.id !== fan.id)
    .map((d) => d.id)
  return [fan.id, ...others]
}

export function upsertPreset(list: readonly FanPreset[], next: FanPreset): readonly FanPreset[] {
  return list.some((p) => p.id === next.id)
    ? list.map((p) => (p.id === next.id ? next : p))
    : [...list, next]
}

export function removePreset(list: readonly FanPreset[], id: string): readonly FanPreset[] {
  return list.filter((p) => p.id !== id)
}

/** `p1`, `p2`, … — the smallest one no preset has. */
export function newPresetId(list: readonly FanPreset[]): string {
  const taken = new Set(list.map((p) => p.id))
  let n = 1
  while (taken.has(`p${String(n)}`)) n += 1
  return `p${String(n)}`
}

export type PresetCheck =
  | { readonly ok: true }
  | {
      readonly ok: false
      readonly reason: 'no-name' | 'no-steps' | 'duplicate-name'
    }

const sameName = (a: string, b: string): boolean =>
  a.trim().toLowerCase() === b.trim().toLowerCase()

export function checkPresetDraft(others: readonly FanPreset[], draft: FanPreset): PresetCheck {
  if (draft.name.trim() === '') return { ok: false, reason: 'no-name' }
  if (draft.steps.length === 0) return { ok: false, reason: 'no-steps' }
  if (others.some((p) => p.id !== draft.id && sameName(p.name, draft.name))) {
    return { ok: false, reason: 'duplicate-name' }
  }
  return { ok: true }
}

export function omissionText(omission: FanCaptureOmission): string {
  return `${omission.what}: ${omission.reason}`
}

/** The review list shows the groups in this order; an empty group is not shown. */
export const CAPTURE_GROUP_ORDER: readonly FanCaptureGroup[] = ['fan', 'oscillation', 'angles']

export interface CaptureRow {
  /** Index into the result's `steps`, which is what is ticked. */
  readonly index: number
  readonly item: FanCaptureItem
}

export interface CaptureSection {
  readonly group: FanCaptureGroup
  readonly rows: readonly CaptureRow[]
}

/** The captured steps as review sections; rows keep the order the hub proposed. */
export function captureSections(result: FanPresetCaptureResult): readonly CaptureSection[] {
  return CAPTURE_GROUP_ORDER.map((group) => ({
    group,
    rows: result.items.flatMap((item, index): CaptureRow[] =>
      item.group === group ? [{ index, item }] : [],
    ),
  })).filter((section) => section.rows.length > 0)
}

/** The ticked steps, in the order the hub proposed them (the order they must run in). */
export function tickedSteps(
  result: FanPresetCaptureResult,
  ticked: ReadonlySet<number>,
): readonly ActionStep[] {
  return result.steps.filter((_step, index) => ticked.has(index))
}
