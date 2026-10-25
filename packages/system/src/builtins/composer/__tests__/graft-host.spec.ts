/**
 * `GraftHost` (D663, Task 10): a method-serving native for a cap a
 * customization ADDS to a device the composer does not own, built from the
 * cap's `composedMethods`, and removed through the context's optional
 * `unregisterNativeCap` — only ever what the host itself registered.
 */
import type { CapabilityDefinition, DeviceContext } from '@camstack/types'
import { beforeEach, describe, expect, it } from 'vitest'
import { GraftHost, type GraftProvider } from '../graft-host.js'
import { LOOKUP_CAP, type RecordingLogger, recordingLogger } from './fixtures.js'

const FEEDER_ID = 50
const CAM_ID = 51
const HA = 'provider-homeassistant'
const COMPOSER = 'composer'

/** `wireRemoteNativeCapSync`'s rule (Task 10 rule 4): an unregister erases only the entry its own addon registered. */
class BindingsMirror {
  private readonly entries = new Map<string, string>()

  registered(deviceId: number, cap: string, addonId: string): void {
    this.entries.set(`${deviceId}#${cap}`, addonId)
  }

  unregistered(deviceId: number, cap: string, addonId: string): void {
    const k = `${deviceId}#${cap}`
    if (this.entries.get(k) === addonId) this.entries.delete(k)
  }

  owner(deviceId: number, cap: string): string | undefined {
    return this.entries.get(`${deviceId}#${cap}`)
  }
}

interface ContextCall {
  readonly deviceId: number
  readonly cap: string
}

/** A DeviceContext whose native registrations are recorded and fed to the bindings mirror as `composer`. */
class FakeContexts {
  readonly registered: ContextCall[] = []
  readonly unregistered: ContextCall[] = []
  readonly providers = new Map<string, GraftProvider>()
  readonly created: string[] = []
  /** When false, contexts come from an older kernel with no `unregisterNativeCap`. */
  withUnregister = true
  /** How many of the next `unregisterNativeCap` calls throw. */
  failUnregisters = 0

  constructor(private readonly bindings: BindingsMirror) {}

  create = (stableId: string, id: number): DeviceContext => {
    this.created.push(`${stableId}@${id}`)
    const registerNativeCap = (cap: CapabilityDefinition, provider: GraftProvider): void => {
      this.registered.push({ deviceId: id, cap: cap.name })
      this.providers.set(`${id}#${cap.name}`, provider)
      this.bindings.registered(id, cap.name, COMPOSER)
    }
    const unregisterNativeCap = (capName: string): void => {
      if (this.failUnregisters > 0) {
        this.failUnregisters -= 1
        throw new Error('channel closed')
      }
      this.unregistered.push({ deviceId: id, cap: capName })
      this.providers.delete(`${id}#${capName}`)
      this.bindings.unregistered(id, capName, COMPOSER)
    }
    return fakeContext(
      id,
      stableId,
      registerNativeCap,
      this.withUnregister ? unregisterNativeCap : undefined,
    )
  }

  provider(deviceId: number, cap: string): GraftProvider {
    const p = this.providers.get(`${deviceId}#${cap}`)
    if (p === undefined) throw new Error(`no graft for ${deviceId}#${cap}`)
    return p
  }
}

/**
 * The only two members `GraftHost` touches. The rest of `DeviceContext` is a
 * kernel surface this unit never reaches; a structural double narrowed at this
 * one boundary.
 */
function fakeContext(
  id: number,
  stableId: string,
  register: (cap: CapabilityDefinition, provider: GraftProvider) => void,
  unregister: ((capName: string) => void) | undefined,
): DeviceContext {
  const surface = {
    id,
    stableId,
    registerNativeCap: register,
    ...(unregister === undefined ? {} : { unregisterNativeCap: unregister }),
  }
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- test double: a documented type boundary
  return surface as unknown as DeviceContext
}

let log: RecordingLogger
let bindings: BindingsMirror
let contexts: FakeContexts
let merged: Map<string, Readonly<Record<string, unknown>>>
let host: GraftHost

beforeEach(() => {
  log = recordingLogger()
  bindings = new BindingsMirror()
  contexts = new FakeContexts(bindings)
  merged = new Map()
  host = new GraftHost(
    { createContext: contexts.create, logger: log.logger },
    LOOKUP_CAP,
    async (deviceId, cap) => merged.get(`${deviceId}#${cap}`) ?? null,
  )
})

