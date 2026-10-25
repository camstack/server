/**
 * Single canonical writer for the collection-capability enable/disable
 * preference.
 *
 * A collection capability can have individual providers disabled by an
 * operator. The disabled-set must survive a hub reboot — otherwise a
 * provider an operator deliberately disabled (TURN relay, an auth or
 * export backend, …) silently re-enables on the next restart.
 *
 * The persistence key/format is `capabilities.collection.<capName>` holding
 * `JSON.stringify({ disabled: string[] })`. This module is the ONE place
 * that writes that key so the format never drifts. It is called ONLY from
 * `capability-preference-writes.ts`, which persists BEFORE it switches the
 * live registry (D675 amendment). The kernel `CapabilityRegistry` reads it
 * back at boot through the `CollectionConfigReader` hook wired in
 * `addon-registry.service.ts`.
 */
import type { ConfigService } from '../../core/config/config.service'

/** ConfigService key holding the persisted disabled-set for a collection cap. */
export function collectionPreferenceKey(capability: string): string {
  return `capabilities.collection.${capability}`
}

/**
 * Persist the disabled-addonId set for a collection capability: the set the
 * registry WILL hold once the write has landed and is applied.
 */
export async function persistCollectionDisabled(
  configService: Pick<ConfigService, 'set'>,
  capability: string,
  disabled: readonly string[],
): Promise<void> {
  await configService.set(
    collectionPreferenceKey(capability),
    JSON.stringify({ disabled: [...disabled] }),
  )
}
