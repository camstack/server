/**
 * Where a system event's tap lands.
 *
 * Every assertion here names the ID it expects to find IN the URL, not merely
 * that a URL came back: a `?node=` on the wrong page, or a link to
 * `/system/addons` with no node on it, is exactly the failure this feature
 * exists to prevent and it is invisible to a "returns a string" test. The
 * matching read-side assertions — that the admin pages parse these params back
 * — live in `packages/addon-admin-ui/src/lib/__tests__/node-url-selection.spec.ts`,
 * `.../pages/system/__tests__/Addons.spec.tsx` ("the node in the URL is the
 * node on screen"), `.../Cluster.spec.tsx` and
 * `.../components/device/tabs/__tests__/active-device-tab.spec.ts`. The two
 * packages are pinned together by `scripts/check-notification-tap-targets.ts`.
 */
import { describe, expect, it } from 'vitest'

import { systemEventTapPath, systemEventTapUrl } from '../system-event-tap-url.js'

const BASE = 'https://camstack.example.top'

describe('an addon update taps through to the Addons page, scoped to its node', () => {
  it('embeds the node the update is about', () => {
    const url = systemEventTapUrl({ kind: 'addon-update-available', nodeId: 'agent-a' }, BASE)
    expect(url).toBe('https://camstack.example.top/system/addons?node=agent-a')
    // The id is IN the URL — the property the page needs, stated separately
    // from the byte-for-byte form so a formatting change cannot quietly drop it.
    expect(url).toContain('node=agent-a')
  })

  it('percent-encodes a node id that is not URL-safe', () => {
    expect(systemEventTapUrl({ kind: 'addon-update-available', nodeId: 'a b&c' }, BASE)).toBe(
      'https://camstack.example.top/system/addons?node=a%20b%26c',
    )
  })

  it('an update spanning several nodes has no single answer, so it scopes to none', () => {
    // `nodeIds.length > 1` ⇒ the intake sets no `nodeId`. The page is still
    // right; inventing one of the nodes would open the wrong one.
    expect(systemEventTapPath({ kind: 'addon-update-available' })).toBe('/system/addons')
  })
})

describe("a node's own update taps through to the Cluster page, not to Addons", () => {
  it('goes to /system/nodes?node=', () => {
    expect(systemEventTapUrl({ kind: 'server-update-available', nodeId: 'hub' }, BASE)).toBe(
      'https://camstack.example.top/system/nodes?node=hub',
    )
  })

  it('never routes a server update to the Addons page, which hides @camstack/server', () => {
    // The Addons page filters out every framework package AND the node root
    // package, so a link there would open a list that cannot contain the thing
    // the notification is about. This is the assertion that pins the WHY.
    const path = systemEventTapPath({ kind: 'server-update-available', nodeId: 'hub' })
    expect(path).not.toContain('/system/addons')
    expect(path).toContain('/system/nodes')
  })
})

describe('a camera that stopped taps through to its device page, Stream Broker tab', () => {
  it('a stream-offline names the device and the tab', () => {
    const url = systemEventTapUrl({ kind: 'stream-offline', deviceId: 102 }, BASE)
    expect(url).toBe('https://camstack.example.top/devices/102?tab=stream-broker')
    expect(url).toContain('/devices/102')
    expect(url).toContain('tab=stream-broker')
  })

  it('a device-offline on a CAMERA gets the same tab', () => {
    expect(
      systemEventTapPath({ kind: 'device-offline', deviceId: 101, deviceType: 'camera' }),
    ).toBe('/devices/101?tab=stream-broker')
  })

  it('a device-offline on a PLUG gets the device page and no stream tab', () => {
    // A zigbee plug has no Stream Broker tab. The page would fall back to
    // Overview anyway — but asking for a tab we cannot know exists is a claim
    // nobody checked, and one zigbee plug already produced sixteen
    // "camera offline" notifications here once.
    expect(
      systemEventTapPath({ kind: 'device-offline', deviceId: 2018, deviceType: 'outlet' }),
    ).toBe('/devices/2018')
  })

  it('an unknown device type is not assumed to be a camera', () => {
    expect(systemEventTapPath({ kind: 'device-offline', deviceId: 2018 })).toBe('/devices/2018')
  })

  it('the legacy camera-offline kind still acts — an OLD row is the one that matters', () => {
    // Rows enqueued before the `camera-*` → `device-*` rename are exactly the
    // ones sitting in history with a tap nobody could use.
    expect(systemEventTapPath({ kind: 'camera-offline', deviceId: 102 })).toBe(
      '/devices/102?tab=stream-broker',
    )
  })

  it('the system placeholder device id (0) is not a device', () => {
    expect(systemEventTapPath({ kind: 'device-offline', deviceId: 0 })).toBeNull()
    expect(systemEventTapPath({ kind: 'stream-offline' })).toBeNull()
  })
})

