import { describe, it, expect } from 'vitest'

import { deviceIntegrationResolver } from '@camstack/ui-library'
import { splitOrphanDevices, type OrphanSplitDevice } from '../devices-orphan-split'

/** Registered integrations built from (id, addonId) pairs — the shape
 *  `integrations.list` answers with, reduced to what the rule reads. */
function registered(...pairs: readonly (readonly [string, string])[]) {
  return deviceIntegrationResolver(pairs.map(([id, addonId]) => ({ id, addonId })))
}

function dev(
  id: number,
  addonId: string,
  parentDeviceId: number | null = null,
  integrationId?: string | null,
): OrphanSplitDevice {
  return { id, addonId, parentDeviceId, integrationId }
}

describe('splitOrphanDevices', () => {
  it('an UNANSWERED integrations list classifies nothing as orphan', () => {
    // Live failure (2026-08-18): devices and integrations are two separate
    // queries. On a slow server, devices lands first, integrations is still
    // undefined, and the split ran against an EMPTY known-addon set — every
    // device flashed as orphan for seconds. "Not answered yet" is not an
    // answer, and must never classify.
    const { activeDevices, orphanDevices } = splitOrphanDevices(
      [dev(1, 'provider-reolink'), dev(2, 'gone-addon')],
      deviceIntegrationResolver(undefined),
    )
    expect(orphanDevices).toEqual([])
    expect(activeDevices.map((d) => d.id)).toEqual([1, 2])
  })

  it('a LOADED empty integrations list is an answer: addon-linked devices are orphan', () => {
    const { orphanDevices } = splitOrphanDevices([dev(1, 'provider-reolink')], registered())
    expect(orphanDevices.map((d) => d.id)).toEqual([1])
  })

  it('splits by known addon and inherits orphan-ness from the parent chain', () => {
    const { activeDevices, orphanDevices } = splitOrphanDevices(
      [
        dev(1, 'provider-reolink'),
        dev(2, 'gone-addon'),
        dev(3, 'provider-reolink', 2), // healthy addon, orphan parent → orphan
        dev(4, 'provider-reolink', 1),
      ],
      registered(['int_reolink', 'provider-reolink']),
    )
    expect(orphanDevices.map((d) => d.id)).toEqual([2, 3])
    expect(activeDevices.map((d) => d.id)).toEqual([1, 4])
  })

  it('a device with no addonId is never orphan', () => {
    const { orphanDevices } = splitOrphanDevices([dev(1, '')], registered())
    expect(orphanDevices).toEqual([])
  })

  // D659: a composed device is created under the "Blocks" integration
  // (registered, e.g. int_0024) but its row's addonId is 'composer' — the
  // addon that owns and SERVES it, not the integration that created it. Its
  // `integrationId` names a registered integration, so it is active
  // regardless of whether 'composer' itself is a registered addonId.
  it('a composed device (known integrationId, addonId not a registered integration) is active', () => {
    const { activeDevices, orphanDevices } = splitOrphanDevices(
      [dev(4602, 'composer', null, 'int_0024')],
      registered(['int_0024', 'core-blocks']),
    )
    expect(orphanDevices).toEqual([])
    expect(activeDevices.map((d) => d.id)).toEqual([4602])
  })

  it('a device whose integrationId does not name a registered integration is orphan', () => {
    const { orphanDevices } = splitOrphanDevices(
      [dev(4602, 'composer', null, 'int_deleted')],
      registered(['int_0024', 'core-blocks']),
    )
    expect(orphanDevices.map((d) => d.id)).toEqual([4602])
  })

  it('a device with no integrationId falls back to the addonId check (legacy)', () => {
    const { orphanDevices } = splitOrphanDevices(
      [dev(1, 'gone-addon', null, null)],
      registered(['int_reolink', 'provider-reolink'], ['int_0024', 'core-blocks']),
    )
    expect(orphanDevices.map((d) => d.id)).toEqual([1])
  })
})
