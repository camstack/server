/**
 * What every device card shows whatever the device is: the shell's data. A
 * scene adds its own zones on top; it never restates any of this.
 */
import type {
  ConsumableForm,
  ConsumableLevel,
  RemoteLayoutPayload,
  RemoteSource,
} from '@camstack/types'
import type { ReactNode } from 'react'
import type { CardGlyph } from '../icons'
import type { CardEvent } from '../parts/EventList'

export type CardOrientation = 'vertical' | 'horizontal'
export type CardTone = 'primary' | 'info' | 'warning' | 'success' | 'danger' | 'muted'

export interface CardPowerDetail {
  readonly id: string
  readonly label: string
  readonly value: string
  /** Starts a new group in the popover (a rule above it). */
  readonly group?: boolean
}

export interface CardPower {
  readonly watts: number | null
  readonly details: readonly CardPowerDetail[]
}

export type CardSupplyState = 'on' | 'off' | 'restarting'
export type CardSupplyAction = 'on' | 'off' | 'restart'

export interface CardSupply {
  readonly name: string
  readonly state: CardSupplyState
}

export interface CardConsumable {
  readonly key: string
  readonly label: string
  readonly note?: string
  /** 0..100, or null when the device reports no level. */
  readonly percent: number | null
  /** The word of the reset action ("Cleaned"), or null when the item is not resettable. */
  readonly resetLabel: string | null
  /** The item is resettable but the viewer may not actuate: the button shows, disabled. */
  readonly resetDisabled?: boolean
  /**
   * The kind-aware level (`consumableItemLevel`): a full bin or waste tank is
   * `full`, a low part `low`. `null` = the device reports nothing (unknown,
   * never ok). Absent: derived from `percent` as a wear part.
   */
  readonly level?: ConsumableLevel | null
  /** How the item is drawn: a wear bar, a vertical gauge (tank, bin) or three steps. */
  readonly form?: ConsumableForm
  /** The state said in words ("Low", "Replace", "Refill now"), so colour never carries it alone. */
  readonly levelWord?: string
  /** One compact line under the label: remaining time or cycles, "Replaced <date>". */
  readonly detail?: string
}

export interface CardRemoteKey {
  readonly id: string
  readonly label: string
  readonly glyph?: CardGlyph
}

/**
 * The saved remote layout (or the preset that stands in for one), drawn by the
 * shared grid. A press sends the button's role. Absent: the card lays the
 * declared keys out itself.
 */
export interface CardRemotePanel {
  readonly layout: RemoteLayoutPayload
  readonly boundRoles: readonly string[]
  readonly sources: readonly RemoteSource[]
  readonly currentSource: string
  readonly deviceId: number
}

export interface CardHistory {
  /** The value history; null hides that section. */
  readonly charts: ReactNode | null
  /** Older interaction rows. Null hides them; a device that records actuations uses that list instead. */
  readonly events: readonly CardEvent[] | null
}

/** A fault the device reports right now (the `error` cap, `active === true`). */
export interface CardFault {
  readonly label: string
  readonly severity: 'warning' | 'error'
}

/**
 * The fault to draw, or null. Only a slice that ANSWERED `active: true` draws
 * one: not-yet-read (`null`), clear (`false`) and a cap the device does not
 * have (no slice) are all no badge (D315).
 */
export function cardFaultOf(
  slice:
    | {
        readonly active: boolean | null
        readonly label: string | null
        readonly code: string | null
        readonly severity: 'warning' | 'error'
      }
    | undefined,
): CardFault | null {
  if (slice === undefined || slice.active !== true) return null
  return { label: slice.label ?? slice.code ?? '', severity: slice.severity }
}

export interface CardCommon {
  /** Set on a live device so the history view can read its actuations. */
  readonly deviceId?: number
  readonly name: string
  readonly integration: string | null
  /** Null when reachability has not been reported: unknown is neither online nor offline. */
  readonly online: boolean | null
  /** "Offline for 2 h" — shown in place of Online, and leading the reason line. */
  readonly offlineLabel: string | null
  /** The viewer may look but not command. */
  readonly readOnly: boolean
  /** Why the last command failed; shown on the reason line until one succeeds. */
  readonly notice: string | null
  /** Null on every optional block means: the device does not declare it. */
  readonly power: CardPower | null
  /** `label` replaces the bare percent (a feeder's "Backup 40%"). */
  readonly battery: { readonly level: number; readonly label?: string } | null
  readonly supply: CardSupply | null
  /** The device's reported fault; absent or null draws no badge. */
  readonly fault?: CardFault | null
  /**
   * `null` = the device is not bound to `consumables`; `[]` = bound and the
   * provider reported none (the card says so).
   */
  readonly consumables: readonly CardConsumable[] | null
  /** Bound to `consumables` but the slice has not landed: loading, never "none" (D315). */
  readonly consumablesLoading?: boolean
  readonly remote: readonly CardRemoteKey[] | null
  /**
   * The layout grid. Set together with `remote` when the device's remote has a
   * layout (saved, or a built-in preset). Null or absent: the key list.
   */
  readonly remotePanel?: CardRemotePanel | null
  /** A saved template is still loading: the remote view draws no raw keys. */
  readonly remoteLayoutPending?: boolean
  readonly history: CardHistory | null
  /**
   * "On motion" for a device that binds `motion-trigger`: the served value and
   * whether a change is in flight. Null or absent: the device offers none, no corner.
   */
  readonly motionTrigger?: CardMotionTrigger | null
}

export interface CardMotionTrigger {
  readonly on: boolean
  readonly pending: boolean
}

export interface CardCommonActions {
  /** Flip "on motion" (the value to set). */
  readonly onMotionTrigger?: (enabled: boolean) => void
  readonly onSupply?: (action: CardSupplyAction) => void
  /** A promise lets the card disable that item's Reset while the call is in flight. */
  readonly onConsumableReset?: (key: string) => void | PromiseLike<unknown>
  readonly onRemoteKey?: (id: string) => void
}

export interface CardState {
  /** Empty when the device does not say what it is doing: nothing is drawn. */
  readonly label: string
  readonly since: string | null
  readonly tone: CardTone
}

/** Battery levels under this are drawn as a warning. */
export const BATTERY_LOW_PERCENT = 20