describe('a RECOVERY taps through to the same page as the failure it undoes', () => {
  /*
   * The live row, 2026-08-30, delivered to the operator's phone with
   * `tapAction: { type: "OPEN_NOTIFICATION", value: null }`:
   *
   *   "Il dispositivo Camera sala feste è online"
   *
   * `device-online` had no entry, so the tap opened the app and nothing else —
   * while `device-offline`, the same camera an hour earlier, opened the Stream
   * Broker tab. "Is it really back, and what did it do while it was gone" is
   * an action, on the same page, and D305's rule is that a notification names
   * the page that can act on it. Every recovery whose failure twin is already
   * mapped is here; a kind whose DOWN direction has no action still has none.
   */
  it('device-online lands where device-offline lands', () => {
    expect(systemEventTapPath({ kind: 'device-online', deviceId: 107, deviceType: 'camera' })).toBe(
      '/devices/107?tab=stream-broker',
    )
    expect(systemEventTapPath({ kind: 'device-online', deviceId: 107, deviceType: 'camera' })).toBe(
      systemEventTapPath({ kind: 'device-offline', deviceId: 107, deviceType: 'camera' }),
    )
  })

  it('a non-camera coming back gets the device page, and still no stream tab', () => {
    expect(
      systemEventTapPath({ kind: 'device-online', deviceId: 2018, deviceType: 'outlet' }),
    ).toBe('/devices/2018')
  })

  it('stream-online is a camera by construction, exactly like stream-offline', () => {
    expect(systemEventTapUrl({ kind: 'stream-online', deviceId: 102 }, BASE)).toBe(
      'https://camstack.example.top/devices/102?tab=stream-broker',
    )
  })

  it('the legacy camera-online still acts — an OLD row is the one that matters', () => {
    expect(systemEventTapPath({ kind: 'camera-online', deviceId: 102 })).toBe(
      '/devices/102?tab=stream-broker',
    )
  })

  it('a recovery with no device is still no link', () => {
    expect(systemEventTapPath({ kind: 'device-online', deviceId: 0 })).toBeNull()
    expect(systemEventTapPath({ kind: 'stream-online' })).toBeNull()
  })
})

describe('kinds with no action, and no reachable base', () => {
  it('a kind whose action nobody decided taps through to nothing', () => {
    // Deliberate: `detection-blind`, the alarm family and the *-updated
    // completions have no page an operator must go and act on. A link that
    // opens something unrelated is worse than no link.
    expect(systemEventTapPath({ kind: 'detection-blind', deviceId: 101 })).toBeNull()
    expect(systemEventTapPath({ kind: 'alarm-triggered', deviceId: 1 })).toBeNull()
    expect(systemEventTapPath({ kind: 'addon-updated', nodeId: 'hub' })).toBeNull()
    expect(systemEventTapPath({ kind: 'node-offline', nodeId: 'hub' })).toBeNull()
  })

  it('no reachable base means no URL — a dead link is worse than none', () => {
    expect(systemEventTapUrl({ kind: 'addon-update-available', nodeId: 'hub' }, null)).toBeNull()
    expect(systemEventTapUrl({ kind: 'addon-update-available', nodeId: 'hub' }, '')).toBeNull()
  })

  it('tolerates a base with trailing slashes', () => {
    expect(systemEventTapUrl({ kind: 'server-update-available', nodeId: 'hub' }, `${BASE}//`)).toBe(
      'https://camstack.example.top/system/nodes?node=hub',
    )
  })

  it('the base is never hard-coded — the URL is whatever the ladder answered', () => {
    expect(
      systemEventTapUrl({ kind: 'addon-update-available', nodeId: 'hub' }, 'http://10.x.x.x:3000'),
    ).toBe('http://10.x.x.x:3000/system/addons?node=hub')
  })
})
