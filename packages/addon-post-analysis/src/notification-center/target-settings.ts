/**
 * Per-target settings — the BASE rule of the rules engine (D1031).
 *
 * A rule's `targetOverrides` apply to EVERY delivery the rule makes: an event
 * row, a summary, a timelapse, a calendar digest. They live here, in the one
 * layer every row builder goes through, so a delivery path cannot forget them.
 *
 * Two halves:
 *  - AT ENQUEUE (this module): a target outside its own schedule gets no row
 *    (logged, D391); the others keep theirs. What survives is frozen on the
 *    row — the target's priority, its texts, its params, and the settings the
 *    dispatcher applies at send (`NcOutboxTargetSettings`).
 *  - AT SEND (`deliverable-fields.ts`): the dispatcher narrows the produced
 *    media and buttons to what the target asked for, and drops what its notifier
 *    does not deliver.
 *
 * Absent override = the rule's own value, so a rule saved before this layer
 * reads exactly as it did.
 */
import type {
  NcRuleTarget,
  NcTargetAttachment,
  NcTargetOverride,
  NcTargetOverrides,
} from '@camstack/types'
import type { IScopedLogger } from '@camstack/types'
import { isScheduleActive } from './rule-engine.js'

/** What a rule must carry for its targets to have settings. */
export interface TargetSettingsRule {
  readonly id: string
  readonly name: string
  readonly priority: number
  readonly targetOverrides?: NcTargetOverrides | undefined
}

/**
 * The settings the dispatcher applies at send, frozen on the outbox row. Only
 * the keys the target set are present, so an ordinary row carries none.
 */
export interface NcOutboxTargetSettings {
  readonly attachment?: NcTargetAttachment
  /** `false` = no action buttons for this target. */
  readonly actions?: false
}

/** The per-target values a row builder freezes. */
export interface NcTargetDelivery {
  readonly priority: number
  readonly params: Readonly<Record<string, unknown>> | undefined
  /** The target's own texts (`{{var}}` templates), still unrendered. */
  readonly texts: { readonly title?: string; readonly body?: string } | undefined
  readonly settings: NcOutboxTargetSettings | undefined
}

/**
 * The targets of this fire that are inside their OWN schedule. A target with
 * none follows the rule (whose own schedule the caller already passed). A
 * target outside its window gets no row and says so (D391); the others of the
 * same fire still deliver.
 */
export function targetsInSchedule<T extends Pick<NcRuleTarget, 'targetId'>>(
  logger: IScopedLogger,
  rule: TargetSettingsRule,
  targets: readonly T[],
  at: number,
  deviceId: number,
): readonly T[] {
  return targets.filter((target) => {
    const schedule = rule.targetOverrides?.[target.targetId]?.schedule
    if (schedule === undefined || isScheduleActive(schedule, at)) return true
    logger.info('notification target skipped: outside its own schedule', {
      tags: { deviceId },
      meta: { ruleId: rule.id, rule: rule.name, targetId: target.targetId, at },
    })
    return false
  })
}

function settingsOf(override: NcTargetOverride | undefined): NcOutboxTargetSettings | undefined {
  if (override === undefined) return undefined
  const settings: NcOutboxTargetSettings = {
    ...(override.attachment !== undefined ? { attachment: override.attachment } : {}),
    ...(override.actions === false ? { actions: false } : {}),
  }
  return Object.keys(settings).length > 0 ? settings : undefined
}

/**
 * One target's values for a row: the override where it names a field, the
 * rule's own elsewhere. A priority override also outranks a legacy
 * `params.priority`, which the dispatcher would otherwise read first.
 */
export function targetDelivery(rule: TargetSettingsRule, target: NcRuleTarget): NcTargetDelivery {
  const override = rule.targetOverrides?.[target.targetId]
  const texts = override?.template
  const settings = settingsOf(override)
  if (override?.priority === undefined) {
    return { priority: rule.priority, params: target.params, texts, settings }
  }
  const { priority: _legacy, ...params } = target.params ?? {}
  return {
    priority: override.priority,
    params: Object.keys(params).length > 0 ? params : undefined,
    texts,
    settings,
  }
}
