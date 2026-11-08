/**
 * What the access and automation caps add to a hero (D1023): a lock, an alarm
 * panel, an automation, a script and a media player's do-not-disturb. Every
 * contribution is typed against the cap's own status schema; a slice that does
 * not parse reads as "not answered" and the state is `unknown`, never `off`
 * (D315/D393). Nothing is guessed: with an unknown state the actions the cap
 * offers are offered separately.
 */
import {
  AlarmPanelStatusSchema,
  type AlarmArmMode,
  type AlarmState,
} from '../../capabilities/alarm-panel.cap.js'
import { AutomationControlStatusSchema } from '../../capabilities/automation-control.cap.js'
import { DoNotDisturbStatusSchema } from '../../capabilities/do-not-disturb.cap.js'
import { LockControlStatusSchema, type LockState } from '../../capabilities/lock-control.cap.js'
import { ScriptRunnerStatusSchema } from '../../capabilities/script-runner.cap.js'
import { DeviceFeature } from '../device-type.js'
import {
  action,
  asAction,
  contribution,
  elapsedText,
  fact,
  joinText,
  reading,
  row,
  type HeroContribution,
} from './hero-contribution-kit.js'
import type { HeroAction, HeroControl } from './hero-model.js'
import type { HeroState } from './hero-state.js'
import { heroText, type HeroText } from './hero-text.js'

// ── lock-control ───────────────────────────────────────────────────────────

interface LockWords {
  readonly state: HeroState
  readonly title: HeroText
  readonly door: 'open' | 'closed' | null
}

const LOCK_WORDS: Readonly<Record<LockState, LockWords>> = {
  locked: { state: 'on', title: heroText('Locked', 'Chiusa'), door: 'closed' },
  unlocked: { state: 'standby', title: heroText('Unlocked', 'Aperta'), door: 'open' },
  locking: { state: 'running', title: heroText('Locking', 'In chiusura'), door: 'closed' },
  unlocking: { state: 'running', title: heroText('Unlocking', 'In apertura'), door: 'open' },
  jammed: { state: 'alert', title: heroText('Jammed', 'Bloccata'), door: null },
  'door-open': { state: 'standby', title: heroText('Door open', 'Porta aperta'), door: 'open' },
}

const lockAction = (primary: boolean): HeroAction =>
  action(
    'lock.lock',
    heroText('Lock', 'Chiudi'),
    'lock',
    'lock-control',
    'lock',
    {},
    primary ? 'primary' : 'normal',
  )

const unlockAction = (primary: boolean): HeroAction =>
  action(
    'lock.unlock',
    heroText('Unlock', 'Apri'),
    'lock-open',
    'lock-control',
    'unlock',
    {},
    primary ? 'primary' : 'normal',
    'unlock',
  )

function lockControls(state: LockState | null, latch: boolean): HeroControl[] {
  const open = asAction(
    action(
      'lock.open',
      heroText('Open latch', 'Apri il chiavistello'),
      'door-open',
      'lock-control',
      'open',
      {},
      'normal',
      'unlock',
    ),
  )
  switch (state) {
    case 'locked':
      return [asAction(unlockAction(true)), ...(latch ? [open] : [])]
    case 'unlocked':
      return [asAction(lockAction(true)), ...(latch ? [open] : [])]
    case 'jammed':
      return [asAction(unlockAction(false)), asAction(lockAction(false))]
    case null:
      return [asAction(lockAction(false)), asAction(unlockAction(false))]
    // locking / unlocking: the bolt is moving. door-open: a lock() is refused.
    default:
      return []
  }
}

const lockContribution = contribution('lock-control', LockControlStatusSchema, (slice, ctx) => {
  const state = slice?.state ?? null
  const words = state === null ? null : LOCK_WORDS[state]
  const since = slice === undefined ? null : elapsedText(slice.lastChangedAt, ctx.now)
  const title = words?.title ?? heroText('Unknown', 'Sconosciuto')
  return {
    reading: reading('lock-control', words?.state ?? 'unknown', false, words?.title),
    rows: [
      row(
        'lock',
        state === 'locked' || state === 'locking' ? 'lock' : 'lock-open',
        joinText([title, since]),
        lockControls(state, ctx.features.includes(DeviceFeature.LockOpen)),
      ),
    ],
    ...(since === null || words === null
      ? {}
      : { facts: [fact('since', 'clock', since, 'muted')] }),
    ...(words?.door == null ? {} : { scene: { mode: words.door } }),
  }
})

// ── alarm-panel ────────────────────────────────────────────────────────────

