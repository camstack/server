/** A board carrying an optional integration FK. */
export interface ReconcilerBroker {
  readonly id: string
  readonly integrationId?: string
}

/** An integration record linked (optionally) to a board. */
export interface ReconcilerIntegrationLink {
  readonly id: string
  readonly brokerId: string | undefined
}

/**
 * Boards that were spawned by an integration (carry an integrationId FK) whose
 * integration no longer exists. Boards added by hand carry no FK and are never
 * collected.
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
 * Stamp the integrationId FK onto each board an integration references through
 * its `brokerId` setting. Pure: unchanged entries keep their reference.
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
