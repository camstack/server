/**
 * Authoring a rule's ACTIONS: which Actions each hook edge starts, and the buttons the
 * notification carries. An Action is authored on the Build → Actions page; a rule only
 * names it by id (planning#473).
 *
 * Pure, so the rules can be tested without mounting a dialog.
 */

import type {
  ActionEntry,
  ActionStep,
  NcRuleActions,
  NcRuleNotificationButton,
  NotificationActionIcon,
} from '@camstack/types'
import i18n from '../../i18n/index'

export type NcHookKey = 'onActivation' | 'onDeactivation' | 'onTrigger' | 'onTriggerOff'

export const NC_HOOK_KEYS: readonly NcHookKey[] = [
  'onActivation',
  'onDeactivation',
  'onTrigger',
  'onTriggerOff',
]

export const NC_HOOK_LABELS: Readonly<Record<NcHookKey, { title: string; hint: string }>> = {
  onActivation: {
    get title() {
      return i18n.t('helpers.notificationRuleActions.onActivationTitle')
    },
    get hint() {
      return i18n.t('helpers.notificationRuleActions.onActivationHint')
    },
  },
  onDeactivation: {
    get title() {
      return i18n.t('helpers.notificationRuleActions.onDeactivationTitle')
    },
    get hint() {
      return i18n.t('helpers.notificationRuleActions.onDeactivationHint')
    },
  },
  onTrigger: {
    get title() {
      return i18n.t('helpers.notificationRuleActions.onTriggerTitle')
    },
    get hint() {
      return i18n.t('helpers.notificationRuleActions.onTriggerHint')
    },
  },
  onTriggerOff: {
    get title() {
      return i18n.t('helpers.notificationRuleActions.onTriggerOffTitle')
    },
    get hint() {
      return i18n.t('helpers.notificationRuleActions.onTriggerOffHint')
    },
  },
}

/** The actions half of the rule form. */
export interface NcRuleActionsFormState {
  readonly onActivation: readonly string[]
  readonly onDeactivation: readonly string[]
  readonly onTrigger: readonly string[]
  readonly onTriggerOff: readonly string[]
  readonly buttons: readonly NcRuleNotificationButton[]
}

export const EMPTY_RULE_ACTIONS: NcRuleActionsFormState = {
  onActivation: [],
  onDeactivation: [],
  onTrigger: [],
  onTriggerOff: [],
  buttons: [],
}

/** Most Actions one hook edge may start (the schema's bound). */
export const NC_HOOK_MAX_ACTIONS = 4

/** Hydrate from a persisted rule. Absent blocks read as empty, not as a change. */
export function actionsToForm(actions: NcRuleActions | undefined): NcRuleActionsFormState {
  if (actions === undefined) return EMPTY_RULE_ACTIONS
  return {
    onActivation: [...(actions.onActivation ?? [])],
    onDeactivation: [...(actions.onDeactivation ?? [])],
    onTrigger: [...(actions.onTrigger ?? [])],
    onTriggerOff: [...(actions.onTriggerOff ?? [])],
    buttons: [...(actions.buttons ?? [])],
  }
}

/**
 * Back to the wire shape, or `undefined` when there is nothing to say.
 *
 * Never `{}`: `buildRuleInput` omits the key on `undefined`, and an admin edit
 * that empties the actions removes the stored ones through `clear`.
 */
export function formToActions(form: NcRuleActionsFormState): NcRuleActions | undefined {
  const buttons = form.buttons.filter(
    (b) => b.id.trim() !== '' && b.label.trim() !== '' && b.actionId.trim() !== '',
  )
  const hook = (ids: readonly string[]): readonly string[] => ids.filter((id) => id.trim() !== '')
  const hooks = {
    onActivation: hook(form.onActivation),
    onDeactivation: hook(form.onDeactivation),
    onTrigger: hook(form.onTrigger),
    onTriggerOff: hook(form.onTriggerOff),
  }
  const anyHook = NC_HOOK_KEYS.some((key) => hooks[key].length > 0)
  if (!anyHook && buttons.length === 0) return undefined
  return {
    ...(hooks.onActivation.length > 0 ? { onActivation: [...hooks.onActivation] } : {}),
    ...(hooks.onDeactivation.length > 0 ? { onDeactivation: [...hooks.onDeactivation] } : {}),
    ...(hooks.onTrigger.length > 0 ? { onTrigger: [...hooks.onTrigger] } : {}),
    ...(hooks.onTriggerOff.length > 0 ? { onTriggerOff: [...hooks.onTriggerOff] } : {}),
    ...(buttons.length > 0 ? { buttons } : {}),
  }
}

export interface NcRuleActionsProblem {
  readonly kind: 'duplicate-button' | 'unknown-action' | 'too-many'
  readonly message: string
}

