/**
 * The STATE SUMMARY of one rule, collected and worded (D647). Pure.
 *
 * Collect: every section the rule reports reads its state, and every item is
 * judged by the RULE — `evaluateRule` on the raise the instant path sends for
 * that state, with the rule's own filters (deviceIds, excludeDeviceIds,
 * deviceTypes, nodeIds, packageNames, the consumable threshold). An item the
 * rule would have been silent about is not in its summary. A muted device is
 * not either, exactly as its instant event would have been dropped.
 *
 * Word: one block per section that has something to say. A section whose state
 * could not be read says "unavailable" — never nothing, which would read as
 * "none" (D49). A section with nothing open is left out: a cleared item is not
 * news. Every word is a catalog key, so the summary is in the notification
 * language.
 */
import type { NcRule, NcRuleInput } from '@camstack/types'
import { ncClockText } from '../clock-text.js'
import { evaluateRule, NC_SYSTEM_DEVICE_ID, type NcRuleSubject } from '../rule-engine.js'
import type { NcTextCatalog } from '../text-catalog.js'
import {
  excludedGroupsOfRule,
  NC_STATE_SECTION_VAR,
  type NcStateItem,
  type NcStateItemDevice,
  type NcStateItemNode,
  type NcStateSectionId,
  type NcStateSources,
  sectionsOfRule,
  summaryCondition,
} from './state-model.js'

export interface NcStateSectionResult {
  readonly id: NcStateSectionId
  readonly status: 'read' | 'unavailable'
  readonly items: readonly NcStateItem[]
  /** Why it is unavailable. */
  readonly reason?: string
}

/** Why an item the state held is not in the summary. */
export type NcStateItemDrop = 'muted' | string

export interface NcStateSummary {
  readonly sections: readonly NcStateSectionResult[]
  readonly itemCount: number
  readonly unavailableCount: number
  /** Items left out, by reason — a filter name, `kinds`, or `muted`. */
  readonly dropped: Readonly<Record<NcStateItemDrop, number>>
  /** Kind groups the rule names that have no section (backups & exports). */
  readonly excludedGroups: readonly string[]
}

export interface NcStateSummaryInput {
  readonly rule: NcRule | NcRuleInput
  readonly sources: NcStateSources
  readonly nowMs: number
  readonly isMuted: (deviceId: number) => boolean
}

/** Nothing to say: no item, and every section READ. Such a summary is not sent. */
export function isEmptyStateSummary(summary: NcStateSummary): boolean {
  return summary.itemCount === 0 && summary.unavailableCount === 0
}

export function collectStateSummary(input: NcStateSummaryInput): NcStateSummary {
  const condition = input.rule.conditions.systemEvent
  if (condition === undefined) {
    return { sections: [], itemCount: 0, unavailableCount: 0, dropped: {}, excludedGroups: [] }
  }
  // The rule the items are judged by: its own filters, its kinds widened to
  // the sections it reports, and no active-hours schedule — the summary's
  // send time is its schedule, and the save guard refuses a second one.
  const judge: NcRuleInput = {
    ...input.rule,
    conditions: { ...input.rule.conditions, systemEvent: summaryCondition(condition) },
    schedule: undefined,
    systemEventDelivery: undefined,
  }
  const dropped: Record<string, number> = {}
  const drop = (reason: string): void => {
    dropped[reason] = (dropped[reason] ?? 0) + 1
  }
  const sections: NcStateSectionResult[] = []
  for (const id of sectionsOfRule(condition)) {
    const read = input.sources.read(id, input.nowMs)
    if (!read.answered) {
      sections.push({ id, status: 'unavailable', items: [], reason: read.reason })
      continue
    }
    const items = read.items.filter((item) => {
      const deviceId = item.subject.deviceId
      if (deviceId !== undefined && input.isMuted(deviceId)) {
        drop('muted')
        return false
      }
      const verdict = evaluateRule(judge, ruleSubjectOf(item, input.nowMs))
      if (verdict.matched) return true
      drop(verdict.excludedBySystemEventFilter ?? verdict.failedCondition ?? 'unknown')
      return false
    })
    sections.push({ id, status: 'read', items: items.toSorted(bySince) })
  }
  return {
    sections,
    itemCount: sections.reduce((sum, section) => sum + section.items.length, 0),
    unavailableCount: sections.filter((section) => section.status === 'unavailable').length,
    dropped,
    excludedGroups: excludedGroupsOfRule(condition),
  }
}

function bySince(a: NcStateItem, b: NcStateItem): number {
  return (a.since ?? 0) - (b.since ?? 0)
}

function ruleSubjectOf(item: NcStateItem, nowMs: number): NcRuleSubject {
  return {
    kind: 'system-event',
    recordId: `state:${item.subject.subject}`,
    deviceId: item.subject.deviceId ?? NC_SYSTEM_DEVICE_ID,
    timestamp: nowMs,
    classNames: [],
    zones: [],
    systemEvent: item.subject,
  }
}

// ── Words ────────────────────────────────────────────────────────────

/** One section's block, as a per-section row says it (D698). */
export interface NcStateSectionText {
  readonly id: NcStateSectionId
  /** The section's name — `summary.section.<id>` — `{{summarySection}}`. */
  readonly title: string
  /** The block exactly as the combined text carries it (the "unavailable" sentence included). */
  readonly text: string
  /**
   * What a per-section row's body says (review L3): the item lines WITHOUT the
   * heading the row's title already carries; the "unavailable" sentence as is.
   */
  readonly body: string
  /** Items in the section — `0` for an unavailable one. */
  readonly count: number
  readonly status: NcStateSectionResult['status']
}

