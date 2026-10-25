/**
 * Credential redaction for `StorageLocation.config`.
 *
 * ── What was wrong ─────────────────────────────────────────────────────────
 * `storage.listLocations` carries no `auth` override, so it is `protected` —
 * every authenticated session reaches it, admin or not. The orchestrator
 * spread each stored row verbatim. `StorageLocation.config` is
 * `z.record(z.string(), z.unknown())`, and the SFTP / S3 / WebDAV providers
 * already declare `password`, `privateKey`, `privateKeyPassphrase`,
 * `secretAccessKey` and `token` inside it. Nothing was exposed only because
 * every location on the live hub is `filesystem-storage`, whose config is
 * `basePath` + `maxUsedGb`. The exposure arrives with the first remote
 * location, and three providers that collect one already ship.
 *
 * ── The mechanism ──────────────────────────────────────────────────────────
 * Schema-driven, never a hardcoded key list: each provider's
 * `getProviderInfo().configSchema` already says which of its fields hold a
 * credential, so it is the one thing that cannot drift from the provider.
 *
 * Two directions, and both are needed:
 *  - **out** — {@link redactLocationConfig} replaces every secret value with
 *    `REDACTED_SECRET` on the way to a caller.
 *  - **in** — {@link restoreRedactedSecrets} treats that same sentinel, sent
 *    back on an upsert, as "keep what is stored". Without it the wizard's
 *    edit-and-save round trip would write the sentinel into the config and
 *    lock the operator out of their own share on the first rename.
 *
 * ── The trap this deliberately avoids ──────────────────────────────────────
 * Keying redaction off `type: 'password'` alone MISSES a secret parked in a
 * `textarea`, and the SFTP provider parks an entire PEM private key there.
 * Discovery goes through `collectSecretConfigKeys`, whose discriminator is
 * `type === 'password' || secret === true`. A redaction that quietly misses a
 * credential is worse than none: it is a leak plus an assurance there is not
 * one.
 *
 * ── And the direction it can still fail in ─────────────────────────────────
 * A schema-driven mechanism has nothing to read while the provider is down,
 * and `listLocations` serves the row anyway. {@link secretKeysForConfig} is
 * where that is closed — an unknown provider withholds everything it did not
 * itself define, rather than nothing.
 */

import type { StorageLocation } from '@camstack/types'
import { collectSecretConfigKeys, REDACTED_SECRET } from '@camstack/types'

/**
 * The config keys the ORCHESTRATOR itself owns, as opposed to the ones a
 * provider owns. Every one of them is read by framework code that has no idea
 * which provider is behind the row:
 *
 *  - `basePath`     — `localCapacityOf`, `locationOccupancy`, the seed pass,
 *                     `LocationCard`'s summary, `StorageSection`;
 *  - `readOnly`     — drain mode; the recorder and post-analysis both filter on
 *                     it off a `listLocations` row;
 *  - `maxUsedGb`    — `resolveLocationMaxUsedBytes`;
 *  - `minFreePercent` — `resolveLocationThresholds`.
 *
 * None can be a credential, because the framework interprets all four itself.
 * That is what makes the list safe to hardcode — it is NOT a list of "keys we
 * believe are not secret", which is the rotting kind. It is the closed set of
 * keys this module, not a provider, defines the meaning of.
 */
export const FRAMEWORK_CONFIG_KEYS: ReadonlySet<string> = new Set([
  'basePath',
  'readOnly',
  'maxUsedGb',
  'minFreePercent',
])

/** Minimal shape needed off a provider's `getProviderInfo()` result. */
export interface ProviderInfoLike {
  readonly providerId: string
  readonly configSchema: unknown
}

/** Secret config keys a provider declares, derived from its own form schema. */
export function secretKeysOfProviderInfo(info: ProviderInfoLike): ReadonlySet<string> {
  return collectSecretConfigKeys(info.configSchema)
}

/**
 * Which keys of THIS config must be treated as secret.
 *
 * `declared` is what the provider's own schema said, or `undefined` when the
 * provider has not registered on this node and so has said nothing.
 *
 * The `undefined` branch is the one that matters. Redaction is schema-driven
 * and the schema arrives with the provider, so "no provider" used to mean "no
 * secret keys" — which redacted nothing while `listLocations` happily served
 * the row, because that method reads the store and never needs a provider.
 * That is a real window on every hub restart (the `remote-storage` group is a
 * separate runner that registers after the orchestrator boots) and it is
 * PERMANENT for a runner the CrashSupervisor marked terminally failed.
 *
 * So an unknown provider fails CLOSED: every key the framework does not itself
 * define is withheld. It over-redacts — a host name is hidden alongside the
 * password — and that is the correct direction, because the admin UI cannot
 * render a provider's form without that same provider's `configSchema` either,
 * so nothing that was working stops working.
 *
 * Withholding is done with the sentinel, never by dropping the key, so a save
 * performed in this degraded state still round-trips every value back intact.
 */
export function secretKeysForConfig(
  config: Readonly<Record<string, unknown>>,
  declared: ReadonlySet<string> | undefined,
): ReadonlySet<string> {
  if (declared !== undefined) return declared
  const out = new Set<string>()
  for (const key of Object.keys(config)) {
    if (!FRAMEWORK_CONFIG_KEYS.has(key)) out.add(key)
  }
  return out
}

/**
 * A copy of `config` with every declared secret replaced by the sentinel.
 * Returns the SAME object when there is nothing to redact, so the common case
 * (a filesystem location) allocates nothing.
 *
 * A key the provider declares secret but that is absent from the stored config
 * is NOT invented — an absent password must keep reading as absent, or the
 * wizard would show a credential where none is set and the write-back would
 * then "keep" a value that never existed.
 */
export function redactLocationConfig(
  config: Readonly<Record<string, unknown>>,
  secretKeys: ReadonlySet<string>,
): Readonly<Record<string, unknown>> {
  if (secretKeys.size === 0) return config
  let touched = false
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(config)) {
    if (secretKeys.has(key) && value !== undefined && value !== null && value !== '') {
      out[key] = REDACTED_SECRET
      touched = true
      continue
    }
    out[key] = value
  }
  return touched ? out : config
}

/** The same, applied to a whole location record. */
export function redactLocation(
  location: StorageLocation,
  secretKeys: ReadonlySet<string>,
): StorageLocation {
  const config = redactLocationConfig(location.config, secretKeys)
  if (config === location.config) return location
  return { ...location, config }
}

/**
 * Undo the redaction on the way IN: any secret key whose incoming value is the
 * sentinel is restored from what is already stored.
 *
 * A sentinel with NOTHING stored behind it is dropped rather than persisted —
 * writing the literal `__camstack_redacted__` as a password is a
 * lock-yourself-out bug that would only surface at the next connection
 * attempt, hours later, as an authentication failure with no explanation.
 */
export function restoreRedactedSecrets(
  incoming: Readonly<Record<string, unknown>>,
  stored: Readonly<Record<string, unknown>> | undefined,
  secretKeys: ReadonlySet<string>,
): Readonly<Record<string, unknown>> {
  if (secretKeys.size === 0) return incoming
  let touched = false
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(incoming)) {
    if (value !== REDACTED_SECRET || !secretKeys.has(key)) {
      out[key] = value
      continue
    }
    touched = true
    const previous = stored?.[key]
    if (previous !== undefined) out[key] = previous
    // else: drop the key entirely — see the docblock.
  }
  return touched ? out : incoming
}
