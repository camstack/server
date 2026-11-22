import { describe, expect, it } from 'vitest'
import {
  sendWakeOnLan,
  type WakeOnLanDeps,
  type WakeOnLanInterfaces,
  type WakeOnLanSocket,
} from '../wake-on-lan-node.js'

interface Sent {
  readonly length: number
  readonly port: number
  readonly address: string
}

interface FakeWorld {
  readonly deps: WakeOnLanDeps
  readonly sent: Sent[]
  readonly state: { closed: number; broadcast: boolean }
}

function fakeWorld(options: {
  readonly interfaces?: WakeOnLanInterfaces
  readonly failFor?: readonly string[]
  readonly failCode?: string
}): FakeWorld {
  const sent: Sent[] = []
  const state = { closed: 0, broadcast: false }
  const socket: WakeOnLanSocket = {
    setBroadcast: (flag) => {
      state.broadcast = flag
    },
    send: (message, port, address) => {
      if (options.failFor?.includes(address)) {
        return Promise.reject(
          Object.assign(new Error('send'), { code: options.failCode ?? 'EACCES' }),
        )
      }
      sent.push({ length: message.length, port, address })
      return Promise.resolve()
    },
    close: () => {
      state.closed += 1
    },
  }
  const deps: WakeOnLanDeps = {
    createSocket: () => socket,
    networkInterfaces: () => options.interfaces ?? {},
    sleep: () => Promise.resolve(),
  }
  return { deps, sent, state }
}

const MAC = 'aa:bb:cc:dd:ee:ff'
const LAN: WakeOnLanInterfaces = {
  eth0: [
    { address: '192.168.1.10', netmask: '255.255.255.0', family: 'IPv4', internal: false },
    { address: 'fe80::1', netmask: 'ffff:ffff:ffff:ffff::', family: 'IPv6', internal: false },
  ],
  lo: [{ address: '127.0.0.1', netmask: '255.0.0.0', family: 'IPv4', internal: true }],
}

describe('sendWakeOnLan', () => {
  it('refuses an invalid MAC', async () => {
    const world = fakeWorld({})
    expect(await sendWakeOnLan({ mac: 'nope' }, world.deps)).toMatchObject({
      ok: false,
      reason: 'invalid-mac',
    })
  })

  it('refuses a SecureOn that is not 6 bytes', async () => {
    const world = fakeWorld({ interfaces: LAN })
    const result = await sendWakeOnLan({ mac: MAC, secureOn: 'aabb' }, world.deps)
    expect(result).toMatchObject({ ok: false, reason: 'invalid-secure-on' })
  })

  it('refuses a caller-supplied target that is not IPv4', async () => {
    const world = fakeWorld({})
    const result = await sendWakeOnLan({ mac: MAC, broadcastAddresses: ['tv.local'] }, world.deps)
    expect(result).toMatchObject({ ok: false, reason: 'invalid-broadcast-address' })
  })

  it('refuses when no target is given and no external IPv4 interface exists', async () => {
    const world = fakeWorld({ interfaces: { lo: LAN.lo ?? [] } })
    const result = await sendWakeOnLan({ mac: MAC }, world.deps)
    expect(result).toMatchObject({ ok: false, reason: 'no-broadcast-interface' })
  })

  it('defaults to the directed broadcast of each external IPv4 interface plus 255.255.255.255', async () => {
    const world = fakeWorld({ interfaces: LAN })
    const result = await sendWakeOnLan({ mac: MAC, repeat: 1 }, world.deps)
    expect(result).toMatchObject({ ok: true, datagrams: 2 })
    expect(world.sent.map((s) => s.address).sort()).toEqual(['192.168.1.255', '255.255.255.255'])
    expect(world.sent.every((s) => s.port === 9 && s.length === 102)).toBe(true)
    expect(world.state.broadcast).toBe(true)
    expect(world.state.closed).toBe(1)
  })

  it('sends repeat x targets datagrams to the given port', async () => {
    const world = fakeWorld({})
    const result = await sendWakeOnLan(
      { mac: MAC, broadcastAddresses: ['10.0.0.255', '10.0.1.255'], repeat: 4, port: 7 },
      world.deps,
    )
    expect(result).toMatchObject({ ok: true, datagrams: 8 })
    expect(world.sent).toHaveLength(8)
    expect(world.sent.every((s) => s.port === 7)).toBe(true)
  })

  it('closes the socket when every send throws, and names the codes', async () => {
    const world = fakeWorld({ failFor: ['10.0.0.255'], failCode: 'ENETUNREACH' })
    const result = await sendWakeOnLan({ mac: MAC, broadcastAddresses: ['10.0.0.255'] }, world.deps)
    expect(result).toMatchObject({ ok: false, reason: 'send-failed' })
    expect(result.ok ? '' : (result.detail ?? '')).toContain('ENETUNREACH')
    expect(world.state.closed).toBe(1)
  })

  it('one failing target of two is ok with failedTargets', async () => {
    const world = fakeWorld({ failFor: ['10.0.1.255'] })
    const result = await sendWakeOnLan(
      { mac: MAC, broadcastAddresses: ['10.0.0.255', '10.0.1.255'], repeat: 2 },
      world.deps,
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.targets).toEqual(['10.0.0.255'])
    expect(result.failedTargets.map((f) => f.address)).toEqual(['10.0.1.255'])
    expect(result.datagrams).toBe(2)
  })
})
