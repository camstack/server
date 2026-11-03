import { DeviceType } from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { alexaEchoSessions, type EchoSession } from '../alexa-echo-sessions.js'
import { AlexaEchoDevice } from '../devices/alexa-echo-device.js'
import { RateLimitedError, type PlayerInfo } from '../speak/worker-protocol.js'
import { makeCtx, type LogLine } from './fake-ctx.js'

interface FakeSession extends EchoSession {
  playerState: ReturnType<typeof vi.fn>
  npCommand: ReturnType<typeof vi.fn>
  setVolume: ReturnType<typeof vi.fn>
  dndState: ReturnType<typeof vi.fn>
  deviceVolumes: ReturnType<typeof vi.fn>
  setDnd: ReturnType<typeof vi.fn>
  state: 'ready'
  rateLimitedUntil: number | null
  devices: EchoSession['devices']
}

function session(over: Partial<FakeSession> = {}): FakeSession {
  return {
    state: 'ready',
    rateLimitedUntil: null,
    devices: [
      {
        id: 'S1',
        name: 'K',
        family: 'ECHO',
        online: true,
        kind: 'device',
        dnd: false,
        deviceType: 'T1',
      },
      {
        id: 'S2',
        name: 'L',
        family: 'ECHO',
        online: true,
        kind: 'device',
        dnd: false,
        deviceType: 'T1',
      },
    ],
    playerState: vi.fn(
      async (): Promise<PlayerInfo> => ({
        state: 'PLAYING',
        volume: { volume: 40 },
      }),
    ),
    npCommand: vi.fn(async () => undefined),
    setVolume: vi.fn(async () => undefined),
    dndState: vi.fn(
      async () =>
        new Map([
          ['S1', true],
          ['S2', false],
        ]),
    ),
    deviceVolumes: vi.fn(
      async () =>
        new Map([
          ['S1', { volume: 46, muted: false }],
          ['S2', { volume: 20, muted: true }],
        ]),
    ),
    setDnd: vi.fn(async () => undefined),
    ...over,
  }
}

interface Built {
  device: AlexaEchoDevice
  providers: Map<string, unknown>
  logs: LogLine[]
}

async function build(serial = 'S1'): Promise<Built> {
  const logs: LogLine[] = []
  const { ctx, providers } = makeCtx(
    { brokerId: 'b', serial, deviceType: 'T1', system: 'alexa' },
    { type: DeviceType.MediaPlayer, logs },
  )
  const device = new AlexaEchoDevice(ctx)
  await device.onActivate()
  await vi.advanceTimersByTimeAsync(0)
  return { device, providers, logs }
}

function slice(device: AlexaEchoDevice, cap: string): Record<string, unknown> | undefined {
  return device.runtimeState.getCapState<Record<string, unknown>>(cap)
}

