import { DeviceFeature, DeviceType } from '@camstack/types'
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
    expect(s.npCommand).toHaveBeenCalledWith('S1', 'pause', expect.any(Number))
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
    expect(s.setVolume).toHaveBeenCalledWith('S1', 42, expect.any(Number))
    await expect(player.seek({ deviceId: 7, position: 1 })).rejects.toThrow('not available')
    expect(device.features).toEqual([
      DeviceFeature.MediaPlayerVolume,
      DeviceFeature.MediaPlayerNext,
      DeviceFeature.MediaPlayerPrevious,
      DeviceFeature.MediaPlayerShuffle,
      DeviceFeature.MediaPlayerRepeat,
    ])
    await device.removeDevice()
  })

  it('shuffle and repeat go to Amazon as on/off commands; repeat one is refused by name', async () => {
    const s = session()
    alexaEchoSessions.setResolver(() => s)
    const { device, providers } = await build()
    const player = providers.get('media-player') as {
      setShuffle(i: { deviceId: number; shuffle: boolean }): Promise<void>
      setRepeat(i: { deviceId: number; repeat: 'off' | 'all' | 'one' }): Promise<void>
    }
    await player.setShuffle({ deviceId: 7, shuffle: true })
    expect(s.npCommand).toHaveBeenLastCalledWith('S1', 'shuffle-on', expect.any(Number))
    await player.setShuffle({ deviceId: 7, shuffle: false })
    expect(s.npCommand).toHaveBeenLastCalledWith('S1', 'shuffle-off', expect.any(Number))
    await player.setRepeat({ deviceId: 7, repeat: 'all' })
    expect(s.npCommand).toHaveBeenLastCalledWith('S1', 'repeat-on', expect.any(Number))
    await player.setRepeat({ deviceId: 7, repeat: 'off' })
    expect(s.npCommand).toHaveBeenLastCalledWith('S1', 'repeat-off', expect.any(Number))
    s.npCommand.mockClear()
    await expect(player.setRepeat({ deviceId: 7, repeat: 'one' })).rejects.toThrow(
      'repeat one is not available on an Echo',
    )
    expect(s.npCommand).not.toHaveBeenCalled()
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
    expect(s.setDnd).toHaveBeenCalledWith('S1', false, expect.any(Number))
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
      expect(slice(device, 'media-player')).toMatchObject({
        volumeLevel: 46,
        isMuted: false,
      })
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
      expect(slice(device, 'media-player')).toMatchObject({
        volumeLevel: null,
        isMuted: null,
      })
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
      expect(slice(a.device, 'media-player')).toMatchObject({
        volumeLevel: 46,
      })
      expect(slice(b.device, 'media-player')).toMatchObject({
        volumeLevel: 20,
        isMuted: true,
      })
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
      expect(s.setVolume).toHaveBeenLastCalledWith('S1', 56, expect.any(Number))
      // The poll still says 46; the second step starts from the 56 we just set.
      await player.volumeUp({ deviceId: 7 })
      expect(s.setVolume).toHaveBeenLastCalledWith('S1', 66, expect.any(Number))
      await vi.advanceTimersByTimeAsync(30_000)
      // A read that began after the last set wins again (the fake still reports 46).
      await player.volumeDown({ deviceId: 7 })
      expect(s.setVolume).toHaveBeenLastCalledWith('S1', 36, expect.any(Number))
      await device.removeDevice()
    })
  })

  describe('optimistic volume and Do Not Disturb', () => {
    type Player = {
      setVolume(i: { deviceId: number; volumeLevel: number }): Promise<void>
      volumeUp(i: { deviceId: number }): Promise<void>
    }
    type Dnd = { setEnabled(i: { deviceId: number; enabled: boolean }): Promise<void> }

    function deferred(): {
      promise: Promise<undefined>
      resolve: () => void
      reject: (e: Error) => void
    } {
      let resolve: () => void = () => undefined
      let reject: (e: Error) => void = () => undefined
      const promise = new Promise<undefined>((res, rej) => {
        resolve = () => res(undefined)
        reject = rej
      })
      return { promise, resolve, reject }
    }

    it('the slice shows the new level BEFORE Amazon answers', async () => {
      const s = session()
      const gate = deferred()
      s.setVolume.mockReturnValue(gate.promise)
      alexaEchoSessions.setResolver(() => s)
      const { device, providers } = await build()
      const player = providers.get('media-player') as Player
      const pending = player.setVolume({ deviceId: 7, volumeLevel: 80 })
      await vi.advanceTimersByTimeAsync(0)
      expect(slice(device, 'media-player')).toMatchObject({ volumeLevel: 80, state: 'playing' })
      gate.resolve()
      await pending
      expect(slice(device, 'media-player')).toMatchObject({ volumeLevel: 80 })
      await device.removeDevice()
    })

    it('a refused set restores the previous slice with a new stamp, warns with the deviceId and rethrows', async () => {
      const s = session()
      alexaEchoSessions.setResolver(() => s)
      const { device, providers, logs } = await build()
      const player = providers.get('media-player') as Player
      const before = slice(device, 'media-player')
      await vi.advanceTimersByTimeAsync(5_000)
      s.setVolume.mockRejectedValue(new RateLimitedError('429'))
      await expect(player.setVolume({ deviceId: 7, volumeLevel: 80 })).rejects.toBeInstanceOf(
        RateLimitedError,
      )
      const after = slice(device, 'media-player')
      expect(after).toMatchObject({ volumeLevel: before?.['volumeLevel'], state: 'playing' })
      expect(after?.['lastChangedAt']).toBeGreaterThan(Number(before?.['lastChangedAt']))
      const warn = logs.find((l) => l.level === 'warn' && l.message.includes('volume'))
      expect(warn?.extras).toMatchObject({
        tags: { deviceId: 7 },
        meta: { from: before?.['volumeLevel'], to: 80 },
      })
      await device.removeDevice()
    })

    it('a volume set is not followed by a re-read, a transport command still is', async () => {
      const s = session()
      alexaEchoSessions.setResolver(() => s)
      const { device, providers } = await build()
      const player = providers.get('media-player') as Player
      s.playerState.mockClear()
      await player.setVolume({ deviceId: 7, volumeLevel: 30 })
      await vi.advanceTimersByTimeAsync(2_000)
      expect(s.playerState).not.toHaveBeenCalled()
      await device.removeDevice()
    })

    it('a poll that began before the set cannot overwrite the new level', async () => {
      const s = session()
      alexaEchoSessions.setResolver(() => s)
      const { device, providers } = await build()
      const player = providers.get('media-player') as Player
      let release: (info: PlayerInfo) => void = () => undefined
      s.playerState.mockImplementationOnce(
        () =>
          new Promise<PlayerInfo>((res) => {
            release = res
          }),
      )
      const polling = device.poll()
      await vi.advanceTimersByTimeAsync(10)
      await player.setVolume({ deviceId: 7, volumeLevel: 80 })
      release({ state: 'PLAYING', volume: { volume: 40 } })
      await polling
      expect(slice(device, 'media-player')).toMatchObject({ volumeLevel: 80 })
      // The next poll began after the set: Amazon's answer is the truth again.
      await vi.advanceTimersByTimeAsync(30_000)
      expect(slice(device, 'media-player')).toMatchObject({ volumeLevel: 40 })
      await device.removeDevice()
    })

    it('a set drops the shared volume list so the next poll does not reuse an older one', async () => {
      const s = session({ playerState: vi.fn(async (): Promise<PlayerInfo> => ({ state: 'IDLE' })) })
      alexaEchoSessions.setResolver(() => s)
      const { device, providers } = await build()
      const player = providers.get('media-player') as Player
      expect(s.deviceVolumes).toHaveBeenCalledTimes(1)
      await player.setVolume({ deviceId: 7, volumeLevel: 80 })
      await device.poll()
      expect(s.deviceVolumes).toHaveBeenCalledTimes(2)
      await device.removeDevice()
    })

    it('Do Not Disturb flips in the slice before Amazon answers and reverts on failure', async () => {
      const s = session()
      alexaEchoSessions.setResolver(() => s)
      const { device, providers, logs } = await build()
      const dnd = providers.get('do-not-disturb') as Dnd
      const gate = deferred()
      s.setDnd.mockReturnValue(gate.promise)
      const pending = dnd.setEnabled({ deviceId: 7, enabled: false })
      pending.catch(() => undefined)
      await vi.advanceTimersByTimeAsync(0)
      expect(slice(device, 'do-not-disturb')).toMatchObject({ enabled: false })
      gate.reject(new Error('refused'))
      await expect(pending).rejects.toThrow('refused')
      expect(slice(device, 'do-not-disturb')).toMatchObject({ enabled: true })
      const warn = logs.find((l) => l.level === 'warn' && l.message.includes('Do Not Disturb'))
      expect(warn?.extras).toMatchObject({ tags: { deviceId: 7 }, meta: { from: true, to: false } })
      await device.removeDevice()
    })

    it('a Do Not Disturb read that began before the set cannot undo it', async () => {
      const s = session()
      alexaEchoSessions.setResolver(() => s)
      const { device, providers } = await build()
      const dnd = providers.get('do-not-disturb') as Dnd
      let release: (m: ReadonlyMap<string, boolean>) => void = () => undefined
      s.dndState.mockImplementationOnce(
        () =>
          new Promise<ReadonlyMap<string, boolean>>((res) => {
            release = res
          }),
      )
      await vi.advanceTimersByTimeAsync(30_000)
      await dnd.setEnabled({ deviceId: 7, enabled: false })
      release(new Map([['S1', true]]))
      await vi.advanceTimersByTimeAsync(0)
      expect(slice(device, 'do-not-disturb')).toMatchObject({ enabled: false })
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
