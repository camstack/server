/**
 * The data an `<IntegrationHub>` page hands its base: groups of integrations,
 * each one an entry that knows how to draw its own body.
 */
import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'

/**
 * What an integration's pill says about it at a glance. Colour is never the
 * only carrier — every state but `ok` is also written next to the name.
 *  - `ok`      running / enabled
 *  - `off`     disabled or stopped by the operator
 *  - `error`   crashed / failed
 *  - `unknown` not answered yet
 */
export type IntegrationState = 'ok' | 'off' | 'error' | 'unknown'

export interface IntegrationEntry {
  /**
   * The addon id. It is the URL value of `?integration=` and names the
   * addon-shipped `assets/icon.svg` that is the pill's mark.
   */
  readonly id: string
  readonly name: string
  /** Glyph used when the addon ships no icon. */
  readonly fallbackIcon: LucideIcon
  readonly state: IntegrationState
  /** The state in words (`running`, `disabled`, `crashed`, …). */
  readonly stateLabel: string
  /**
   * `false` = the entry has no health to report (a credential kind on Tokens &
   * sessions is always "there"): no dot, no state words. Default `true`.
   */
  readonly showState?: boolean
  /** The selected integration's body. Called only for the one on screen. */
  readonly render: () => ReactNode
}

export interface IntegrationInstall {
  /** The capability the Addons catalog is filtered to. */
  readonly capability: string
  readonly label: string
}

export interface IntegrationGroup {
  /** Stable id; Connectivity's groups keep the pre-hub `?tab=` values. */
  readonly id: string
  /** Shown above the group's pills when a page has more than one group. */
  readonly label: string
  readonly entries: readonly IntegrationEntry[]
  /** Offers "install another" as a trailing pill. */
  readonly install?: IntegrationInstall
}

/**
 * The pill state of a provider whose truth is the registry's enabled set
 * (`addons.listCapabilityProviders` → `isActive`).
 */
export function providerPillState(isActive: boolean): {
  readonly state: IntegrationState
  readonly stateLabel: string
} {
  return isActive
    ? { state: 'ok', stateLabel: 'enabled' }
    : { state: 'off', stateLabel: 'disabled' }
}
