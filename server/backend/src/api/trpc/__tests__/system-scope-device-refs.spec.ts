/**
 * F1 #3 — the per-device check reaches SYSTEM-scope cap methods that carry a
 * device reference.
 *
 * The hole this closes: the matcher only extracted `input.deviceId` when the
 * CAP was declared `scope: 'device'`. 124 system-scope methods also take a
 * deviceId (`recordingArchive.getDeviceConfig`, `faceGallery.*`,
 * `pipelineOrchestrator.*`, …), so a non-admin holding `category:system[view]`
 * could read ANY camera's recordings/faces regardless of which cameras they
 * were granted. `METHOD_DEVICE_SELECTORS` (codegen) tells the matcher where
 * those references live; this spec pins that they are enforced.
 *
 * The rule is deliberately MONOTONIC — it only ever ADDS a check on top of an
 * already-passing cap-level grant, never grants anything new:
 *   • a caller with UNRESTRICTED device reach at the required access (admin,
 *     `category:device[A]`, or a device grant with an `all` selector) is
 *     unaffected;
 *   • any other caller must additionally cover EVERY device the input names.
 *
 * Neutralisation: drop the `deviceRefsSatisfied` call in `checkScopeAccess`
 * and the first two tests below flip to `true` — the exact live leak.
 */

import type { TokenScope } from '@camstack/types'
import { DeviceType } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { checkScopeAccess, type DeviceScopeLookup } from '../scope-access.js'

// Camera 5 (granted) and camera 9 (NOT granted).
const lookup: DeviceScopeLookup = {
  getAncestors: () => [],
  getType: () => DeviceType.Camera,
  getLocation: () => null,
}

/**
 * A system-scope cap method that takes a deviceId.
 *
 * It was `recording.getPlaybackManifest` until D625 split `recording` into a
 * device-scoped COLLECTION and the `recording-archive` singleton. The move is
 * not neutral for this gate — the five coverage reads left the F1 #3 branch
 * for the `requireDeviceScoped` one — so BOTH branches are pinned here, and
 * the method named on this constant has to be one that is still system-scope.
 * `recordingArchive.getDeviceConfig` is: it is the D62 recording authority and
 * stayed a singleton for that reason.
 */
const SYSTEM_DEVICE_METHOD = 'recordingArchive.getDeviceConfig'

/**
 * The same camera reference, on the method that MOVED — `recording` is now
 * `scope: 'device'`, so this one is gated by the device-scope branch instead.
 * A read that silently changed which gate protects it is how a protected read
 * loses its scope check, so it is asserted rather than assumed.
 */
const DEVICE_SCOPED_METHOD = 'recording.getAvailability'

const systemView: TokenScope = { type: 'category', target: 'system', access: ['view'] }
const deviceFive: TokenScope = {
  type: 'device',
  selector: { kind: 'ids', ids: [5] },
  access: ['view'],
}

describe('checkScopeAccess — device refs on SYSTEM-scope caps', () => {
  it('category:system alone does NOT reach a camera it was never granted', () => {
    const result = checkScopeAccess(
      [systemView],
      SYSTEM_DEVICE_METHOD,
      { deviceId: 9, fromMs: 0, toMs: 1 },
      lookup,
    )
    expect(result.ok).toBe(false)
  })

  it('category:system + device:[5] reaches 5 but still not 9', () => {
    const scopes = [systemView, deviceFive]
    const allowed = checkScopeAccess(
      scopes,
      SYSTEM_DEVICE_METHOD,
      { deviceId: 5, fromMs: 0, toMs: 1 },
      lookup,
    )
    const denied = checkScopeAccess(
      scopes,
      SYSTEM_DEVICE_METHOD,
      { deviceId: 9, fromMs: 0, toMs: 1 },
      lookup,
    )
    expect(allowed.ok).toBe(true)
    expect(denied.ok).toBe(false)
  })

  it('an UNRESTRICTED device grant (category:device) is unaffected', () => {
    const scopes: TokenScope[] = [
      systemView,
      { type: 'category', target: 'device', access: ['view'] },
    ]
    const result = checkScopeAccess(
      scopes,
      SYSTEM_DEVICE_METHOD,
      { deviceId: 9, fromMs: 0, toMs: 1 },
      lookup,
    )
    expect(result.ok).toBe(true)
  })

  it('a device grant with an `all` selector is unrestricted reach', () => {
    const scopes: TokenScope[] = [
      systemView,
      { type: 'device', selector: { kind: 'all' }, access: ['view'] },
    ]
    const result = checkScopeAccess(
      scopes,
      SYSTEM_DEVICE_METHOD,
      { deviceId: 9, fromMs: 0, toMs: 1 },
      lookup,
    )
    expect(result.ok).toBe(true)
  })

  it("the MOVED method is still refused for a camera outside the caller's scope", () => {
    // D625 step 4 #5: prove the gate both ways. `recording.getAvailability`
    // used to be a system-scope method carrying a deviceId (the F1 #3 branch);
    // it is now device-scoped, and the device branch has to refuse the same
    // camera the old branch refused.
    const scopes = [systemView, deviceFive]
    const allowed = checkScopeAccess(
      scopes,
      DEVICE_SCOPED_METHOD,
      { deviceId: 5, provider: 'recorder', fromMs: 0, toMs: 1 },
      lookup,
    )
    const denied = checkScopeAccess(
      scopes,
      DEVICE_SCOPED_METHOD,
      { deviceId: 9, provider: 'recorder', fromMs: 0, toMs: 1 },
      lookup,
    )
    expect(allowed.ok).toBe(true)
    expect(denied.ok).toBe(false)
  })

  it('category:system alone does not reach the MOVED method at all', () => {
    const result = checkScopeAccess(
      [systemView],
      DEVICE_SCOPED_METHOD,
      { deviceId: 9, provider: 'recorder', fromMs: 0, toMs: 1 },
      lookup,
    )
    expect(result.ok).toBe(false)
  })

  it('a system-scope method with NO device reference is untouched by the check', () => {
    // `addons.list` carries no deviceId — a plain category:system grant works.
    const result = checkScopeAccess([systemView], 'addons.list')
    expect(result.ok).toBe(true)
  })

  it('an absent OPTIONAL device reference does not deny the call', () => {
    // `audioAnalyzer.classify` has an optional deviceId; omitting it must not
    // fail the ref check (the response projection is what scopes those).
    const result = checkScopeAccess([systemView], 'audioAnalyzer.classify', {})
    expect(result.ok).toBe(true)
  })
})
