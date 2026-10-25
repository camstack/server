/**
 * Authoring a rule's ACTIONS: hook bindings and the buttons its notification
 * carries. Sequences themselves are shared entities (Notifications → Sequences);
 * a rule only binds to them by id, or authors a single Do.
 *
 * Pure, so the rules can be tested without mounting a dialog.
 */

import type {
  NcActionBinding,
  NcRuleAction,
  NcRuleActions,
  NcRuleNotificationButton,
  NcSharedSequence,
  NotificationActionIcon,
} from '@camstack/types'
import { DeviceType } from '@camstack/types'
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
  readonly onActivation: readonly NcActionBinding[]
  readonly onDeactivation: readonly NcActionBinding[]
  readonly onTrigger: readonly NcActionBinding[]
  readonly onTriggerOff: readonly NcActionBinding[]
  readonly buttons: readonly NcRuleNotificationButton[]
}

export const EMPTY_RULE_ACTIONS: NcRuleActionsFormState = {
  onActivation: [],
  onDeactivation: [],
  onTrigger: [],
  onTriggerOff: [],
  buttons: [],
}

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
    (b) => b.id.trim() !== '' && b.label.trim() !== '' && b.sequenceId.trim() !== '',
  )
  const hooks = {
    onActivation: form.onActivation,
    onDeactivation: form.onDeactivation,
    onTrigger: form.onTrigger,
    onTriggerOff: form.onTriggerOff,
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
  readonly kind: 'duplicate-button' | 'unknown-sequence' | 'empty-hook' | 'too-many'
  readonly message: string
}

export function validateRuleActions(
  form: NcRuleActionsFormState,
  knownSequenceIds: ReadonlySet<string>,
): readonly NcRuleActionsProblem[] {
  const problems: NcRuleActionsProblem[] = []
  for (const key of NC_HOOK_KEYS) {
    const bindings = form[key]
    if (bindings.length > 4) {
      problems.push({
        kind: 'too-many',
        message: i18n.t('helpers.notificationRuleActions.tooMany', {
          title: NC_HOOK_LABELS[key].title,
        }),
      })
    }
    for (const binding of bindings) {
      if (binding.kind === 'sequence' && !knownSequenceIds.has(binding.sequenceId)) {
        problems.push({
          kind: 'unknown-sequence',
          message: i18n.t('helpers.notificationRuleActions.hookUnknownSeq', {
            title: NC_HOOK_LABELS[key].title,
          }),
        })
      }
    }
  }
  const ids = new Set<string>()
  for (const button of form.buttons) {
    const id = button.id.trim()
    if (id === '') continue
    if (ids.has(id)) {
      problems.push({
        kind: 'duplicate-button',
        message: i18n.t('helpers.notificationRuleActions.dupButton', { id }),
      })
    }
    ids.add(id)
    if (!knownSequenceIds.has(button.sequenceId.trim())) {
      problems.push({
        kind: 'unknown-sequence',
        message: i18n.t('helpers.notificationRuleActions.buttonUnknownSeq', {
          label: button.label || id,
        }),
      })
    }
  }
  return problems
}

export function newButton(index: number, sequenceId: string): NcRuleNotificationButton {
  return {
    id: `action-${String(index + 1)}`,
    label: i18n.t('helpers.notificationRuleActions.newButtonLabel'),
    sequenceId,
  }
}

export function newDoBinding(): NcActionBinding {
  return { kind: 'do', action: { kind: 'cap', deviceId: 0, cap: '', method: '' } }
}

export function newSequenceBinding(sequenceId: string): NcActionBinding {
  return { kind: 'sequence', sequenceId }
}

export function newStep(): NcRuleAction {
  return { kind: 'wait', seconds: 5 }
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

/** A device a preset can be built against. */
export interface NcPresetDevice {
  readonly id: number
  readonly name: string
  readonly type?: string
}

export const SIREN_PRESET_SECONDS = 30

export interface NcRuleActionPreset {
  readonly id: string
  readonly label: string
  readonly hint: string
  readonly build: () => {
    readonly name: string
    readonly minDelaySec?: number
    readonly actions: readonly NcRuleAction[]
  }
}

export function ruleActionPresets(
  devices: readonly NcPresetDevice[],
): readonly NcRuleActionPreset[] {
  const out: NcRuleActionPreset[] = []
  const panel = devices.find((d) => d.type === DeviceType.AlarmPanel)
  if (panel !== undefined) {
    out.push({
      id: 'trigger-alarm',
      label: i18n.t('helpers.notificationRuleActions.presetAlarm'),
      hint: i18n.t('helpers.notificationRuleActions.presetAlarmHint', { name: panel.name }),
      build: () => ({
        name: 'trigger the alarm',
        actions: [
          { kind: 'cap', deviceId: panel.id, cap: 'alarm-panel', method: 'trigger', args: {} },
        ],
      }),
    })
  }
  for (const siren of devices.filter((d) => d.type === DeviceType.Siren)) {
    out.push({
      id: `siren-${String(siren.id)}`,
      label: i18n.t('helpers.notificationRuleActions.presetSiren', { name: siren.name }),
      hint: i18n.t('helpers.notificationRuleActions.presetSirenHint', {
        seconds: SIREN_PRESET_SECONDS,
      }),
      build: () => ({
        name: `sound ${siren.name}`.toLowerCase(),
        minDelaySec: 60,
        actions: [
          {
            kind: 'cap',
            deviceId: siren.id,
            cap: 'switch',
            method: 'setState',
            args: { on: true },
          },
          { kind: 'wait', seconds: SIREN_PRESET_SECONDS },
          {
            kind: 'cap',
            deviceId: siren.id,
            cap: 'switch',
            method: 'setState',
            args: { on: false },
          },
        ],
      }),
    })
  }
  return out
}

/** Bind a preset's sequence id into onTrigger (after the caller created it). */
export function withPresetOnTrigger(
  form: NcRuleActionsFormState,
  sequenceId: string,
): NcRuleActionsFormState {
  if (form.onTrigger.length >= 4) return form
  return {
    ...form,
    onTrigger: [...form.onTrigger, { kind: 'sequence', sequenceId }],
  }
}

/** Collect every sequence id a form references (hooks + buttons). */
export function referencedSequenceIds(form: NcRuleActionsFormState): ReadonlySet<string> {
  const ids = new Set<string>()
  for (const key of NC_HOOK_KEYS) {
    for (const binding of form[key]) {
      if (binding.kind === 'sequence') ids.add(binding.sequenceId)
    }
  }
  for (const button of form.buttons) {
    if (button.sequenceId.trim() !== '') ids.add(button.sequenceId)
  }
  return ids
}

/** Steps of every binding that can actuate — for alarm / snooze derivation. */
export function formActionSteps(
  form: NcRuleActionsFormState,
  sequences: readonly NcSharedSequence[],
): readonly NcRuleAction[] {
  const byId = new Map(sequences.map((s) => [s.id, s]))
  const out: NcRuleAction[] = []
  for (const key of NC_HOOK_KEYS) {
    for (const binding of form[key]) {
      if (binding.kind === 'do') out.push(binding.action)
      else {
        const seq = byId.get(binding.sequenceId)
        if (seq !== undefined) out.push(...seq.actions)
      }
    }
  }
  for (const button of form.buttons) {
    const seq = byId.get(button.sequenceId)
    if (seq !== undefined) out.push(...seq.actions)
  }
  return out
}
