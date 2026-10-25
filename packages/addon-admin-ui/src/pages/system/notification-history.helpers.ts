/**
 * The rule → History handoff, carried by the URL.
 *
 * The Notifications page already coordinates its tabs through `?tab=` (see
 * `AdminTabs`); a rule row opening "its" history adds `ruleId` next to it. The
 * URL, not a module box, because this one is small, shareable and survives a
 * reload — the Simulate handoff parks a whole form, which is the case a URL
 * does not fit.
 */

import i18n from '../../i18n/index'

export const HISTORY_TAB_ID = 'history'
export const HISTORY_RULE_PARAM = 'ruleId'
/**
 * The params the History tab owns: `AdminTabs` drops them when the operator
 * leaves it, so the strip's own History tab opens on every rule, last 24 h —
 * never on the rule (and the All-time window) a row seeded earlier.
 */
export const HISTORY_TAB_OWNED_PARAMS: readonly string[] = [HISTORY_RULE_PARAM]

/** Every rule, the last 24 hours — what the tab opens on by itself. */
const DEFAULT_WINDOW_HOURS = 24
/** `0` is the tab's "All time": everything the outbox still keeps. */
const ALL_TIME_WINDOW_HOURS = 0
const DEFAULT_LIMIT = 100

export interface HistoryFilterState {
  readonly ruleId: string
  readonly deviceId: string
  readonly status: string
  readonly windowHours: number
  readonly limit: number
}

/** The params that open the History tab on one rule; every other param kept. */
export function withHistoryTabForRule(params: URLSearchParams, ruleId: string): URLSearchParams {
  const next = new URLSearchParams(params)
  next.set('tab', HISTORY_TAB_ID)
  next.set(HISTORY_RULE_PARAM, ruleId)
  return next
}

/** The params after the operator picks a rule in the filter (`''` = All rules). */
export function withHistoryRuleParam(params: URLSearchParams, ruleId: string): URLSearchParams {
  const next = new URLSearchParams(params)
  if (ruleId === '') next.delete(HISTORY_RULE_PARAM)
  else next.set(HISTORY_RULE_PARAM, ruleId)
  return next
}

/**
 * The filter the tab opens on. Seeded from a rule, the window is All time: the
 * row that sent the operator here may say "3d ago", and a 24 h page would open
 * empty on the very delivery they came to see.
 */
export function initialHistoryFilter(params: URLSearchParams): HistoryFilterState {
  const ruleId = params.get(HISTORY_RULE_PARAM) ?? ''
  return {
    ruleId,
    deviceId: '',
    status: '',
    windowHours: ruleId !== '' ? ALL_TIME_WINDOW_HOURS : DEFAULT_WINDOW_HOURS,
    limit: DEFAULT_LIMIT,
  }
}

export interface HistoryRuleOption {
  readonly value: string
  readonly label: string
}

export interface HistoryRuleOptionsInput {
  readonly rules: readonly { readonly id: string; readonly name: string }[]
  /** Whether the rules list ANSWERED — only then may a missing id be called deleted (D315). */
  readonly answered: boolean
  readonly selected: string
}

/**
 * The rule filter's options. A selected id the list does not hold stays
 * selectable — otherwise the control would SHOW "All rules" while the query
 * filters on a rule — and is named deleted only once the list answered.
 */
export function historyRuleOptions(input: HistoryRuleOptionsInput): readonly HistoryRuleOption[] {
  const listed = input.rules.map((r) => ({ value: r.id, label: r.name }))
  const orphan =
    input.selected !== '' && !input.rules.some((r) => r.id === input.selected)
      ? [
          {
            value: input.selected,
            label: input.answered
              ? i18n.t('helpers.notificationHistory.deletedRule', { id: input.selected })
              : input.selected,
          },
        ]
      : []
  return [
    { value: '', label: i18n.t('helpers.notificationHistory.allRules') },
    ...listed,
    ...orphan,
  ]
}
