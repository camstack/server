/**
 * ONE dictionary of human labels for the state words the rule editors show
 * (R7, D690).
 *
 * A device-state gate offers the words the engine compares against —
 * `armed_away`, `not_home`, `unlocking` — and both rule editors printed them
 * verbatim. The words are the WIRE vocabulary and must stay what they are (a
 * rule stores them); what the operator reads is a label, and two editors that
 * each translate on their own are two editors that disagree. Both the admin UI
 * and the viewer resolve through {@link stateLabel}.
 *
 * Keys are the raw values themselves, flat: the vocabularies are disjoint where
 * they differ and agree where they overlap (`open` is the same word on a cover
 * and on a contact). An OPEN vocabulary (a presence zone the operator named,
 * a cover state a new integration invents) falls back to the raw word — never
 * an exception, never an empty chip.
 *
 * Covered, and held to their sources by the spec: the alarm panel's states,
 * the cover's, the lock's, the boolean readers' words
 * (`DEVICE_STATE_READERS`), presence's canonical `home`/`not_home`, and the
 * scene gate's verdicts and read modes.
 */

/** A label in every locale both editors ship. */
export interface StateLabel {
  readonly en: string
  readonly it: string
}

/** The locales a {@link StateLabel} carries. */
export type StateLabelLocale = keyof StateLabel

/** Every key the dictionary answers for, in a stable order. */
export const STATE_LABEL_KEYS = [
  // alarm-panel (`AlarmStateSchema`)
  'disarmed',
  'armed_home',
  'armed_away',
  'armed_night',
  'armed_vacation',
  'armed_custom_bypass',
  'arming',
  'disarming',
  'pending',
  'triggered',
  // cover (`CoverStateSchema`) + contact (`open`/`closed`)
  'open',
  'opening',
  'closing',
  'closed',
  'stopped',
  // lock-control (`LockStateSchema`)
  'locked',
  'unlocked',
  'locking',
  'unlocking',
  'jammed',
  // switch / binary
  'on',
  'off',
  // presence (HA canonical)
  'home',
  'not_home',
  // scene gate: verdicts (`SceneVerdictSchema`) and read modes (`emit`)
  'matched',
  'diverged',
  'unknown',
  'latched',
  'live',
] as const

/** A key {@link STATE_LABELS} answers for. */
export type StateLabelKey = (typeof STATE_LABEL_KEYS)[number]

export const STATE_LABELS: Readonly<Record<StateLabelKey, StateLabel>> = {
  disarmed: { en: 'Disarmed', it: 'Disinserito' },
  armed_home: { en: 'Armed (home)', it: 'Inserito (in casa)' },
  armed_away: { en: 'Armed (away)', it: 'Inserito (fuori casa)' },
  armed_night: { en: 'Armed (night)', it: 'Inserito (notte)' },
  armed_vacation: { en: 'Armed (vacation)', it: 'Inserito (vacanza)' },
  armed_custom_bypass: { en: 'Armed (custom)', it: 'Inserito (personalizzato)' },
  arming: { en: 'Arming', it: 'In inserimento' },
  disarming: { en: 'Disarming', it: 'In disinserimento' },
  pending: { en: 'Pending (entry delay)', it: 'In attesa (ritardo ingresso)' },
  triggered: { en: 'Triggered', it: 'In allarme' },
  open: { en: 'Open', it: 'Aperto' },
  opening: { en: 'Opening', it: 'In apertura' },
  closing: { en: 'Closing', it: 'In chiusura' },
  closed: { en: 'Closed', it: 'Chiuso' },
  stopped: { en: 'Stopped', it: 'Fermo' },
  locked: { en: 'Locked', it: 'Bloccata' },
  unlocked: { en: 'Unlocked', it: 'Sbloccata' },
  locking: { en: 'Locking', it: 'In blocco' },
  unlocking: { en: 'Unlocking', it: 'In sblocco' },
  jammed: { en: 'Jammed', it: 'Inceppata' },
  on: { en: 'On', it: 'Acceso' },
  off: { en: 'Off', it: 'Spento' },
  home: { en: 'Home', it: 'In casa' },
  not_home: { en: 'Away', it: 'Fuori casa' },
  matched: { en: 'Matched (as captured)', it: 'Corrisponde (come acquisita)' },
  diverged: { en: 'Diverged (changed)', it: 'Diversa (cambiata)' },
  unknown: { en: 'Cannot judge', it: 'Non valutabile' },
  latched: { en: 'Latched', it: 'Memorizzato' },
  live: { en: 'Live', it: 'In tempo reale' },
}

const KEY_SET: ReadonlySet<string> = new Set(STATE_LABEL_KEYS)

/** Is `key` one the dictionary answers for? An own key only — never `toString`. */
export function isStateLabelKey(key: string): key is StateLabelKey {
  return KEY_SET.has(key)
}

/**
 * The human label of a state word in `locale`, or the word itself when the
 * dictionary does not know it. Never throws.
 */
export function stateLabel(key: string, locale: StateLabelLocale): string {
  return isStateLabelKey(key) ? STATE_LABELS[key][locale] : key
}
