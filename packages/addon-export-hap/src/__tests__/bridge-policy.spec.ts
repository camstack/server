import { describe, expect, it } from 'vitest'
import { bridgeHasRoom, MAX_BRIDGED_ACCESSORIES, shouldBridge } from '../bridge-policy.js'

describe('shouldBridge', () => {
  it('a NON-camera rides the bridge by default — the field need not exist', () => {
    expect(shouldBridge({ mapperKind: 'generic' })).toBe(true)
    expect(shouldBridge({ mapperKind: 'generic', useBridge: undefined })).toBe(true)
  })

  it('the operator can take one off the bridge', () => {
    expect(shouldBridge({ mapperKind: 'generic', useBridge: false })).toBe(false)
  })

  it('a CAMERA is never bridged, whatever is stored against it', () => {
    // HomeKit's rule, not ours. An entry that somehow carries `true` must not
    // produce a camera nobody can pair.
    expect(shouldBridge({ mapperKind: 'camera', useBridge: true })).toBe(false)
    expect(shouldBridge({ mapperKind: 'camera' })).toBe(false)
  })
})

describe('bridgeHasRoom', () => {
  it('stops one SHORT of the number hap-nodejs throws at', () => {
    expect(MAX_BRIDGED_ACCESSORIES).toBe(149)
    expect(bridgeHasRoom(148)).toBe(true)
    expect(bridgeHasRoom(149)).toBe(false)
    expect(bridgeHasRoom(200)).toBe(false)
  })
})
