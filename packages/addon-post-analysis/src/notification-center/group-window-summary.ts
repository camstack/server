/**
 * A burst of deliveries worded as a state summary.
 *
 * The evening digest (`state-summary.ts`) is the structure: a title
 * `{{rule}}: {{summaryCount}}` and a body of bullet lines. A burst of the
 * bad edge (devices offline) uses that digest's section block, heading
 * included. A burst of the recovery edge uses the same bullets without the
 * "still offline" heading, which would describe the wrong fact.
 */

import { NC_SYSTEM_EVENT_CLASS_SPECS, type NcRule, type NcSystemEventKind } from '@camstack/types'
import { frozenDeviceLabel } from './device-directory.js'
import type { NcOutboxEntry } from './outbox.js'
import {
  NC_SYSTEM_DEVICE_ID,
  type NcRuleSubject,
  type NcSystemEventSubject,
} from './rule-engine.js'
import type { NcTextCatalog } from './text-catalog.js'
import {
  NC_STATE_SUMMARY_SECTION_IDS,
  type NcStateItem,
  type NcStateSectionId,
  sectionKinds,
} from './state-summary/state-model.js'
import {
  type NcStateSectionResult,
  type NcStateSummary,
  stateSummaryText,
} from './state-summary/state-summary.js'
import {
  NC_STATE_SUMMARY_BODY_KEY,
  NC_STATE_SUMMARY_TITLE_KEY,
} from './state-summary/state-summary-delivery.js'

export interface GroupWindowSummaryInput {
  readonly rule: NcRule
  readonly entries: readonly NcOutboxEntry[]
  readonly texts: NcTextCatalog
  readonly nowMs: number
  readonly openedAt: number
  readonly targetId: string
}

/** `null` when the burst has nothing that can be said — the caller sends each row on its own. */
export function groupWindowSubject(input: GroupWindowSummaryInput): NcRuleSubject | null {
  const built = burstText(input)
  if (built === null) return null
  const kind = summaryKind(input)
  return {
    kind: 'system-event',
    recordId: groupWindowRecordId(input.rule.id, input.targetId, input.openedAt),
    deviceId: NC_SYSTEM_DEVICE_ID,
    timestamp: input.nowMs,
    classNames: [],
    zones: [],
    systemEvent: {
      kind,
      subject: `group-window:${input.rule.id}:${input.targetId}`,
      titleKey: NC_STATE_SUMMARY_TITLE_KEY,
      bodyKey: NC_STATE_SUMMARY_BODY_KEY,
      textParams: {
        summaryText: built.text,
        summaryCount: String(built.count),
        summarySection: built.section,
      },
      textCount: built.count,
      data: {
        stateSummary: true,
        groupWindow: true,
        windowStartMs: input.openedAt,
        windowEndMs: input.nowMs,
        [GROUP_WINDOW_MEMBER_IDS]: input.entries.map((entry) => entry.id).toSorted(),
      },
    },
  }
}

/** Payload key listing the held outbox ids a summary already folded. */
export const GROUP_WINDOW_MEMBER_IDS = 'groupedMemberIds'

export function groupWindowRecordId(ruleId: string, targetId: string, openedAt: number): string {
  return `group-window:${ruleId}:${targetId}:${String(openedAt)}`
}

/** Held row ids frozen on a summary, or `null` when this row is not one. */
export function groupWindowMemberIds(
  data: Readonly<Record<string, unknown>> | undefined,
): readonly string[] | null {
  if (data === undefined) return null
  const raw = data[GROUP_WINDOW_MEMBER_IDS]
  if (!Array.isArray(raw)) return null
  const ids: string[] = []
  for (const item of raw) {
    if (typeof item !== 'string') return null
    ids.push(item)
  }
  return ids.length === 0 ? null : ids
}

interface BurstText {
  readonly text: string
  readonly count: number
  readonly section: string
}

function burstText(input: GroupWindowSummaryInput): BurstText | null {
  const { items, orphans } = itemsOf(input)
  const summary = summaryOf(items)
  const words =
    summary.itemCount === 0
      ? null
      : stateSummaryText({ texts: input.texts, summary, nowMs: input.nowMs })
  const body = words === null ? '' : recoveryOnly(items) ? linesOnly(words) : words.text
  const extra = orphans.join('\n')
  const text = [body, extra].filter((part) => part.length > 0).join('\n')
  const count = summary.itemCount + orphans.length
  if (text.length === 0 || count === 0) return null
  const section = words?.sections.map((part) => part.title).join(', ') ?? ''
  return { text, count, section }
}

function linesOnly(words: { readonly sections: readonly { readonly body: string }[] }): string {
  return words.sections
    .map((part) => part.body)
    .filter((body) => body.length > 0)
    .join('\n')
}