interface AlarmWords {
  readonly state: HeroState
  readonly title: HeroText
}

const ALARM_WORDS: Readonly<Record<AlarmState, AlarmWords>> = {
  disarmed: { state: 'off', title: heroText('Disarmed', 'Disinserito') },
  armed_home: { state: 'on', title: heroText('Armed home', 'Inserito in casa') },
  armed_away: { state: 'on', title: heroText('Armed away', 'Inserito fuori casa') },
  armed_night: { state: 'on', title: heroText('Armed night', 'Inserito notte') },
  armed_vacation: { state: 'on', title: heroText('Armed vacation', 'Inserito vacanza') },
  armed_custom_bypass: {
    state: 'on',
    title: heroText('Armed with bypass', 'Inserito con esclusioni'),
  },
  arming: { state: 'standby', title: heroText('Arming', 'Inserimento') },
  disarming: { state: 'standby', title: heroText('Disarming', 'Disinserimento') },
  pending: { state: 'standby', title: heroText('Entry delay', 'Ritardo di ingresso') },
  triggered: { state: 'alert', title: heroText('Triggered', 'Allarme in corso') },
}

const ARM_LABELS: Readonly<Record<AlarmArmMode, HeroText>> = {
  home: heroText('Arm home', 'Inserisci in casa'),
  away: heroText('Arm away', 'Inserisci fuori casa'),
  night: heroText('Arm night', 'Inserisci notte'),
  vacation: heroText('Arm vacation', 'Inserisci vacanza'),
  custom_bypass: heroText('Arm with bypass', 'Inserisci con esclusioni'),
}

const ALARM_MODES: readonly AlarmArmMode[] = ['home', 'away', 'night', 'vacation', 'custom_bypass']

function alarmControls(
  state: AlarmState | null,
  modes: readonly AlarmArmMode[],
  requiresCode: boolean,
): HeroControl[] {
  // A hero button carries no secret: a panel that asks for a code is driven from its own page.
  if (requiresCode) return []
  const disarm = asAction(
    action(
      'alarm.disarm',
      heroText('Disarm', 'Disinserisci'),
      'shield-off',
      'alarm-panel',
      'disarm',
      {},
      'primary',
    ),
  )
  const arm = (primaryFirst: boolean): HeroControl[] =>
    modes.map((mode, i) =>
      asAction(
        action(
          `alarm.arm.${mode}`,
          ARM_LABELS[mode],
          'shield-check',
          'alarm-panel',
          'arm',
          { mode },
          primaryFirst && i === 0 ? 'primary' : 'normal',
        ),
      ),
    )
  switch (state) {
    case 'disarmed':
      return arm(true)
    case 'arming':
    case 'disarming':
      return []
    // Unread: whether the panel wants a code is unknown too, so nothing is offered.
    case null:
      return []
    // armed, entry delay, triggered: the way out is disarming.
    default:
      return [disarm]
  }
}

const alarmContribution = contribution('alarm-panel', AlarmPanelStatusSchema, (slice, ctx) => {
  const state = slice?.state ?? null
  const words = state === null ? null : ALARM_WORDS[state]
  const since = slice === undefined ? null : elapsedText(slice.lastChangedAt, ctx.now)
  const modes = slice === undefined ? ALARM_MODES : slice.availableModes
  return {
    reading: reading('alarm-panel', words?.state ?? 'unknown', false, words?.title),
    rows: [
      row(
        'alarm',
        state === 'triggered'
          ? 'shield-alert'
          : state === 'disarmed'
            ? 'shield-off'
            : 'shield-check',
        joinText([words?.title ?? heroText('Unknown', 'Sconosciuto'), since]),
        alarmControls(state, modes, slice?.requiresCode ?? false),
      ),
    ],
    ...(since === null || words === null
      ? {}
      : { facts: [fact('since', 'clock', since, state === 'triggered' ? 'danger' : 'muted')] }),
  }
})

// ── automation-control ─────────────────────────────────────────────────────

