import { describe, expect, it } from 'vitest'
import { AutodetectCache } from './autodetect-cache.js'
import { buildAutodetectInputs } from './autodetect-inputs.js'

const BASE = { host: '192.168.50.27', username: 'admin', password: 'secret', uid: 'UID1' }

describe('add-camera form → autodetect inputs', () => {
  it('carries a chosen discovery method through, so "local only" can be asked for', () => {
    const inputs = buildAutodetectInputs({
      ...BASE,
      transport: 'udp',
      udpDiscoveryMethod: 'local-direct',
    })
    expect(inputs.udpDiscoveryMethod).toBe('local-direct')
  })

  it('leaves the method unset for "auto" or an unknown value (the race stays the default)', () => {
    expect(
      buildAutodetectInputs({ ...BASE, udpDiscoveryMethod: 'auto' }).udpDiscoveryMethod,
    ).toBeUndefined()
    expect(
      buildAutodetectInputs({ ...BASE, udpDiscoveryMethod: 'bogus' }).udpDiscoveryMethod,
    ).toBeUndefined()
    expect(buildAutodetectInputs({ ...BASE }).udpDiscoveryMethod).toBeUndefined()
  })

  it('does not share a cached probe between a local-only and an auto probe of the same camera', () => {
    const auto = buildAutodetectInputs({ ...BASE, transport: 'udp' })
    const local = buildAutodetectInputs({
      ...BASE,
      transport: 'udp',
      udpDiscoveryMethod: 'local-direct',
    })
    expect(AutodetectCache.keyFor(local)).not.toBe(AutodetectCache.keyFor(auto))
  })
})
