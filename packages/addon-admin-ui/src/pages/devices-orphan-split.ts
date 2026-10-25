/**
 * devices-orphan-split — the pure classification behind the Devices page's
 * "orphan devices" box.
 *
 * A device is orphan when it names NO registered integration at all, and an
 * accessory inherits orphan-ness from its parent chain (the parent owns the
 * integration link).
 *
 * WHICH integration a device belongs to is not decided here: it is
 * `resolveDeviceIntegration` / `deviceIntegrationResolver` in
 * `@camstack/ui-library` — `integrationId` first (a composed device, D659, is
 * served by `composer` but belongs to "Blocks"), `addonId` only for legacy
 * rows. This module only reads its answer: `orphan` is orphan; `unknown`
 * (integrations not answered yet — branded every device orphan for seconds
 * on 2026-08-18) and `unlinked` (names nothing) are not.
 */

import type { DeviceIntegrationResolver } from '@camstack/ui-library'

/** The fields the split reads — structural subset of DeviceItemDevice. */
export interface OrphanSplitDevice {
  readonly id: number
  readonly addonId?: string | null
  readonly integrationId?: string | null
  readonly parentDeviceId?: number | null
}

export interface OrphanSplit<T extends OrphanSplitDevice> {
  readonly activeDevices: readonly T[]
  readonly orphanDevices: readonly T[]
}

const MAX_PARENT_DEPTH = 32

export function splitOrphanDevices<T extends OrphanSplitDevice>(
  devices: readonly T[],
  /** `deviceIntegrationResolver(integrations)` — the one rule. While the
   *  integrations query is unanswered it resolves every row to `unknown`,
   *  which classifies nothing. */
  integrationOf: DeviceIntegrationResolver,
): OrphanSplit<T> {
  const isOrphan = (d: OrphanSplitDevice): boolean => integrationOf(d).kind === 'orphan'

  // Pass 1: every device classifies itself by its own addonId/integrationId.
  const selfOrphan = new Set<number>()
  for (const d of devices) {
    if (isOrphan(d)) selfOrphan.add(d.id)
  }
  // Pass 2: inherit from the parent chain — accessories of an orphan camera
  // are orphan even when their own addonId is fine.
  const byId = new Map<number, T>()
  for (const d of devices) byId.set(d.id, d)
  const isOrphanRecursive = (d: OrphanSplitDevice, depth = 0): boolean => {
    if (depth > MAX_PARENT_DEPTH) return false
    if (selfOrphan.has(d.id)) return true
    if (d.parentDeviceId == null) return false
    const parent = byId.get(d.parentDeviceId)
    if (!parent) return false
    return isOrphanRecursive(parent, depth + 1)
  }
  const active: T[] = []
  const orphan: T[] = []
  for (const d of devices) {
    if (isOrphanRecursive(d)) orphan.push(d)
    else active.push(d)
  }
  return { activeDevices: active, orphanDevices: orphan }
}
