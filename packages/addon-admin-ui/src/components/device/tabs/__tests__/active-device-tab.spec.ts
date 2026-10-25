/**
 * The READ side of the device tap URL.
 *
 * A `stream-offline` / camera `device-offline` notification taps through to
 * `/devices/<id>?tab=stream-broker`. This pins that the parameter is one the
 * device page parses — and, just as important, what it does with a tab this
 * device does not have, because these links outlive the device.
 */
import { describe, expect, it } from 'vitest'

import { DEFAULT_DEVICE_TAB, resolveActiveDeviceTab } from '../active-device-tab'

/** The tabs a camera carries once the pipeline addon's contribution lands. */
const CAMERA_TABS = [
  { id: 'overview' },
  { id: 'config' },
  { id: 'detection-pipeline' },
  { id: 'bindings' },
  { id: 'stream-broker' },
]

/** A plug: structural tabs only, no stream broker anywhere. */
const PLUG_TABS = [{ id: 'overview' }, { id: 'config' }]

describe('?tab=stream-broker', () => {
  it('opens the Stream Broker tab on a camera that has one', () => {
    expect(resolveActiveDeviceTab(CAMERA_TABS, 'stream-broker')).toBe('stream-broker')
  })

  it('is the id the WELL_KNOWN_TABS entry declares, not a label', () => {
    // `{ id: 'stream-broker', label: 'Stream Broker' }` — a link built from the
    // label would resolve to Overview forever and look like a broken tab.
    expect(resolveActiveDeviceTab(CAMERA_TABS, 'Stream Broker')).toBe(DEFAULT_DEVICE_TAB)
  })

  it('falls through to Overview on a device that has no such tab', () => {
    // The stale-link case: the camera was replaced by something else, or the
    // link was minted for a device type that never had the tab.
    expect(resolveActiveDeviceTab(PLUG_TABS, 'stream-broker')).toBe('overview')
  })

  it('falls through while the tab is still being DISCOVERED, and applies later', () => {
    // First paint: the aggregate has not answered, so only structural tabs
    // exist. The URL is not rewritten (that is the caller's contract), so the
    // same desired id resolves the moment the contribution lands.
    const structuralOnly = [{ id: 'overview' }, { id: 'config' }, { id: 'detection-pipeline' }]
    expect(resolveActiveDeviceTab(structuralOnly, 'stream-broker')).toBe('overview')
    expect(resolveActiveDeviceTab(CAMERA_TABS, 'stream-broker')).toBe('stream-broker')
  })

  it('no ?tab= at all is Overview', () => {
    expect(resolveActiveDeviceTab(CAMERA_TABS, DEFAULT_DEVICE_TAB)).toBe('overview')
    expect(resolveActiveDeviceTab([], 'anything')).toBe('overview')
  })
})