/** The summary as a notification says it. */
export interface NcStateSummaryText {
  /** Every section block, one after the other — `{{summaryText}}`. */
  readonly text: string
  /** Items reported — `{{summaryCount}}`. */
  readonly count: number
  /** One variable per section (`{{summaryBattery}}`, ...) — `''` when it has nothing. */
  readonly sectionVars: Readonly<Record<string, string>>
  /** The sections that have something to say, in section order — what a split sends. */
  readonly sections: readonly NcStateSectionText[]
}

export interface NcStateSummaryTextInput {
  readonly texts: NcTextCatalog
  readonly summary: NcStateSummary
  readonly nowMs: number
  readonly timeZone?: string
}

const DAY_MS = 86_400_000

/** "07:12" when it began in the last day, "25 Sep, 07:12" before that. */
function sinceText(
  texts: NcTextCatalog,
  sinceMs: number,
  nowMs: number,
  timeZone?: string,
): string {
  if (nowMs - sinceMs < DAY_MS) return ncClockText(texts.language, sinceMs, timeZone)
  return new Intl.DateTimeFormat(texts.language, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    ...(timeZone !== undefined ? { timeZone } : {}),
  }).format(new Date(sinceMs))
}

function lineOf(input: NcStateSummaryTextInput, item: NcStateItem): string {
  const since =
    item.since !== undefined ? sinceText(input.texts, item.since, input.nowMs, input.timeZone) : ''
  return input.texts.text({ key: item.lineKey, vars: { ...item.params, since } })
}

function sectionTitle(input: NcStateSummaryTextInput, section: NcStateSectionResult): string {
  return input.texts.text({ key: `summary.section.${section.id}` })
}

/** A section's words: its block, and the body a per-section row sends. `null` = nothing to say. */
function wordsOf(
  input: NcStateSummaryTextInput,
  section: NcStateSectionResult,
): { readonly block: string; readonly body: string } | null {
  const title = sectionTitle(input, section)
  if (section.status === 'unavailable') {
    const sentence = input.texts.text({
      key: 'summary.section.unavailable',
      vars: { section: title },
    })
    return { block: sentence, body: sentence }
  }
  if (section.items.length === 0) return null
  const lines = linesOf(input, section.items)
  return { block: `${title}:\n${lines}`, body: lines }
}

/** One bullet per item; an item with a `node` is listed under its node's heading (D708). */
function linesOf(input: NcStateSummaryTextInput, items: readonly NcStateItem[]): string {
  const bullet = (item: NcStateItem): string => `• ${lineOf(input, item)}`
  if (items.some((item) => item.node !== undefined)) {
    return groupByNode(items, input.texts.language)
      .flatMap((group) => [
        input.texts.text({ key: 'summary.node.heading', vars: { node: group.node.name } }),
        ...group.items.map(bullet),
      ])
      .join('\n')
  }
  if (items.some((item) => item.device !== undefined)) {
    return groupByDevice(items, input.texts.language)
      .flatMap((group) => [`${group.device.name}:`, ...group.items.map(bullet)])
      .join('\n')
  }
  return items.map(bullet).join('\n')
}

interface NcNodeGroup {
  readonly node: NcStateItemNode
  readonly items: readonly NcStateItem[]
}

/**
 * The items cut per node, in a STABLE order: the hub first, then by name, then
 * by id. Inside a node the items keep their order (oldest first). An item
 * without a node (none today) is listed under the hub.
 */
function groupByNode(items: readonly NcStateItem[], language: string): readonly NcNodeGroup[] {
  const groups = new Map<string, { node: NcStateItemNode; items: NcStateItem[] }>()
  for (const item of items) {
    const node = item.node ?? HUB_HEADING
    const group = groups.get(node.id)
    if (group === undefined) groups.set(node.id, { node, items: [item] })
    else group.items.push(item)
  }
  return [...groups.values()].toSorted(
    (a, b) =>
      Number(b.node.isHub) - Number(a.node.isHub) ||
      a.node.name.localeCompare(b.node.name, language) ||
      a.node.id.localeCompare(b.node.id),
  )
}

const HUB_HEADING: NcStateItemNode = { id: 'hub', name: 'hub', isHub: true }

interface NcDeviceGroup {
  readonly device: NcStateItemDevice
  readonly items: readonly NcStateItem[]
}

/** Consumables items under each device, devices ordered by name (D934). */
function groupByDevice(items: readonly NcStateItem[], language: string): readonly NcDeviceGroup[] {
  const groups = new Map<number, { device: NcStateItemDevice; items: NcStateItem[] }>()
  for (const item of items) {
    const device = item.device
    if (device === undefined) continue
    const group = groups.get(device.id)
    if (group === undefined) groups.set(device.id, { device, items: [item] })
    else group.items.push(item)
  }
  return [...groups.values()].toSorted((a, b) =>
    a.device.name.localeCompare(b.device.name, language),
  )
}

export function stateSummaryText(input: NcStateSummaryTextInput): NcStateSummaryText {
  const sectionVars: Record<string, string> = {}
  const sections: NcStateSectionText[] = []
  for (const section of input.summary.sections) {
    const words = wordsOf(input, section)
    sectionVars[NC_STATE_SECTION_VAR[section.id]] = words?.block ?? ''
    if (words === null) continue
    sections.push({
      id: section.id,
      title: sectionTitle(input, section),
      text: words.block,
      body: words.body,
      count: section.items.length,
      status: section.status,
    })
  }
  return {
    text: sections.map((section) => section.text).join('\n'),
    count: input.summary.itemCount,
    sectionVars,
    sections,
  }
}
