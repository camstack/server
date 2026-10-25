/**
 * The boot-time mirror of the few `system-settings` keys a SYNCHRONOUS reader
 * needs while the settings engine is isolated — D675.
 *
 * `ConfigManager.get` is synchronous and hub-main has only the async door
 * (D231). The capability registry's preference readers and the hub
 * `AuthService` still read synchronously, so the keys they need
 * (`PRELOADED_SYSTEM_PREFIXES` / `PRELOADED_SYSTEM_KEYS`) are read from the door
 * ONCE, when it is wired, into memory. No polling, no retry (D3): a failed read
 * stays failed until the next boot, and every reader is told so rather than
 * handed "unset".
 */
import type { ISettingsStoreProvider } from '@camstack/types'
import { loadSystemSettingsPrefix } from './settings-door-view.js'
import { SettingsReadUnavailableError } from './settings-read-error.js'
import {
  PRELOADED_SYSTEM_KEYS,
  PRELOADED_SYSTEM_PREFIXES,
  isPreloadedSystemKey,
} from './system-settings-policy.js'

type MirrorState =
  | { readonly kind: 'pending' }
  | { readonly kind: 'loaded'; readonly values: ReadonlyMap<string, unknown> }
  | { readonly kind: 'failed'; readonly error: string }

/** The outcome of the one boot read, for the caller that logs and replays it. */
export type SystemSettingsPreload =
  | { readonly kind: 'loaded'; readonly keyCount: number }
  | { readonly kind: 'failed'; readonly error: string }

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export class SystemSettingsMirror {
  private state: MirrorState = { kind: 'pending' }
  /** The door the current read belongs to; a replaced door owns the mirror. */
  private door: ISettingsStoreProvider | null = null
  private preload: Promise<SystemSettingsPreload> | null = null
  /**
   * Writes to preloaded keys made through THIS process. They win over the boot
   * read (they are newer) and survive a failed one, so an operator's Save is
   * reported back even when the boot read was lost.
   */
  private readonly writes = new Map<string, unknown>()

  /** Start the ONE read for `door`. Called by `ConfigManager.setSettingsDoor`. */
  load(door: ISettingsStoreProvider): void {
    this.door = door
    this.state = { kind: 'pending' }
    this.preload = this.read(door)
  }

  /** The in-flight / settled boot read, or `null` before any door. */
  whenLoaded(): Promise<SystemSettingsPreload> | null {
    return this.preload
  }

  /**
   * A preloaded key's value: `undefined` when the store holds none, or a THROW
   * (`preload-pending` / `preload-failed`) when it is not known.
   */
  get(key: string): unknown {
    if (this.writes.has(key)) return this.writes.get(key)
    const state = this.state
    switch (state.kind) {
      case 'loaded':
        return state.values.get(key)
      case 'pending':
        throw new SettingsReadUnavailableError(
          'ConfigManager.get',
          'preload-pending',
          `"${key}" is read from the boot-time mirror, whose one read has not settled yet`,
        )
      case 'failed':
        throw new SettingsReadUnavailableError(
          'ConfigManager.get',
          'preload-failed',
          `"${key}" is unknown: the boot-time read of the settings store failed (${state.error})`,
        )
    }
  }

  /** Record a write to a preloaded key so the mirror reports it. */
  noteWrite(key: string, value: unknown): void {
    if (isPreloadedSystemKey(key)) this.writes.set(key, value)
  }

  /** Every row under the preloaded prefixes plus each preloaded key. Never rejects. */
  private async read(door: ISettingsStoreProvider): Promise<SystemSettingsPreload> {
    try {
      const values = new Map<string, unknown>()
      for (const prefix of PRELOADED_SYSTEM_PREFIXES) {
        const rows = await loadSystemSettingsPrefix(door, prefix)
        for (const [suffix, value] of Object.entries(rows)) values.set(`${prefix}${suffix}`, value)
      }
      for (const key of PRELOADED_SYSTEM_KEYS) {
        const value = await door.get({ collection: 'system-settings', key })
        if (value !== undefined) values.set(key, value)
      }
      if (this.door === door) this.state = { kind: 'loaded', values }
      return { kind: 'loaded', keyCount: values.size }
    } catch (err: unknown) {
      const error = errorText(err)
      if (this.door === door) this.state = { kind: 'failed', error }
      return { kind: 'failed', error }
    }
  }
}
