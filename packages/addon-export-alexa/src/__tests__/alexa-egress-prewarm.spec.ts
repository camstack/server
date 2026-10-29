/**
 * A doorbell press warms the Alexa egress so the Echo's offer, which arrives
 * 1.5 to 6 s later, finds a running ffmpeg child instead of waiting ~3 s for a
 * cold one.
 *
 * Two layers, both driven through their public entry points:
 *  - the gateway calls the pre-warm hook on a press for an exposed camera;
 *  - the pre-warm holds the egress, releases it on a deadline, and never leaks.
 */
import { EventCategory, type AddonApi, type IScopedLogger } from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { acquireAlexaEgress } from '../egress/alexa-rtc-egress.js'
import { AlexaEgressPrewarm } from '../egress/alexa-egress-prewarm.js'
import { LwaEventGateway, type LwaEventGatewayDeps } from '../lwa-event-gateway.js'
import type { ExposedDeviceEntry } from '../types.js'

const DEVICE_ID = 615

interface LogLine {
  readonly level: string
  readonly message: string
  readonly tags: unknown
}

function makeLogger(lines: LogLine[]): IScopedLogger {
  const at =
    (level: string) =>
    (message: string, ctx?: { tags?: unknown }): void => {
      lines.push({ level, message, tags: ctx?.tags })
    }
  const logger = {
    info: at('info'),
    warn: at('warn'),
    debug: at('debug'),
    error: at('error'),
    withTags: () => logger,
  }
  return logger as unknown as IScopedLogger
}

interface Broker {
  readonly api: AddonApi
  readonly acquires: unknown[]
  readonly releases: string[]
}

function makeBroker(opts?: { failAcquire?: boolean }): Broker {
  const acquires: unknown[] = []
  const releases: string[] = []
  let n = 0
  const api = {
    streamBroker: {
      acquireEgressTranscode: {
        mutate: async (input: unknown) => {
          acquires.push(input)
          if (opts?.failAcquire) throw new Error('broker down')
          n += 1
          return {
            camStreamId: `cs-${n}`,
            pipelineKey: 'pk-1',
            encoder: 'libx264',
            decodeHwAccel: null,
          }
        },
      },
      releaseEgressTranscode: {
        mutate: async (input: { pipelineKey: string }) => {
          releases.push(input.pipelineKey)
        },
      },
    },
    cameraStreams: { pickStream: { query: async () => null } },
  }
  return { api: api as unknown as AddonApi, acquires, releases }
}

// `streamPreference: 'mid'` pins the slot, so no scoring query is involved.
const EXPOSED = [
  { deviceId: DEVICE_ID, settings: { streamPreference: 'mid' } },
] as unknown as readonly ExposedDeviceEntry[]

beforeEach(() => {
  vi.useFakeTimers().setSystemTime(1_700_000_000_000)
})
afterEach(() => {
  vi.useRealTimers()
})