const automationContribution = contribution(
  'automation-control',
  AutomationControlStatusSchema,
  (slice, ctx) => {
    const failed = slice?.lastError != null
    const state: HeroState =
      slice === undefined
        ? 'unknown'
        : failed
          ? 'alert'
          : slice.isRunning
            ? 'running'
            : slice.enabled
              ? 'on'
              : 'off'
    const title =
      slice === undefined
        ? undefined
        : failed
          ? heroText('Failed', 'In errore')
          : slice.isRunning
            ? heroText('Running', 'In esecuzione')
            : slice.enabled
              ? heroText('Enabled', 'Attiva')
              : heroText('Disabled', 'Disattivata')
    const last = slice === undefined ? null : elapsedText(slice.lastTriggeredAt, ctx.now)
    const run = action(
      'automation.run',
      heroText('Run now', 'Esegui ora'),
      'play',
      'automation-control',
      'trigger',
      {},
      'primary',
    )
    const toggle: HeroControl = {
      kind: 'toggle',
      id: 'automation.enabled',
      label: heroText('Enabled', 'Attiva'),
      on: slice?.enabled ?? null,
      turnOn: action(
        'automation.enable',
        heroText('Enable', 'Attiva'),
        'play',
        'automation-control',
        'enable',
      ),
      turnOff: action(
        'automation.disable',
        heroText('Disable', 'Disattiva'),
        'square',
        'automation-control',
        'disable',
      ),
    }
    return {
      reading: reading('automation-control', state, false, title),
      rows: [
        row(
          'automation',
          'workflow',
          joinText([
            title ?? heroText('Unknown', 'Sconosciuto'),
            last === null ? null : heroText(`Ran ${last.en}`, `Eseguita ${last.it}`),
            slice?.lastError == null ? null : heroText(slice.lastError, slice.lastError),
          ]),
          [asAction(run), toggle],
        ),
      ],
      ...(last === null
        ? {}
        : { facts: [fact('last-run', 'clock', last, failed ? 'danger' : 'muted')] }),
    }
  },
)

// ── script-runner ──────────────────────────────────────────────────────────

const scriptContribution = contribution('script-runner', ScriptRunnerStatusSchema, (slice, ctx) => {
  const failed = slice?.lastRunSuccess === false
  const state: HeroState =
    slice === undefined ? 'unknown' : slice.isRunning ? 'running' : failed ? 'alert' : 'idle'
  const title =
    slice === undefined
      ? undefined
      : slice.isRunning
        ? heroText('Running', 'In esecuzione')
        : failed
          ? heroText('Failed', 'In errore')
          : heroText('Ready', 'Pronto')
  const last = slice === undefined ? null : elapsedText(slice.lastRunAt, ctx.now)
  const control =
    slice?.isRunning === true
      ? action(
          'script.stop',
          heroText('Stop', 'Ferma'),
          'square',
          'script-runner',
          'stop',
          {},
          'primary',
        )
      : action(
          'script.run',
          heroText('Run', 'Esegui'),
          'play',
          'script-runner',
          'run',
          {},
          'primary',
        )
  return {
    reading: reading('script-runner', state, false, title),
    rows: [
      row(
        'script',
        'scroll-text',
        joinText([
          title ?? heroText('Unknown', 'Sconosciuto'),
          last === null ? null : heroText(`Ran ${last.en}`, `Eseguito ${last.it}`),
          slice?.lastError == null ? null : heroText(slice.lastError, slice.lastError),
        ]),
        [asAction(control)],
      ),
    ],
    ...(last === null
      ? {}
      : { facts: [fact('last-run', 'clock', last, failed ? 'danger' : 'muted')] }),
  }
})

// ── do-not-disturb ─────────────────────────────────────────────────────────

const doNotDisturbContribution = contribution(
  'do-not-disturb',
  DoNotDisturbStatusSchema,
  (slice) => {
    const on = slice?.enabled ?? null
    return {
      rows: [
        row(
          'do-not-disturb',
          'bell-off',
          on === null
            ? heroText('Unknown', 'Sconosciuto')
            : on
              ? heroText('Do not disturb on', 'Non disturbare attivo')
              : heroText('Do not disturb off', 'Non disturbare spento'),
          [
            {
              kind: 'toggle',
              id: 'do-not-disturb.toggle',
              label: heroText('Do not disturb', 'Non disturbare'),
              on,
              turnOn: action(
                'do-not-disturb.on',
                heroText('Turn on', 'Attiva'),
                'bell-off',
                'do-not-disturb',
                'setEnabled',
                { enabled: true },
              ),
              turnOff: action(
                'do-not-disturb.off',
                heroText('Turn off', 'Disattiva'),
                'bell',
                'do-not-disturb',
                'setEnabled',
                { enabled: false },
              ),
            },
          ],
        ),
      ],
    }
  },
)

export const ACCESS_FAMILY_CONTRIBUTIONS: Readonly<Record<string, HeroContribution>> = {
  'lock-control': lockContribution,
  'alarm-panel': alarmContribution,
  'automation-control': automationContribution,
  'script-runner': scriptContribution,
  'do-not-disturb': doNotDisturbContribution,
}
