/**
 * The notification targets as instances of the function cap `notification-output` (D1013): what
 * `useInstancesOfCap` reads. A fixture lists its targets once and spreads
 * {@link notificationInstanceHandlers}; a fixture that already answers
 * `integrationInstances.describe` / `listInstances` for other addons calls
 * {@link describeNotificationHolder} / {@link listNotificationHolder} from its own handlers first.
 */
export interface FixtureTarget {
  readonly id: string
  readonly name: string
  /** The adapter kind (`ntfy`); the record kind is `notify-<kind>`. */
  readonly kind: string
  readonly addonId: string
  readonly enabled?: boolean
  readonly config?: Readonly<Record<string, unknown>>
}

export function notificationHolders(targets: readonly FixtureTarget[]): readonly string[] {
  return [...new Set(targets.map((t) => t.addonId))]
}

export function describeNotificationHolder(
  targets: readonly FixtureTarget[],
  addonId: string,
): unknown {
  const kinds = [...new Set(targets.filter((t) => t.addonId === addonId).map((t) => t.kind))]
  return {
    role: 'services',
    instanceMode: 'multiple',
    kind: 'target',
    canTest: true,
    mintsId: true,
    kinds: kinds.map((kind) => ({
      id: `notify-${kind}`,
      label: kind,
      functionCap: 'notification-output',
    })),
  }
}

export function listNotificationHolder(
  targets: readonly FixtureTarget[],
  addonId: string,
): readonly unknown[] {
  return targets
    .filter((t) => t.addonId === addonId)
    .map((t) => ({
      id: t.id,
      name: t.name,
      kind: `notify-${t.kind}`,
      configured: true,
      enabled: t.enabled !== false,
      formValues: { name: t.name, enabled: t.enabled !== false, ...t.config },
    }))
}

/** The three reads, as handlers; for a fixture with no other integration-instances answers. */
export function notificationInstanceHandlers(
  targets: readonly FixtureTarget[],
): Record<string, unknown> {
  return {
    'capabilities.getCapability': (i: { name: string }) => ({
      name: i.name,
      mode: i.name === 'notification-output' ? 'collection' : 'singleton',
      providers: i.name === 'notification-output' ? notificationHolders(targets) : [i.name],
      activeProvider: i.name === 'notification-output' ? null : i.name,
      disabledProviders: [],
    }),
    'integrationInstances.describe': (i: { addonId: string }) =>
      describeNotificationHolder(targets, i.addonId),
    'integrationInstances.listInstances': (i: { addonId: string }) =>
      listNotificationHolder(targets, i.addonId),
  }
}
