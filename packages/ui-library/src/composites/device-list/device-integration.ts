/**
 * resolveDeviceIntegration — the ONE answer to "which integration does this
 * device belong to".
 *
 * A device row carries two different ids:
 *  - `integrationId` — the integration that CREATED it (`IntegrationWithState.id`).
 *  - `addonId` — the addon that owns and SERVES it.
 *
 * They can differ. A composed device (D659) is created under the "Blocks"
 * integration (`int_0024`, whose own `addonId` is `core-blocks`) but is
 * served by the `composer` addon, so its row reads `addonId: 'composer'`.
 * Resolving by `addonId` put it under no integration at all: the Devices
 * filter, the Integration page's list, the device header and the orphan box
 * each asked the question their own way, and every one of them got it wrong.
 *
 * The rule:
 *  1. `integrationId` present ⇒ it is authoritative. The device belongs to
 *     the integration with that `id`, or — when no registered integration has
 *     it — to none (orphan), WHATEVER its `addonId` says.
 *  2. No `integrationId` (legacy rows) ⇒ the `addonId` IS the integration
 *     link: the device belongs to the first integration whose `addonId`
 *     matches, or is orphan when none does.
 *  3. A row that names neither is `unlinked` — it points at nothing, so it
 *     cannot be orphaned by a missing integration.
 *
 * And the load-bearing case: `integrations === null | undefined` means the
 * integrations query has NOT ANSWERED. That is `unknown`, never `orphan` —
 * an unanswered list is not an empty one (D315), and classifying against it
 * branded every device orphan for seconds on a slow server (2026-08-18).
 */

/** The two fields of a device row the rule reads. */
export interface DeviceIntegrationLink {
  readonly addonId?: string | null
  readonly integrationId?: string | null
}

/** The two fields of an `integrations.list` row the rule reads. */
export interface DeviceIntegrationRef {
  readonly id: string
  readonly addonId: string
}

export type DeviceIntegrationResolution<I extends DeviceIntegrationRef = DeviceIntegrationRef> =
  /** The device belongs to this registered integration. */
  | { readonly kind: 'resolved'; readonly integration: I }
  /** The device names an integration link that no registered integration answers. */
  | { readonly kind: 'orphan' }
  /** The device names no link at all (no `integrationId`, empty `addonId`). */
  | { readonly kind: 'unlinked' }
  /** The integrations query has not answered yet — nothing can be said. */
  | { readonly kind: 'unknown' }

export type DeviceIntegrationResolver<I extends DeviceIntegrationRef = DeviceIntegrationRef> = (
  device: DeviceIntegrationLink,
) => DeviceIntegrationResolution<I>

function nonEmpty(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.length > 0
}

export function resolveDeviceIntegration<I extends DeviceIntegrationRef>(
  device: DeviceIntegrationLink,
  /** The `integrations.list` answer, or `null`/`undefined` while unanswered. */
  integrations: readonly I[] | null | undefined,
): DeviceIntegrationResolution<I> {
  return deviceIntegrationResolver(integrations)(device)
}

/**
 * The rule itself, prepared once over a list for per-row use on a large
 * fleet (two map lookups per row, not two scans). `resolveDeviceIntegration`
 * is this, applied to one device; `<DeviceList integrationOf>` takes the
 * returned resolver.
 */
export function deviceIntegrationResolver<I extends DeviceIntegrationRef>(
  integrations: readonly I[] | null | undefined,
): DeviceIntegrationResolver<I> {
  if (integrations === null || integrations === undefined) {
    return () => ({ kind: 'unknown' })
  }
  const byId = new Map<string, I>()
  const byAddon = new Map<string, I>()
  for (const i of integrations) {
    if (!byId.has(i.id)) byId.set(i.id, i)
    // Legacy fallback: the FIRST integration with that addonId wins.
    if (!byAddon.has(i.addonId)) byAddon.set(i.addonId, i)
  }
  return (device) => {
    if (nonEmpty(device.integrationId)) {
      const hit = byId.get(device.integrationId)
      return hit !== undefined ? { kind: 'resolved', integration: hit } : { kind: 'orphan' }
    }
    if (nonEmpty(device.addonId)) {
      const hit = byAddon.get(device.addonId)
      return hit !== undefined ? { kind: 'resolved', integration: hit } : { kind: 'orphan' }
    }
    return { kind: 'unlinked' }
  }
}