describe('graft — the provider is the cap’s composedMethods', () => {
  it('battery.wakeForStream answers { awoke: false, durationMs: 0 }; getStatus is the MERGED slice, never {}', async () => {
    expect(host.graft(FEEDER_ID, 'ha:feeder', 'battery')).toEqual({ kind: 'grafted' })
    const battery = contexts.provider(FEEDER_ID, 'battery')
    await expect(battery['wakeForStream']?.({ deviceId: FEEDER_ID })).resolves.toEqual({
      awoke: false,
      durationMs: 0,
    })
    await expect(battery['getStatus']?.({ deviceId: FEEDER_ID })).resolves.toBeNull()
    merged.set(`${FEEDER_ID}#battery`, { percentage: 100, charging: 'none' })
    await expect(battery['getStatus']?.({ deviceId: FEEDER_ID })).resolves.toEqual({
      percentage: 100,
      charging: 'none',
    })
    expect(host.grafted(FEEDER_ID)).toEqual(new Set(['battery']))
    const line = log.lines.find((l) => l.message.startsWith('graft: an added cap'))
    expect(line?.extras?.tags).toEqual({ deviceId: FEEDER_ID })
  })

  it('consumables.reset rejects with the declared reason', async () => {
    expect(host.graft(FEEDER_ID, 'ha:feeder', 'consumables').kind).toBe('grafted')
    const reason = LOOKUP_CAP('consumables')?.composedMethods?.['reset']
    expect(reason?.kind).toBe('refuse')
    await expect(
      contexts.provider(FEEDER_ID, 'consumables')['reset']?.({ deviceId: FEEDER_ID, key: 'x' }),
    ).rejects.toThrow(reason?.kind === 'refuse' ? reason.reason : 'unreachable')
  })

  it('a second graft of the same (device, cap) is `already`; ONE context per device', () => {
    host.graft(FEEDER_ID, 'ha:feeder', 'battery')
    expect(host.graft(FEEDER_ID, 'ha:feeder', 'battery')).toEqual({ kind: 'already' })
    host.graft(FEEDER_ID, 'ha:feeder', 'consumables')
    expect(contexts.created).toEqual([`ha:feeder@${FEEDER_ID}`])
    expect(contexts.registered).toHaveLength(2)
  })

  it('a cap with a served method and no composed answer is refused by name, nothing registered (slice 1 rule)', () => {
    const outcome = host.graft(FEEDER_ID, 'ha:feeder', 'ptz')
    expect(outcome.kind).toBe('refused')
    expect(outcome.kind === 'refused' ? outcome.reason : '').toContain('no composed answer')
    expect(contexts.registered).toEqual([])
    const line = log.lines.find((l) => l.message.startsWith('graft refused'))
    expect(line?.extras?.tags).toEqual({ deviceId: FEEDER_ID })
  })
})

describe('ungraft — only what this host registered (Kernel ruling)', () => {
  it("the composer's ungraft leaves HA's natives untouched — on another device and on the same one", () => {
    host.graft(FEEDER_ID, 'ha:feeder', 'battery')
    bindings.registered(CAM_ID, 'battery', HA)
    host.ungraft(FEEDER_ID, 'battery', 'x')
    expect(contexts.unregistered).toEqual([{ deviceId: FEEDER_ID, cap: 'battery' }])
    expect(host.grafted(FEEDER_ID).size).toBe(0)
    expect(bindings.owner(CAM_ID, 'battery')).toBe(HA)
    // A native appears on the grafted device itself: HA registers, the composer ungrafts.
    host.graft(FEEDER_ID, 'ha:feeder', 'battery')
    bindings.registered(FEEDER_ID, 'battery', HA)
    host.ungraft(FEEDER_ID, 'battery', 'a native provider appeared')
    expect(bindings.owner(FEEDER_ID, 'battery')).toBe(HA)
    const removed = log.lines.filter((l) => l.message === 'graft removed')
    expect(removed.map((l) => l.extras?.tags)).toEqual([
      { deviceId: FEEDER_ID },
      { deviceId: FEEDER_ID },
    ])
  })

  it('a cap this host never grafted is a no-op: no unregister call', () => {
    host.ungraft(FEEDER_ID, 'battery', 'x')
    host.graft(FEEDER_ID, 'ha:feeder', 'battery')
    host.ungraft(FEEDER_ID, 'consumables', 'x')
    expect(contexts.unregistered).toEqual([])
  })

  it('an older kernel with no unregisterNativeCap: warned ONCE per device, the graft forgotten', () => {
    contexts.withUnregister = false
    host.graft(FEEDER_ID, 'ha:feeder', 'battery')
    host.graft(FEEDER_ID, 'ha:feeder', 'consumables')
    host.ungraft(FEEDER_ID, 'battery', 'x')
    host.ungraft(FEEDER_ID, 'consumables', 'x')
    const warns = log.lines.filter((l) =>
      l.message.includes('stays routable until the composer respawns'),
    )
    expect(warns).toHaveLength(1)
    expect(warns[0]?.extras?.tags).toEqual({ deviceId: FEEDER_ID })
    expect(host.grafted(FEEDER_ID).size).toBe(0)
  })

  it('M-2: an unregister that THROWS keeps the graft known, so the next ungraft retries it', () => {
    host.graft(FEEDER_ID, 'ha:feeder', 'battery')
    contexts.failUnregisters = 1
    host.ungraft(FEEDER_ID, 'battery', 'x')
    expect(host.grafted(FEEDER_ID)).toEqual(new Set(['battery']))
    host.ungraft(FEEDER_ID, 'battery', 'x')
    expect(contexts.unregistered).toEqual([{ deviceId: FEEDER_ID, cap: 'battery' }])
    expect(host.grafted(FEEDER_ID).size).toBe(0)
  })
})

describe('retractStale — a binding a previous composer process left (I-3)', () => {
  it('this process never grafted it: the kernel is asked to unregister it all the same', () => {
    host.retractStale(FEEDER_ID, 'battery', 'stale')
    expect(contexts.unregistered).toEqual([{ deviceId: FEEDER_ID, cap: 'battery' }])
    const line = log.lines.find((l) => l.message.includes('previous composer process retracted'))
    expect(line?.extras?.tags).toEqual({ deviceId: FEEDER_ID })
  })

  it('this process grafted it: an ordinary ungraft', () => {
    host.graft(FEEDER_ID, 'ha:feeder', 'battery')
    host.retractStale(FEEDER_ID, 'battery', 'stale')
    expect(contexts.unregistered).toEqual([{ deviceId: FEEDER_ID, cap: 'battery' }])
    expect(host.grafted(FEEDER_ID).size).toBe(0)
  })
})
