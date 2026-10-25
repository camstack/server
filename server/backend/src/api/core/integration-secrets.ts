/**
 * The integration-settings door of the keychain (D787). An integration's
 * settings (a Wyze password, a PetKit account password) live in the
 * `integration_settings` table, written by `integrations.create` /
 * `setSettings` and read back by the integration's own addon through
 * `integrations.getSettings` — and by the admin form through the same method.
 *
 * - WRITE: the keys the form's schema declares secret (`secretKeys`, by type)
 *   and every key that already holds a marker go through the keychain save
 *   path, OWNED by the integration's addon (`integration/<id>` scope). A value
 *   equal to an inline pre-keychain one stays inline; `''` keeps.
 * - READ, by the owning addon (the caller the transport stamped): markers
 *   resolve to values. READ, by anyone else (the admin form): markers become
 *   their "set" views — the value never leaves the hub.
 */
import {
  type IIntegrationRegistry,
  isSecretMarker,
  resolveSecretMarkers,
  type SecretsAccess,
  secretTreeFromPaths,
  toSecretFieldView,
  transformSecretWrite,
} from '@camstack/types'

export interface IntegrationSecretDeps {
  readonly registry: Pick<IIntegrationRegistry, 'getIntegrationSettings' | 'setIntegrationSettings'>
  /** The integration addon's keychain handle (hub in-process delegate), or null without a keychain. */
  readonly secrets: SecretsAccess | null
  readonly onOrphaned?: (refs: readonly string[]) => void
}

export async function writeIntegrationSettings(
  deps: IntegrationSecretDeps,
  input: {
    readonly integrationId: string
    readonly settings: Record<string, unknown>
    readonly secretKeys: readonly string[]
    /** Written by the operator (the admin form), not by the integration's addon. */
    readonly operatorWrite?: boolean
  },
): Promise<void> {
  if (deps.secrets === null) {
    return deps.registry.setIntegrationSettings(input.integrationId, input.settings)
  }
  const stored = (await deps.registry.getIntegrationSettings(input.integrationId)) ?? {}
  const markerKeys = Object.entries(stored)
    .filter(([, v]) => isSecretMarker(v))
    .map(([k]) => k)
  const tree = secretTreeFromPaths([...new Set([...input.secretKeys, ...markerKeys])])
  if (tree.size === 0) {
    return deps.registry.setIntegrationSettings(input.integrationId, input.settings)
  }
  const result = await transformSecretWrite({
    tree,
    secrets: deps.secrets,
    patch: input.settings,
    stored,
    scope: { kind: 'integration', integrationId: input.integrationId },
    operatorWrite: input.operatorWrite === true,
  })
  if (Object.keys(result.patch).length > 0) {
    await deps.registry.setIntegrationSettings(input.integrationId, result.patch)
  }
  const { orphaned } = await result.afterWrite()
  if (orphaned.length > 0) deps.onOrphaned?.(orphaned)
}

/** The text `String(...)` makes of an object — a keychain marker some copy coerced. */
export const COERCED_MARKER_TEXT = '[object Object]'

/**
 * A stored value that should be a keychain marker and is not:
 * - `coerced-marker`: the literal "[object Object]" — a marker the 2026-10
 *   records migration stringified (repaired by hand on the operator hubs,
 *   D900); the keychain entry may still exist.
 * - `plaintext`: a key the addon's schema stores in the keychain holds a
 *   plain string.
 */
export interface SuspectIntegrationSecret {
  readonly key: string
  readonly kind: 'coerced-marker' | 'plaintext'
}

export interface ReadIntegrationSettingsInput {
  readonly integrationId: string
  readonly forOwner: boolean
  /** The keys the integration addon's schema stores in the keychain (by type). */
  readonly secretKeys?: ReadonlySet<string>
  /** Told about every {@link SuspectIntegrationSecret}; the caller logs it loudly. */
  readonly onSuspectSecret?: (suspect: SuspectIntegrationSecret) => void
}

function suspectKind(
  key: string,
  value: unknown,
  secretKeys: ReadonlySet<string> | undefined,
): SuspectIntegrationSecret['kind'] | null {
  if (value === COERCED_MARKER_TEXT) return 'coerced-marker'
  if (secretKeys?.has(key) === true && typeof value === 'string' && value.length > 0) {
    return 'plaintext'
  }
  return null
}

export async function readIntegrationSettings(
  deps: Pick<IntegrationSecretDeps, 'registry' | 'secrets'>,
  input: ReadIntegrationSettingsInput,
): Promise<Record<string, unknown>> {
  const stored = await deps.registry.getIntegrationSettings(input.integrationId)
  const suspects = new Set<string>()
  for (const [key, value] of Object.entries(stored)) {
    const kind = suspectKind(key, value, input.secretKeys)
    if (kind === null) continue
    suspects.add(key)
    input.onSuspectSecret?.({ key, kind })
  }
  if (input.forOwner) {
    if (deps.secrets === null) return stored
    return (await resolveSecretMarkers(stored, deps.secrets)).value
  }
  // Anyone but the owner — the admin form — never receives a secret's text:
  // a marker becomes its "set" view, and so does a suspect plaintext.
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(stored)) {
    out[key] = isSecretMarker(value) || suspects.has(key) ? toSecretFieldView(value) : value
  }
  return out
}
