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

/**
 * Stamp the integrationId FK onto each broker that an integration references
 * via its settings.brokerId, so cleanup-on-delete can later collect orphans.
 * Pure: returns a NEW array; does not mutate. Only the entries that change are
 * replaced (immutably) — unchanged entries keep their original object reference.
 */
export function linkBrokersToIntegrations<TBroker extends { id: string; integrationId?: string }>(
  brokers: readonly TBroker[],
  integrations: readonly { id: string; brokerId: string | undefined }[],
): TBroker[] {
  const brokerToIntegration = new Map<string, string>()
  for (const integration of integrations) {
    if (integration.brokerId !== undefined) {
      brokerToIntegration.set(integration.brokerId, integration.id)
    }
  }

  return brokers.map((b) => {
    const integrationId = brokerToIntegration.get(b.id)
    if (integrationId !== undefined && b.integrationId !== integrationId) {
      return { ...b, integrationId }
    }
    return b
  })
}
