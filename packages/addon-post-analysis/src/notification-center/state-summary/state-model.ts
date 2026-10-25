/**
 * The STATE SUMMARY's vocabulary (D647): its sections, and what one reported
 * item is.
 *
 * A section is one of the D637 kind GROUPS (`NC_SYSTEM_EVENT_KIND_GROUP_SPECS`)
 * — the same grouping both editors list kinds under — so "the rule selected a
 * battery kind" and "the summary has a battery section" are the same fact.
 * `backups-exports` is the one group with no section: a backup or an export is
 * a job that COMPLETED, and the state it leaves behind is not a condition that
 * is still true. The ADR records why it is excluded rather than approximated.
 */
import {
  NC_STATE_SUMMARY_SECTION_IDS,
  NC_SYSTEM_EVENT_KIND_GROUP_SPECS,
  type NcStateSummarySectionId,
  type NcSystemEventCondition,
  type NcSystemEventKind,
} from '@camstack/types'

export { NC_STATE_SUMMARY_SECTION_IDS }
import type { NcSystemEventSubject } from '../rule-engine.js'

/** One source: the cap's Zod enum (D698 LOW-6). */
export type NcStateSectionId = NcStateSummarySectionId

/** The kind groups that have no section, and why — said on the preview. */
const NC_STATE_SUMMARY_EXCLUDED_GROUPS: Readonly<Record<string, string>> = {
  'backups-exports': 'a backup or an export is a completed job, not a state that is still true',
}

export function isStateSectionId(value: string): value is NcStateSectionId {
  return NC_STATE_SUMMARY_SECTION_IDS.some((id) => id === value)
}

/** The template variable that carries one section's lines (`template-vars.ts`). */
export const NC_STATE_SECTION_VAR: Readonly<Record<NcStateSectionId, string>> = {
  'device-state': 'summaryDevices',
  streams: 'summaryStreams',
  battery: 'summaryBattery',
  consumables: 'summaryConsumables',
  'detection-blind': 'summaryDetection',
  nodes: 'summaryNodes',
  addons: 'summaryAddons',
  'addon-updates': 'summaryAddonUpdates',
  updates: 'summaryUpdates',
}

/** The kinds of a section — its kind group. */
export function sectionKinds(section: NcStateSectionId): readonly NcSystemEventKind[] {
  return NC_SYSTEM_EVENT_KIND_GROUP_SPECS.find((group) => group.id === section)?.kinds ?? []
}

/**
 * The sections a rule reports, in section order: every section whose kind
 * group shares a kind with the rule. A rule that selected only
 * `device-battery-low` still reports the battery STATE — the state has no
 * direction, only the event did.
 */
export function sectionsOfRule(condition: NcSystemEventCondition): readonly NcStateSectionId[] {
  const kinds = condition.kinds
  return NC_STATE_SUMMARY_SECTION_IDS.filter((section) =>
    sectionKinds(section).some((kind) => kinds.includes(kind)),
  )
}

/** The kind groups the rule selected that have no section. */
export function excludedGroupsOfRule(condition: NcSystemEventCondition): readonly string[] {
  const kinds = condition.kinds
  return NC_SYSTEM_EVENT_KIND_GROUP_SPECS.filter(
    (group) =>
      NC_STATE_SUMMARY_EXCLUDED_GROUPS[group.id] !== undefined &&
      group.kinds.some((kind) => kinds.includes(kind)),
  ).map((group) => group.id)
}

/**
 * The condition the summary judges its items with: the rule's own, with its
 * kinds widened to every kind of every section it reports — so a rule that
 * named the raise is not told "not my kind" about the state the raise left
 * behind. Every FILTER is the rule's, untouched.
 */
export function summaryCondition(condition: NcSystemEventCondition): NcSystemEventCondition {
  const kinds = sectionsOfRule(condition).flatMap((section) => sectionKinds(section))
  return { ...condition, kinds: [...new Set([...condition.kinds, ...kinds])] }
}

/**
 * The node an update item is ABOUT (D708): an update section is worded one
 * heading per node, the hub first, then by name. `name` is the node
 * directory's (the id when it has none).
 */
export interface NcStateItemNode {
  readonly id: string
  readonly name: string
  readonly isHub: boolean
}

/** Heading for a consumables item grouped under its device (D934). */
export interface NcStateItemDevice {
  readonly id: number
  readonly name: string
}

/**
 * ONE thing that is true now and worth reporting.
 *
 * `subject` is the event the instant path raised (or would raise) for this
 * state — the rule's filters judge it through `evaluateRule`, exactly as they
 * judge the instant event, so a summary can never report a device the same
 * rule would have been silent about.
 */
export interface NcStateItem {
  readonly section: NcStateSectionId
  readonly subject: NcSystemEventSubject
  /** The line's catalog key and the params that fill it. */
  readonly lineKey: string
  readonly params: Readonly<Record<string, string>>
  /** When the state began, as far as the hub observed it. */
  readonly since?: number
  /** Set on an item of a per-node section (the update sections): its heading. */
  readonly node?: NcStateItemNode
  /** Set on a consumables item: grouped under this device name (D934). */
  readonly device?: NcStateItemDevice
}

/**
 * What a source answered for one section. `answered: false` is a read that did
 * not happen (a ledger not yet loaded): the summary says the section is
 * UNAVAILABLE, never that it is empty (D49, D315).
 */
export type NcStateSectionRead =
  | { readonly answered: true; readonly items: readonly NcStateItem[] }
  | { readonly answered: false; readonly reason: string }

/** The state the summary reads, per section. */
export interface NcStateSources {
  readonly read: (section: NcStateSectionId, nowMs: number) => NcStateSectionRead
}
