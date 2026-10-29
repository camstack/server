/**
 * The device-call redirect (D963): a covered device-scoped call resolved
 * through the registry may be taken over before the provider sees it — and
 * every other method, and every other device, stays exactly the provider's own.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  batteryCapability,
  type DeviceCall,
  type DeviceCallAnswer,
  type DeviceCallRedirect,
  type IScopedLogger,
} from '@camstack/types'
import { CapabilityRegistry } from '../capability-registry.js'

const DEVICE = 7
const OTHER = 8

function makeLogger(): IScopedLogger {
  const l = {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(),
    withTags: vi.fn(),
  }
  l.child.mockReturnValue(l)
  l.withTags.mockReturnValue(l)
  // Fake → interface: the mock's recursive `child` cannot be stated. Documented test boundary.
  return l as unknown as IScopedLogger
}

interface Native {
  getStatus: (input?: unknown) => Promise<{ level: number }>
  wakeForStream: (input?: unknown) => Promise<{ awoke: boolean }>
}

function native(): Native & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    getStatus: async () => {
      calls.push('getStatus')
      return { level: 1 }
    },
    wakeForStream: async () => {
      calls.push('wakeForStream')
      return { awoke: true }
    },
  }
}

function redirect(answer: (call: DeviceCall) => DeviceCallAnswer): DeviceCallRedirect & {
  seen: DeviceCall[]
} {
  const seen: DeviceCall[] = []
  return {
    seen,
    covers: (cap, method) => cap === 'battery' && method === 'wakeForStream',
    attempt: async (call) => {
      seen.push(call)
      return answer(call)
    },
  }
}

function newRegistry(): CapabilityRegistry {
  const reg = new CapabilityRegistry(makeLogger())
  reg.declareCapability(batteryCapability)
  reg.ready()
  return reg
}

describe('CapabilityRegistry — the device-call redirect (D963)', () => {
  it('answers a redirected call from the redirect; the provider is not called', async () => {
    const reg = newRegistry()
    const n = native()
    reg.registerNativeProvider('battery', DEVICE, 'x', n)
    const r = redirect(() => ({ kind: 'redirected', result: { awoke: false } }))
    reg.setDeviceCallRedirect(r)

    const p = reg.getProviderForDevice<Native>('battery', DEVICE)
    expect(await p?.wakeForStream({ deviceId: DEVICE })).toEqual({ awoke: false })
    expect(n.calls).toEqual([])
    expect(r.seen).toEqual([
      { capName: 'battery', method: 'wakeForStream', deviceId: DEVICE, args: { deviceId: DEVICE } },
    ])
  })

  it('falls through to the provider when nothing takes the call over', async () => {
    const reg = newRegistry()
    const n = native()
    reg.registerNativeProvider('battery', DEVICE, 'x', n)
    reg.setDeviceCallRedirect(redirect(() => ({ kind: 'not-redirected' })))
    expect(await reg.getProviderForDevice<Native>('battery', DEVICE)?.wakeForStream()).toEqual({
      awoke: true,
    })
    expect(n.calls).toEqual(['wakeForStream'])
  })

  it('never asks about a method it does not cover', async () => {
    const reg = newRegistry()
    reg.registerNativeProvider('battery', DEVICE, 'x', native())
    const r = redirect(() => ({ kind: 'redirected', result: null }))
    reg.setDeviceCallRedirect(r)
    expect(await reg.getProviderForDevice<Native>('battery', DEVICE)?.getStatus()).toEqual({
      level: 1,
    })
    expect(r.seen).toEqual([])
  })

  it('removing the redirect hands the provider back untouched', async () => {
    const reg = newRegistry()
    const n = native()
    reg.registerNativeProvider('battery', DEVICE, 'x', n)
    reg.setDeviceCallRedirect(redirect(() => ({ kind: 'redirected', result: null })))
    reg.setDeviceCallRedirect(null)
    expect(reg.getProviderForDevice('battery', DEVICE)).toBe(n)
    expect(
      await reg.redirectDeviceCall({
        capName: 'battery',
        method: 'wakeForStream',
        deviceId: OTHER,
        args: {},
      }),
    ).toEqual({
      kind: 'not-redirected',
    })
  })

  it('redirectDeviceCall is the question the transport entries ask', async () => {
    const reg = newRegistry()
    const r = redirect(() => ({ kind: 'redirected', result: 'done' }))
    reg.setDeviceCallRedirect(r)
    const call = { capName: 'battery', method: 'wakeForStream', deviceId: OTHER, args: {} }
    expect(await reg.redirectDeviceCall(call)).toEqual({ kind: 'redirected', result: 'done' })
    expect(await reg.redirectDeviceCall({ ...call, method: 'getStatus' })).toEqual({
      kind: 'not-redirected',
    })
  })
})
