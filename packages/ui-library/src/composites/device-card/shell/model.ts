/**
 * What every device card shows whatever the device is: the shell's data. A
 * scene adds its own zones on top; it never restates any of this.
 */
import type { RemoteLayoutPayload, RemoteSource } from '@camstack/types'
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
  /** The word of the reset action ("Cleaned"), or null when it cannot be reset. */
  readonly resetLabel: string | null
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
  /** The charts of the History tab; null hides the tab. */
  readonly charts: ReactNode | null
  /** The Interactions tab; null hides the tab. */
  readonly events: readonly CardEvent[] | null
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
  readonly battery: { readonly level: number } | null
  readonly supply: CardSupply | null
  readonly consumables: readonly CardConsumable[] | null
  readonly remote: readonly CardRemoteKey[] | null
  /**
   * The layout grid. Set together with `remote` when the device's remote has a
   * layout (saved, or a built-in preset). Null or absent: the key list.
   */
  readonly remotePanel?: CardRemotePanel | null
  /** A saved template is still loading: the remote view draws no raw keys. */
  readonly remoteLayoutPending?: boolean
  readonly history: CardHistory | null
}

export interface CardCommonActions {
  readonly onSupply?: (action: CardSupplyAction) => void
  readonly onConsumableReset?: (key: string) => void
  readonly onRemoteKey?: (id: string) => void
}

export interface CardState {
  readonly label: string
  readonly since: string | null
  readonly tone: CardTone
}

/** Levels at or under this are low (the consumables button turns into a warning). */
export const CONSUMABLE_LOW_PERCENT = 30
/** Battery levels under this are drawn as a warning. */
export const BATTERY_LOW_PERCENT = 20
