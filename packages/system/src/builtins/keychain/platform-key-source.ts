/**
 * The OS-keychain master key of a DESKTOP hub.
 *
 * Electron's `safeStorage` exists only in the Electron main process, and the
 * hub runs as a plain Node child of it. So the desktop app reads (or creates)
 * the master key through `safeStorage`, and hands the raw bytes to the hub
 * over an inherited pipe (`--keychain-key-fd=<n>`) — never an env var, never a
 * file at rest in the clear. The hub's boot reads the descriptor once and
 * registers the key here; the keychain builtin, in the same process, asks.
 *
 * Process-global through a registered symbol, so a second copy of this module
 * (an addon bundle) sees the same key rather than none.
 */

export interface PlatformKeychainKey {
  /** Where it came from, for the status page (`macOS Keychain`, `Windows DPAPI`, …). */
  readonly label: string
  readonly key: Buffer
}

const SLOT = Symbol.for('camstack.keychain.platform-key')

/** Register the platform key. Called once, by the hub's boot. */
export function setPlatformKeychainKey(entry: PlatformKeychainKey): void {
  Reflect.set(globalThis, SLOT, entry)
}

/** Drop the platform key (tests). */
export function clearPlatformKeychainKey(): void {
  Reflect.deleteProperty(globalThis, SLOT)
}

function isPlatformKey(value: unknown): value is PlatformKeychainKey {
  if (value === null || typeof value !== 'object') return false
  const label: unknown = Reflect.get(value, 'label')
  const key: unknown = Reflect.get(value, 'key')
  return typeof label === 'string' && Buffer.isBuffer(key)
}

/** The platform key, when this hub was started by the desktop app with one. */
export function getPlatformKeychainKey(): PlatformKeychainKey | null {
  const value: unknown = Reflect.get(globalThis, SLOT)
  return isPlatformKey(value) ? value : null
}
