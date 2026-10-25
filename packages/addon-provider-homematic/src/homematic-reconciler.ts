/**
 * Pure helpers for linking Homematic brokers to integration records and for
 * cleaning up brokers when their spawning integration is deleted (Approach A).
 *
 * Both functions are generic and side-effect-free — identical in behaviour to
 * the Home Assistant addon's reconciler. They are kept per-addon (rather than
 * shared) so each provider bundles its own copy and there is no cross-addon
 * import coupling.
 */

/** A broker carrying an optional integration FK. */
export interface ReconcilerBroker {
  readonly id: string
  readonly integrationId?: string
}

/** An integration record linked (optionally) to a broker. */
export interface ReconcilerIntegrationLink {
  readonly id: string
  readonly brokerId: string | undefined
}

/**
 * Brokers that were spawned by an integration (carry an integrationId FK) and
 * whose integration no longer exists should be cleaned up. Brokers with no
 * integrationId were created manually and are never auto-removed.
 */
export function computeBrokerCleanup(
  brokers: readonly ReconcilerBroker[],
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
export function linkBrokersToIntegrations<TBroker extends ReconcilerBroker>(
  brokers: readonly TBroker[],
  integrations: readonly ReconcilerIntegrationLink[],
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
