import type { HeroConfirm } from '@camstack/types'

/** The words of one confirmation dialog the card asks before a risky action. */
export interface HeroConfirmLabels {
  readonly title: string
  readonly message: string
  readonly confirm: string
}

/**
 * Every string the hero card draws that the hero model does not carry itself
 * (the model's own texts are `{ en, it }` and are picked with the host's `lang`).
 * The host supplies them in its language; the library holds no copy of its own.
 */
export interface HeroLabels {
  /** A picker with no current value. */
  readonly noValue: string
  /** The dialog title when a command was not accepted. */
  readonly callFailed: string
  readonly historyTooltip: string
  readonly consumables: {
    readonly label: string
    readonly low: (count: number) => string
    readonly ok: string
    readonly tooltip: string
  }
  readonly power: {
    readonly label: string
    readonly on: string
    readonly off: string
    readonly tooltip: string
    readonly tooltipReadOnly: string
  }
  readonly confirm: Readonly<Record<HeroConfirm, HeroConfirmLabels>>
}