describe('AlexaEchoDevice', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    alexaEchoSessions.clear()
  })

  it('polls on activation and maps the player into the media-player slice', async () => {
    alexaEchoSessions.setResolver(() => session())
    const { device } = await build()
    expect(slice(device, 'media-player')).toMatchObject({
      state: 'playing',
      volumeLevel: 40,
    })
    expect(slice(device, 'do-not-disturb')).toMatchObject({ enabled: true })
    await device.removeDevice()
  })

  it('polls every 30 seconds', async () => {
    const s = session()
    alexaEchoSessions.setResolver(() => s)
    const { device } = await build()
    s.playerState.mockClear()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(s.playerState).toHaveBeenCalledTimes(1)
    await device.removeDevice()
  })

  it('a failed poll leaves the slice untouched and marks the device degraded, logging the deviceId once', async () => {
    const s = session()
    alexaEchoSessions.setResolver(() => s)
    const { device, logs } = await build()
    const before = slice(device, 'media-player')
    s.playerState.mockRejectedValue(new Error('amazon returned no player state'))
    await vi.advanceTimersByTimeAsync(30_000)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(slice(device, 'media-player')).toEqual(before)
    expect(device.pollHealth).toBe('degraded')
    const warns = logs.filter((l) => l.level === 'warn' && l.message.startsWith('alexa echo'))
    expect(warns).toHaveLength(1)
    expect(warns[0]?.extras).toMatchObject({ tags: { deviceId: 7 } })
    await device.removeDevice()
  })

  it('a 429 keeps the slice, reports rate-limited and is not a warning', async () => {
    const s = session()
    alexaEchoSessions.setResolver(() => s)
    const { device, logs } = await build()
    const before = slice(device, 'media-player')
    s.playerState.mockRejectedValue(new RateLimitedError('429'))
    await vi.advanceTimersByTimeAsync(30_000)
    expect(slice(device, 'media-player')).toEqual(before)
    expect(device.pollHealth).toBe('rate-limited')
    expect(
      logs.filter((l) => l.level === 'warn' && l.message.startsWith('alexa echo')),
    ).toHaveLength(0)
    await device.removeDevice()
  })

  it('does not call Amazon while the account is in its back-off', async () => {
    const s = session({ rateLimitedUntil: Date.now() + 60_000 })
    alexaEchoSessions.setResolver(() => s)
    const { device } = await build()
    expect(s.playerState).not.toHaveBeenCalled()
    expect(device.pollHealth).toBe('rate-limited')
    await device.removeDevice()
  })

  it('an Echo Amazon lists offline is off with nothing read', async () => {
    const s = session({
      devices: [
        {
          id: 'S1',
          name: 'K',
          family: 'ECHO',
          online: false,
          kind: 'device',
          dnd: false,
          deviceType: 'T1',
        },
      ],
    })
    alexaEchoSessions.setResolver(() => s)
    const { device } = await build()
    expect(s.playerState).not.toHaveBeenCalled()
    expect(slice(device, 'media-player')).toMatchObject({
      state: 'off',
      volumeLevel: null,
    })
    await device.removeDevice()
  })

  it('a command is sent and followed by one re-read about 1.5 s later', async () => {
    const s = session()
    alexaEchoSessions.setResolver(() => s)
    const { device, providers } = await build()
    const player = providers.get('media-player') as {
      pause(i: { deviceId: number }): Promise<void>
    }
    s.playerState.mockClear()
    await player.pause({ deviceId: 7 })
    expect(s.npCommand).toHaveBeenCalledWith('S1', 'pause')
    await vi.advanceTimersByTimeAsync(1_400)
    expect(s.playerState).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(200)
    expect(s.playerState).toHaveBeenCalledTimes(1)
    await device.removeDevice()
  })

  it('sets the volume as a whole percent and offers only volume, next and previous', async () => {
    const s = session()
    alexaEchoSessions.setResolver(() => s)
    const { device, providers } = await build()
    const player = providers.get('media-player') as {
      setVolume(i: { deviceId: number; volumeLevel: number }): Promise<void>
      seek(i: { deviceId: number; position: number }): Promise<void>
    }
    await player.setVolume({ deviceId: 7, volumeLevel: 41.6 })
    expect(s.setVolume).toHaveBeenCalledWith('S1', 42)
    await expect(player.seek({ deviceId: 7, position: 1 })).rejects.toThrow('not available')
    expect(device.features).toHaveLength(3)
    await device.removeDevice()
  })

  it('setEnabled writes Do Not Disturb and the slice follows', async () => {
    const s = session()
    alexaEchoSessions.setResolver(() => s)
    const { device, providers } = await build()
    const dnd = providers.get('do-not-disturb') as {
      setEnabled(i: { deviceId: number; enabled: boolean }): Promise<void>
    }
    await dnd.setEnabled({ deviceId: 7, enabled: false })
    expect(s.setDnd).toHaveBeenCalledWith('S1', false)
    expect(slice(device, 'do-not-disturb')).toMatchObject({ enabled: false })
    await device.removeDevice()
  })

  it('two Echoes of one account share one Do Not Disturb call', async () => {
    const s = session()
    alexaEchoSessions.setResolver(() => s)
    const a = await build('S1')
    const b = await build('S2')
    expect(s.dndState).toHaveBeenCalledTimes(1)
    expect(slice(b.device, 'do-not-disturb')).toMatchObject({ enabled: false })
    await a.device.removeDevice()
    await b.device.removeDevice()
  })

  describe('idle volume from the account list', () => {
    const idle = async (): Promise<PlayerInfo> => ({ state: 'IDLE' })

    it('an idle Echo takes volume and mute from the volume list', async () => {
      const s = session({ playerState: vi.fn(idle) })
      alexaEchoSessions.setResolver(() => s)
      const { device } = await build()
      expect(slice(device, 'media-player')).toMatchObject({ volumeLevel: 46, isMuted: false })
      await device.removeDevice()
    })

    it('the player volume beats the list', async () => {
      const s = session({
        playerState: vi.fn(
          async (): Promise<PlayerInfo> => ({
            state: 'PLAYING',
            volume: { volume: 40, muted: false },
          }),
        ),
      })
      alexaEchoSessions.setResolver(() => s)
      const { device } = await build()
      expect(slice(device, 'media-player')).toMatchObject({ volumeLevel: 40 })
      expect(s.deviceVolumes).not.toHaveBeenCalled()
      await device.removeDevice()
    })

    it('a failed list read leaves volume null (never 0) and warns once with the deviceId', async () => {
      const s = session({
        playerState: vi.fn(idle),
        deviceVolumes: vi.fn(async () => {
          throw new Error('boom')
        }),
      })
      alexaEchoSessions.setResolver(() => s)
      const { device, logs } = await build()
      await vi.advanceTimersByTimeAsync(30_000)
      await vi.advanceTimersByTimeAsync(30_000)
      expect(slice(device, 'media-player')).toMatchObject({ volumeLevel: null, isMuted: null })
      const warns = logs.filter((l) => l.level === 'warn' && l.message.includes('volume list'))
      expect(warns).toHaveLength(1)
      expect(warns[0]?.extras).toMatchObject({ tags: { deviceId: 7 } })
      await device.removeDevice()
    })

    it('two Echoes of one account share one volume list read', async () => {
      const s = session({ playerState: vi.fn(idle) })
      alexaEchoSessions.setResolver(() => s)
      const a = await build('S1')
      const b = await build('S2')
      expect(s.deviceVolumes).toHaveBeenCalledTimes(1)
      expect(slice(a.device, 'media-player')).toMatchObject({ volumeLevel: 46 })
      expect(slice(b.device, 'media-player')).toMatchObject({ volumeLevel: 20, isMuted: true })
      await a.device.removeDevice()
      await b.device.removeDevice()
    })

    it('volume steps move from the known level and refuse without one', async () => {
      const s = session({ playerState: vi.fn(idle) })
      alexaEchoSessions.setResolver(() => s)
      const { device, providers } = await build()
      const player = providers.get('media-player') as {
        volumeUp(i: { deviceId: number }): Promise<void>
        volumeDown(i: { deviceId: number }): Promise<void>
      }
      await player.volumeUp({ deviceId: 7 })
      expect(s.setVolume).toHaveBeenLastCalledWith('S1', 56)
      await player.volumeDown({ deviceId: 7 })
      expect(s.setVolume).toHaveBeenLastCalledWith('S1', 36)
      await device.removeDevice()
    })
  })

  it('removing the device stops the poll', async () => {
    const s = session()
    alexaEchoSessions.setResolver(() => s)
    const { device } = await build()
    await device.removeDevice()
    s.playerState.mockClear()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(s.playerState).not.toHaveBeenCalled()
  })
})
