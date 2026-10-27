/**
 * Every cap whose provider reads a `callerAddonId` in its input (the keychain's
 * owner check, device-history's `not-owner`, records' owner).
 *
 * The stamp is set ONLY by the transport (`stampCallerAddonId`, or stated by a
 * hub in-process caller). HTTP/WS mounts parse input with `.loose()`, so a
 * session could add the key itself and act as another addon — those procedures
 * strip it when `ctx.req` is present. Mesh / `$core-caps` calls have no request;
 * the transport stamp must survive to the provider.
 */
export const CALLER_STAMPED_CAPABILITIES: readonly string[] = [
  'keychain',
  'device-history',
  'records',
  // `getSettings` hands the integration's own addon its secrets RESOLVED; `setSettings` reads the
  // stamp as "the driver, not the operator" and skips the operator-write handling.
  'integrations',
  // `persistConfig` reads it as `operatorWrite` (a driver's write vs the operator's), and
  // `listAll` attributes the fleet read to it.
  'device-manager',
  // `reportAutomationRun` / `getAutomationRunState` are refused unless the stamp is
  // `core-block-<blockId>`: a block writes only its own row of the `runs` ledger.
  'core-blocks',
]

/** A copy of `input` without the caller stamp. Anything that is not a plain object passes through. */
export function withoutCallerStamp<T>(input: T): T {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return input
  if (!Object.prototype.hasOwnProperty.call(input, 'callerAddonId')) return input
  const rest = Object.fromEntries(Object.entries(input).filter(([key]) => key !== 'callerAddonId'))
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- documented type boundary: the same object minus one key
  return rest as T
}
