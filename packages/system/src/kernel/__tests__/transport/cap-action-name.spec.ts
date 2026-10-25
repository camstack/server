import { describe, it, expect } from 'vitest'
import {
  NATIVE_PROVIDER_SERVICE_INFIX,
  capServiceName,
  capActionName,
  capActionSuffix,
  capBareAction,
  parseCapAction,
} from '../../transport/cap-action-name.js'

// ---------------------------------------------------------------------------
// NATIVE_PROVIDER_SERVICE_INFIX
// ---------------------------------------------------------------------------

describe('NATIVE_PROVIDER_SERVICE_INFIX', () => {
  it('equals the literal .native-provider', () => {
    expect(NATIVE_PROVIDER_SERVICE_INFIX).toBe('.native-provider')
  })
})

// ---------------------------------------------------------------------------
// capServiceName
// ---------------------------------------------------------------------------

describe('capServiceName', () => {
  it('system cap: addonId.capName', () => {
    expect(capServiceName('stream-broker', 'camera-streams', false)).toBe(
      'stream-broker.camera-streams',
    )
  })

  it('native cap: addonId.native-provider.capName', () => {
    expect(capServiceName('addon-provider-reolink', 'ptz', true)).toBe(
      'addon-provider-reolink.native-provider.ptz',
    )
  })

  it('system cap with compound capName', () => {
    expect(capServiceName('detection-pipeline', 'pipeline-executor', false)).toBe(
      'detection-pipeline.pipeline-executor',
    )
  })
})

// ---------------------------------------------------------------------------
// capActionName
// ---------------------------------------------------------------------------

describe('capActionName', () => {
  it('system cap action: addonId.capName.method', () => {
    expect(capActionName('stream-broker', 'camera-streams', 'getRtspEntries', false)).toBe(
      'stream-broker.camera-streams.getRtspEntries',
    )
  })

  it('native cap action: addonId.native-provider.capName.method', () => {
    expect(capActionName('addon-provider-reolink', 'ptz', 'move', true)).toBe(
      'addon-provider-reolink.native-provider.ptz.move',
    )
  })

  it('native cap action with addonId from spec test', () => {
    // Matches the existing native-cap-route.spec.ts assertion:
    // action === `addon-provider-reolink${NATIVE_PROVIDER_SERVICE_INFIX}.ptz.move`
    const expected = `addon-provider-reolink${NATIVE_PROVIDER_SERVICE_INFIX}.ptz.move`
    expect(capActionName('addon-provider-reolink', 'ptz', 'move', true)).toBe(expected)
  })

  it('system cap action equals the legacy template literal', () => {
    const addonId = 'some-addon'
    const capName = 'some-cap'
    const method = 'someMethod'
    const legacy = `${addonId}.${capName}.${method}`
    expect(capActionName(addonId, capName, method, false)).toBe(legacy)
  })

  it('native cap action equals the legacy template literal', () => {
    const addonId = 'some-addon'
    const capName = 'some-cap'
    const method = 'someMethod'
    const legacy = `${addonId}${NATIVE_PROVIDER_SERVICE_INFIX}.${capName}.${method}`
    expect(capActionName(addonId, capName, method, true)).toBe(legacy)
  })
})

// ---------------------------------------------------------------------------
// capActionSuffix
// ---------------------------------------------------------------------------

describe('capActionSuffix', () => {
  it('returns .capName.method', () => {
    expect(capActionSuffix('ptz', 'move')).toBe('.ptz.move')
  })

  it('matches the legacy inline literal', () => {
    const capName = 'camera-streams'
    const method = 'getRtspEntries'
    const legacy = `.${capName}.${method}`
    expect(capActionSuffix(capName, method)).toBe(legacy)
  })
})

// ---------------------------------------------------------------------------
// capBareAction
// ---------------------------------------------------------------------------

describe('capBareAction', () => {
  it('returns capName.method', () => {
    expect(capBareAction('ptz', 'move')).toBe('ptz.move')
  })

  it('matches the legacy inline literal', () => {
    const capName = 'camera-streams'
    const method = 'getRtspEntries'
    const legacy = `${capName}.${method}`
    expect(capBareAction(capName, method)).toBe(legacy)
  })
})

// ---------------------------------------------------------------------------
// parseCapAction — round-trip
// ---------------------------------------------------------------------------

describe('parseCapAction', () => {
  it('round-trips a system cap action', () => {
    const addonId = 'stream-broker'
    const capName = 'camera-streams'
    const method = 'getRtspEntries'
    const action = capActionName(addonId, capName, method, false)
    const parsed = parseCapAction(action)
    expect(parsed).not.toBeNull()
    expect(parsed!.addonId).toBe(addonId)
    expect(parsed!.capName).toBe(capName)
    expect(parsed!.method).toBe(method)
    expect(parsed!.native).toBe(false)
  })

  it('round-trips a native cap action', () => {
    const addonId = 'addon-provider-reolink'
    const capName = 'ptz'
    const method = 'move'
    const action = capActionName(addonId, capName, method, true)
    const parsed = parseCapAction(action)
    expect(parsed).not.toBeNull()
    expect(parsed!.addonId).toBe(addonId)
    expect(parsed!.capName).toBe(capName)
    expect(parsed!.method).toBe(method)
    expect(parsed!.native).toBe(true)
  })

  it('round-trips a system cap with compound addon / cap names', () => {
    const addonId = 'addon-detection-pipeline'
    const capName = 'pipeline-executor'
    const method = 'getAvailableEngines'
    const action = capActionName(addonId, capName, method, false)
    const parsed = parseCapAction(action)
    expect(parsed).not.toBeNull()
    expect(parsed!.addonId).toBe(addonId)
    expect(parsed!.capName).toBe(capName)
    expect(parsed!.method).toBe(method)
    expect(parsed!.native).toBe(false)
  })

  it('round-trips a native cap with compound addonId', () => {
    const addonId = 'addon-provider-hikvision'
    const capName = 'motion-zones'
    const method = 'getOptions'
    const action = capActionName(addonId, capName, method, true)
    const parsed = parseCapAction(action)
    expect(parsed).not.toBeNull()
    expect(parsed!.addonId).toBe(addonId)
    expect(parsed!.capName).toBe(capName)
    expect(parsed!.method).toBe(method)
    expect(parsed!.native).toBe(true)
  })

  it('returns null for strings with fewer than 3 dot-separated segments', () => {
    expect(parseCapAction('foo')).toBeNull()
    expect(parseCapAction('foo.bar')).toBeNull()
    expect(parseCapAction('')).toBeNull()
  })

  it('returns null for empty segments', () => {
    // Leading/trailing dot produces empty addonId or method segment
    expect(parseCapAction('.ptz.move')).toBeNull()
    expect(parseCapAction('addon.ptz.')).toBeNull()
  })

  it('distinguishes native from system based on .native-provider segment', () => {
    const systemAction = 'my-addon.some-cap.doIt'
    const nativeAction = 'my-addon.native-provider.some-cap.doIt'
    expect(parseCapAction(systemAction)!.native).toBe(false)
    expect(parseCapAction(nativeAction)!.native).toBe(true)
  })

  it('system action parse: addonId is first segment, method is last, capName is middle', () => {
    const parsed = parseCapAction('a.b.c')
    expect(parsed).not.toBeNull()
    expect(parsed!.addonId).toBe('a')
    expect(parsed!.capName).toBe('b')
    expect(parsed!.method).toBe('c')
    expect(parsed!.native).toBe(false)
  })
})
