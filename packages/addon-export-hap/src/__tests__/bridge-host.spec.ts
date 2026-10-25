/**
 * The bridge's LIFECYCLE — lazy, published once, and honest when it is full.
 */
import { describe, expect, it, vi } from 'vitest'
import { Accessory, Categories, uuid as HapUuid } from '@homebridge/hap-nodejs'
import type { IScopedLogger } from '@camstack/types'
import { BridgeHost } from '../bridge-host.js'
import { MAX_BRIDGED_ACCESSORIES } from '../bridge-policy.js'

function makeHost(publish = vi.fn(async () => {})) {
  const noop = (): void => {}
  // The spies are held separately so the double can be TYPED as the port it
  // stands in for: a `log as any` satisfies biome's ignore comment and still
  // fails oxlint, which is the lint the CI baseline actually runs.
  const info = vi.fn()
  const warn = vi.fn()
  const log: IScopedLogger = {
    info,
    warn,
    error: noop,
    debug: noop,
    child: () => log,
    withTags: () => log,
  }
  const host = new BridgeHost({
    displayName: 'CamStack Bridge',
    uuid: HapUuid.generate('camstack:test:bridge'),
    pincode: '123-45-678',
    logger: log,
    publish,
  })
  return { host, publish, log, info, warn }
}

function accessory(name: string): Accessory {
  return new Accessory(name, HapUuid.generate(`camstack:test:${name}`))
}

describe('BridgeHost', () => {
  it('publishes NOTHING until an accessory needs it', () => {
    const { host, publish } = makeHost()
    expect(host.accessory).toBeNull()
    expect(publish).not.toHaveBeenCalled()
  })

  it('publishes ONCE, however many accessories arrive', async () => {
    const { host, publish } = makeHost()
    expect(await host.add(accessory('a'))).toBe(true)
    expect(await host.add(accessory('b'))).toBe(true)
    expect(publish).toHaveBeenCalledTimes(1)
    expect(host.size).toBe(2)
    expect(host.accessory?.category).toBe(Categories.BRIDGE)
  })

  it('knows what it holds, and lets go', async () => {
    const { host } = makeHost()
    const a = accessory('a')
    await host.add(a)
    expect(host.holds(a)).toBe(true)
    host.remove(a)
    expect(host.holds(a)).toBe(false)
    expect(host.size).toBe(0)
  })

  it('removing something it never held changes nothing', async () => {
    const { host } = makeHost()
    await host.add(accessory('a'))
    host.remove(accessory('stranger'))
    expect(host.size).toBe(1)
  })

  it('REFUSES past the ceiling instead of letting hap-nodejs throw', async () => {
    // hap-nodejs throws at 149. A throw here would be a device that silently
    // fails to expose; the caller falls back to standalone instead.
    const { host, warn } = makeHost()
    for (let i = 0; i < MAX_BRIDGED_ACCESSORIES; i += 1) {
      expect(await host.add(accessory(`a${i}`))).toBe(true)
    }
    expect(host.size).toBe(MAX_BRIDGED_ACCESSORIES)
    expect(await host.add(accessory('one-too-many'))).toBe(false)
    expect(host.size).toBe(MAX_BRIDGED_ACCESSORIES)
    expect(warn).toHaveBeenCalled()
  })
})
