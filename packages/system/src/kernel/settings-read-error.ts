/**
 * The refusal a SYNCHRONOUS settings reader raises when it cannot answer — D675.
 *
 * `ConfigManager`'s sync readers (`get`, `getSection`, `getAddonConfig`, …)
 * used to answer `{}` / a runtime default whenever no sync `ISettingsStore`
 * was wired. Since D231 isolated `sqlite-settings`, hub-main never gets one:
 * only the async door. So every such read answered "nothing stored" for the
 * life of the process, and "nothing stored" is exactly what a store holding
 * nothing looks like (D315, D393). The readers now refuse instead, and this
 * is what they throw, so a caller can tell "the store could not be asked"
 * from every other failure and from "never written".
 */

/**
 * Why the read was refused.
 *
 * - `door-only` — the engine is isolated: only the async door is wired, and a
 *   synchronous caller cannot await it. Use the settings view instead.
 * - `not-wired` — no backend at all yet (the D294 window, before
 *   `setSettingsStore` / `setSettingsDoor`).
 * - `preload-pending` — the key is one of the few the kernel loads from the
 *   door into memory at boot, and that one read has not settled yet.
 * - `preload-failed` — that boot read failed; the value is unknown until the
 *   next boot (one read, no polling — D3).
 * - `read-failed` — the async read itself threw.
 */
export type SettingsReadRefusal =
  | 'door-only'
  | 'not-wired'
  | 'preload-pending'
  | 'preload-failed'
  | 'read-failed'

export class SettingsReadUnavailableError extends Error {
  override readonly name = 'SettingsReadUnavailableError'

  constructor(
    /** The reader that refused, e.g. `ConfigManager.getAddonConfig`. */
    readonly reader: string,
    readonly reason: SettingsReadRefusal,
    detail: string,
  ) {
    super(`[${reader}] settings read refused (${reason}): ${detail}`)
  }
}

/** Narrow an unknown throw to {@link SettingsReadUnavailableError}. */
export function isSettingsReadUnavailable(err: unknown): err is SettingsReadUnavailableError {
  return err instanceof SettingsReadUnavailableError
}