describe('AlexaEgressPrewarm', () => {
  function make(opts?: { live?: boolean; failAcquire?: boolean }) {
    const lines: LogLine[] = []
    const broker = makeBroker({ failAcquire: opts?.failAcquire })
    const prewarm = new AlexaEgressPrewarm({
      api: broker.api,
      logger: makeLogger(lines),
      listExposed: () => EXPOSED,
      hasLiveSession: () => opts?.live === true,
      holdMs: 30_000,
    })
    return { prewarm, broker, lines }
  }

  it('acquires the egress on a press and releases it after the deadline when no session arrives', async () => {
    const { prewarm, broker, lines } = make()
    await prewarm.onPress(DEVICE_ID)
    expect(broker.acquires).toHaveLength(1)
    expect(broker.acquires[0]).toMatchObject({
      deviceId: DEVICE_ID,
      source: { kind: 'profile', profile: 'mid' },
    })
    expect(broker.releases).toEqual([])

    await vi.advanceTimersByTimeAsync(29_999)
    expect(broker.releases).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(broker.releases).toEqual(['pk-1'])

    // Every line about the camera carries the numeric deviceId tag.
    const about = lines.filter((l) => l.message.startsWith('alexa egress prewarm'))
    expect(about.length).toBeGreaterThan(0)
    for (const l of about) expect(l.tags).toEqual({ deviceId: DEVICE_ID })
  })

  it('shares the transcode with the session: same request, so the broker finds the running child', async () => {
    const { prewarm, broker } = make()
    await prewarm.onPress(DEVICE_ID)
    // The session's own acquire for the same camera and slot.
    await acquireAlexaEgress({
      api: broker.api,
      deviceId: DEVICE_ID,
      sourceProfile: 'mid',
      sessionId: 'echo-session',
    })
    const [warm, session] = broker.acquires as { tag: string }[]
    // `tag` is attribution and NEVER part of the sharing key.
    expect({ ...warm, tag: '' }).toEqual({ ...session, tag: '' })
    expect(warm?.tag.startsWith('alexa/prewarm-')).toBe(true)
  })

  it('is a no-op while a session is already live for the camera', async () => {
    const { prewarm, broker } = make({ live: true })
    await prewarm.onPress(DEVICE_ID)
    expect(broker.acquires).toHaveLength(0)
  })

  it('a second press while the hold is pending does not acquire again', async () => {
    const { prewarm, broker } = make()
    await prewarm.onPress(DEVICE_ID)
    await prewarm.onPress(DEVICE_ID)
    expect(broker.acquires).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(broker.releases).toEqual(['pk-1'])
  })

  it('two presses in the same tick acquire once', async () => {
    const { prewarm, broker } = make()
    await Promise.all([prewarm.onPress(DEVICE_ID), prewarm.onPress(DEVICE_ID)])
    expect(broker.acquires).toHaveLength(1)
  })

  it('a failed acquire leaves nothing held and logs a warning with the deviceId', async () => {
    const { prewarm, broker, lines } = make({ failAcquire: true })
    await prewarm.onPress(DEVICE_ID)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(broker.releases).toEqual([])
    const warn = lines.find((l) => l.level === 'warn' && l.message.includes('acquire failed'))
    expect(warn?.tags).toEqual({ deviceId: DEVICE_ID })
    // The pending slot was freed: the next press tries again.
    await prewarm.onPress(DEVICE_ID)
    expect(broker.acquires).toHaveLength(2)
  })

  it('dispose releases a pending hold at once and cancels its timer', async () => {
    const { prewarm, broker } = make()
    await prewarm.onPress(DEVICE_ID)
    await prewarm.dispose()
    expect(broker.releases).toEqual(['pk-1'])
    await vi.advanceTimersByTimeAsync(60_000)
    expect(broker.releases).toEqual(['pk-1'])
  })
})

describe('LwaEventGateway doorbell press', () => {
  function gatewayWith(onExposedDoorbellPress: (deviceId: number) => void): {
    readonly press: () => Promise<void>
  } {
    type Handler = (event: { data: unknown }) => void
    let doorbell: Handler | null = null
    const lines: LogLine[] = []
    const deps: LwaEventGatewayDeps = {
      ctx: {
        eventBus: {
          subscribe: (filter: { category: string }, handler: Handler) => {
            if (filter.category === EventCategory.DoorbellOnPressed) doorbell = handler
            return () => {}
          },
        },
        api: {
          deviceManager: {
            getDevice: { query: async () => ({ parentDeviceId: DEVICE_ID }) },
          },
        },
      } as unknown as LwaEventGatewayDeps['ctx'],
      logger: makeLogger(lines),
      listExposed: () => EXPOSED,
      onExposedDoorbellPress,
      listLinkedAccounts: () => [{ userId: 'userA', username: 'userA', linkedAt: 0 }],
      listTokens: () => [
        {
          userId: 'userA',
          accessToken: 'tok',
          refreshToken: 'ref',
          expiresAt: Date.now() + 1e9,
          receivedAt: 0,
        },
      ],
      upsertToken: async () => {},
      removeLinkedAccount: async () => {},
      getAdvertisedBrokerUrl: () => null,
      getRegion: () => 'NA',
      getExportedSignature: () => null,
      accountMaySee: () => true,
    }
    const gateway = new LwaEventGateway(deps)
    gateway.start()
    return {
      press: async () => {
        doorbell?.({ data: { deviceId: 1031, timestamp: Date.now() } })
        await vi.advanceTimersByTimeAsync(0)
      },
    }
  }

  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          ({
            ok: true,
            status: 202,
            text: async () => '',
          }) as unknown as Response,
      ),
    )
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('asks for the egress to be warmed, with the PARENT camera id', async () => {
    const warmed: number[] = []
    const g = gatewayWith((id) => warmed.push(id))
    await g.press()
    expect(warmed).toEqual([DEVICE_ID])
  })
})
