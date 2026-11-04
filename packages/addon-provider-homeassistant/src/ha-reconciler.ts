/**
 * Brokers that were spawned by an integration (carry an integrationId FK) and
 * whose integration no longer exists should be cleaned up. Brokers with no
 * integrationId were created manually and are never auto-removed.
 */
/**
 * Brokers whose spawning integration is gone.
 *
 * **The caller REPORTS these; it does not delete them.** This function used to
 * drive a delete, and on 2026-08-05 that erased the operator's Home Assistant
 * broker — host and token — when `integrations.list` returned an empty array
 * during a hub restart: nothing "survived", so everything was an orphan. A
 * broker cannot be rebuilt from an integration record, so the loss was
 * permanent and the doorbell simply stopped existing.
 *
 * Kept as a pure query because naming an orphan is useful; acting on one
 * automatically is not.
 */
export function computeBrokerCleanup(
  brokers: readonly { id: string; integrationId?: string }[],
  survivingIntegrationIds: ReadonlySet<string>,
): string[] {
  return brokers
    .filter((b) => b.integrationId !== undefined && !survivingIntegrationIds.has(b.integrationId))
    .map((b) => b.id)
}
