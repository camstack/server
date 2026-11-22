/**
 * The pure half of the group's Triggers section: how a trigger reads as one
 * line, and the immutable edits of the list. The list is stored in the group's
 * helper spec; this file never decides what is valid — the backend refuses a
 * bad list by name and the section shows that refusal.
 */
import {
  type CompositionSourceRef,
  type GroupTrigger,
  type GroupTriggerAction,
  type GroupTriggerSource,
  GROUP_TRIGGER_ID_RE,
  MAX_GROUP_TRIGGERS,
  triggerEnabled,
} from '@camstack/types'

export { triggerEnabled, MAX_GROUP_TRIGGERS }

/** The sources this section can author; the others are kept and shown, never rewritten. */
export type EditableSourceKind = 'fired' | 'event'

export function isEditableSource(
  source: GroupTriggerSource,
): source is Extract<GroupTriggerSource, { kind: EditableSourceKind }> {
  return source.kind === 'fired' || source.kind === 'event'
}

export type NameOf = (ref: CompositionSourceRef) => string

export function sourceSummary(source: GroupTriggerSource, nameOf: NameOf): string {
  switch (source.kind) {
    case 'fired': {
      const events = source.eventIds === undefined ? '' : ` · ${source.eventIds.join(', ')}`
      return `${nameOf(source.device)}${events}`
    }
    case 'event':
      return source.device === undefined
        ? source.category
        : `${source.category} · ${nameOf(source.device)}`
    case 'detection':
      return `${source.subjects.join(', ')} · ${source.devices.map(nameOf).join(', ')}`
    case 'becomes':
      return `${nameOf(source.device)} · ${source.fieldPath} → ${source.becomes ? 'true' : 'false'}`
  }
}

export function actionSummary(action: GroupTriggerAction): string {
  if (action.kind !== 'climate') return action.kind
  const parts = [action.mode, action.target === undefined ? undefined : String(action.target)]
  return `climate ${parts.filter((p) => p !== undefined).join(' ')}`.trim()
}

/** A fresh id that is free in the list and a valid leaf id. */
export function nextTriggerId(triggers: readonly GroupTrigger[]): string {
  const used = new Set(triggers.map((t) => t.id))
  for (let n = 1; ; n += 1) {
    const id = `t${String(n)}`
    if (!used.has(id) && GROUP_TRIGGER_ID_RE.test(id)) return id
  }
}

export function withTrigger(
  triggers: readonly GroupTrigger[],
  next: GroupTrigger,
): readonly GroupTrigger[] {
  return triggers.some((t) => t.id === next.id)
    ? triggers.map((t) => (t.id === next.id ? next : t))
    : [...triggers, next]
}

export function withoutTrigger(
  triggers: readonly GroupTrigger[],
  id: string,
): readonly GroupTrigger[] {
  return triggers.filter((t) => t.id !== id)
}

export function withEnabled(
  triggers: readonly GroupTrigger[],
  id: string,
  enabled: boolean,
): readonly GroupTrigger[] {
  return triggers.map((t) => (t.id === id ? { ...t, enabled } : t))
}

/** The actions a group of this template offers: a climate group sets a mode, the rest switch. */
export function offeredActions(templateId: string): readonly GroupTriggerAction['kind'][] {
  return templateId === 'climate' ? ['climate'] : ['on', 'off', 'switch']
}