export function validateRuleActions(
  form: NcRuleActionsFormState,
  knownActionIds: ReadonlySet<string>,
): readonly NcRuleActionsProblem[] {
  const problems: NcRuleActionsProblem[] = []
  for (const key of NC_HOOK_KEYS) {
    const ids = form[key]
    if (ids.length > NC_HOOK_MAX_ACTIONS) {
      problems.push({
        kind: 'too-many',
        message: i18n.t('helpers.notificationRuleActions.tooMany', {
          title: NC_HOOK_LABELS[key].title,
        }),
      })
    }
    if (ids.some((id) => id.trim() !== '' && !knownActionIds.has(id))) {
      problems.push({
        kind: 'unknown-action',
        message: i18n.t('helpers.notificationRuleActions.hookUnknownAction', {
          title: NC_HOOK_LABELS[key].title,
        }),
      })
    }
  }
  const seen = new Set<string>()
  for (const button of form.buttons) {
    const id = button.id.trim()
    if (id === '') continue
    if (seen.has(id)) {
      problems.push({
        kind: 'duplicate-button',
        message: i18n.t('helpers.notificationRuleActions.dupButton', { id }),
      })
    }
    seen.add(id)
    if (!knownActionIds.has(button.actionId.trim())) {
      problems.push({
        kind: 'unknown-action',
        message: i18n.t('helpers.notificationRuleActions.buttonUnknownAction', {
          label: button.label || id,
        }),
      })
    }
  }
  return problems
}

export function newButton(index: number, actionId: string): NcRuleNotificationButton {
  return {
    id: `action-${String(index + 1)}`,
    label: i18n.t('helpers.notificationRuleActions.newButtonLabel'),
    actionId,
  }
}

/**
 * The icon vocabulary, with the labels an operator picks from.
 */
export const NC_ACTION_ICON_OPTIONS: readonly {
  readonly value: NotificationActionIcon
  readonly label: string
}[] = [
  {
    value: 'acknowledge',
    get label() {
      return i18n.t('helpers.notificationRuleActions.icon_acknowledge')
    },
  },
  {
    value: 'dismiss',
    get label() {
      return i18n.t('helpers.notificationRuleActions.icon_dismiss')
    },
  },
  {
    value: 'silence',
    get label() {
      return i18n.t('helpers.notificationRuleActions.icon_silence')
    },
  },
  {
    value: 'snooze',
    get label() {
      return i18n.t('helpers.notificationRuleActions.icon_snooze')
    },
  },
  {
    value: 'view',
    get label() {
      return i18n.t('helpers.notificationRuleActions.icon_view')
    },
  },
  {
    value: 'play',
    get label() {
      return i18n.t('helpers.notificationRuleActions.icon_play')
    },
  },
  {
    value: 'camera',
    get label() {
      return i18n.t('helpers.notificationRuleActions.icon_camera')
    },
  },
  {
    value: 'open',
    get label() {
      return i18n.t('helpers.notificationRuleActions.icon_open')
    },
  },
  {
    value: 'close',
    get label() {
      return i18n.t('helpers.notificationRuleActions.icon_close')
    },
  },
  {
    value: 'unlock',
    get label() {
      return i18n.t('helpers.notificationRuleActions.icon_unlock')
    },
  },
  {
    value: 'lock',
    get label() {
      return i18n.t('helpers.notificationRuleActions.icon_lock')
    },
  },
  {
    value: 'disarm',
    get label() {
      return i18n.t('helpers.notificationRuleActions.icon_disarm')
    },
  },
  {
    value: 'arm',
    get label() {
      return i18n.t('helpers.notificationRuleActions.icon_arm')
    },
  },
  {
    value: 'arm-home',
    get label() {
      return i18n.t('helpers.notificationRuleActions.icon_arm_home')
    },
  },
  {
    value: 'arm-away',
    get label() {
      return i18n.t('helpers.notificationRuleActions.icon_arm_away')
    },
  },
  {
    value: 'arm-night',
    get label() {
      return i18n.t('helpers.notificationRuleActions.icon_arm_night')
    },
  },
  {
    value: 'light',
    get label() {
      return i18n.t('helpers.notificationRuleActions.icon_light')
    },
  },
  {
    value: 'alert',
    get label() {
      return i18n.t('helpers.notificationRuleActions.icon_alert')
    },
  },
]

/** Collect every Action id a form references (hooks + buttons). */
export function referencedActionIds(form: NcRuleActionsFormState): ReadonlySet<string> {
  const ids = new Set<string>()
  for (const key of NC_HOOK_KEYS) {
    for (const id of form[key]) if (id.trim() !== '') ids.add(id)
  }
  for (const button of form.buttons) {
    if (button.actionId.trim() !== '') ids.add(button.actionId)
  }
  return ids
}

/** Steps of every Action the form names — for alarm / snooze derivation. */
export function formActionSteps(
  form: NcRuleActionsFormState,
  actions: readonly ActionEntry[],
): readonly ActionStep[] {
  const byId = new Map(actions.map((a) => [a.id, a]))
  const out: ActionStep[] = []
  for (const id of referencedActionIds(form)) out.push(...(byId.get(id)?.steps ?? []))
  return out
}