function recoveryOnly(items: readonly NcStateItem[]): boolean {
  return items.length > 0 && items.every((item) => isRecoveryKind(item.subject.kind))
}

function isRecoveryKind(kind: NcSystemEventKind): boolean {
  return NC_SYSTEM_EVENT_CLASS_SPECS.some((spec) => spec.recovery.some((edge) => edge === kind))
}

function summaryOf(items: readonly NcStateItem[]): NcStateSummary {
  const sections: NcStateSectionResult[] = []
  for (const id of NC_STATE_SUMMARY_SECTION_IDS) {
    const own = items.filter((item) => item.section === id)
    if (own.length === 0) continue
    sections.push({ id, status: 'read', items: own })
  }
  return {
    sections,
    itemCount: items.length,
    unavailableCount: 0,
    dropped: {},
    excludedGroups: [],
  }
}

function itemsOf(input: GroupWindowSummaryInput): {
  readonly items: readonly NcStateItem[]
  readonly orphans: readonly string[]
} {
  const items: NcStateItem[] = []
  const orphans: string[] = []
  for (const entry of input.entries) {
    const system = entry.payload.subject.systemEvent
    if (system === undefined) {
      orphans.push(plainBullet(entry))
      continue
    }
    const section = sectionOfKind(system.kind)
    const params = system.textParams ?? {}
    const lineKey = lineKeyOf(system.kind, params, system.bodyKey)
    if (section === undefined) {
      const label: Readonly<Record<string, string>> =
        system.deviceId === undefined
          ? {}
          : {
              deviceLabel: frozenDeviceLabel(
                system.deviceId,
                system.deviceType,
                params['deviceName'],
                input.texts.language,
                params['deviceParentName'],
              ),
            }
      orphans.push(`• ${input.texts.text({ key: lineKey, vars: { ...params, ...label } })}`)
      continue
    }
    items.push({
      section,
      subject: subjectOf(entry),
      lineKey,
      params,
      since: entry.payload.subject.timestamp,
    })
  }
  return { items, orphans }
}

function plainBullet(entry: NcOutboxEntry): string {
  const subject = entry.payload.subject
  const name = subject.label ?? subject.className
  return `• ${name}`
}

function sectionOfKind(kind: NcSystemEventKind): NcStateSectionId | undefined {
  return NC_STATE_SUMMARY_SECTION_IDS.find((id) => sectionKinds(id).some((edge) => edge === kind))
}

function lineKeyOf(
  kind: NcSystemEventKind,
  params: Readonly<Record<string, string>>,
  bodyKey: string | undefined,
): string {
  if (kind === 'device-offline') return 'summary.line.device-offline'
  if (kind === 'device-online') return 'summary.line.device-online'
  if (kind === 'device-disabled') return 'summary.line.device-disabled'
  if (kind === 'stream-offline') {
    return params['profile'] !== undefined
      ? 'summary.line.stream-offline.profiled'
      : 'summary.line.stream-offline'
  }
  if (kind === 'detection-blind') return 'summary.line.detection-blind'
  if (kind === 'node-offline') return 'summary.line.node-offline'
  if (kind === 'node-inference-unavailable') return 'summary.line.node-inference-unavailable'
  if (kind === 'addon-crash-loop') return 'summary.line.addon-crash-loop'
  if (kind === 'wrapper-update-available') return 'summary.line.wrapper-update'
  if (kind === 'addon-update-available') return 'summary.line.update'
  return bodyKey ?? 'summary.line.device-offline'
}

function subjectOf(entry: NcOutboxEntry): NcSystemEventSubject {
  const system = entry.payload.subject.systemEvent
  if (system === undefined) {
    return {
      kind: 'device-offline',
      subject: `device:${String(entry.deviceId)}`,
      data: {},
    }
  }
  return {
    kind: system.kind,
    subject: system.subject,
    ...(system.titleKey !== undefined ? { titleKey: system.titleKey } : {}),
    ...(system.bodyKey !== undefined ? { bodyKey: system.bodyKey } : {}),
    ...(system.textParams !== undefined ? { textParams: system.textParams } : {}),
    ...(system.textCount !== undefined ? { textCount: system.textCount } : {}),
    ...(system.deviceId !== undefined
      ? { deviceId: system.deviceId }
      : { deviceId: entry.deviceId }),
    ...(system.deviceType !== undefined ? { deviceType: system.deviceType } : {}),
    ...(system.nodeId !== undefined ? { nodeId: system.nodeId } : {}),
    data: { ...system.data },
  }
}

function summaryKind(input: GroupWindowSummaryInput): NcSystemEventKind {
  for (const entry of input.entries) {
    const kind = entry.payload.subject.systemEvent?.kind
    if (kind !== undefined) return kind
  }
  return input.rule.conditions.systemEvent?.kinds[0] ?? 'device-online'
}
