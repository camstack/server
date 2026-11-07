import { DeviceType } from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { alexaEchoSessions, type EchoSession } from '../alexa-echo-sessions.js'
import { AlexaEchoDevice } from '../devices/alexa-echo-device.js'
import type { EchoDevice, PlayerInfo } from '../speak/worker-protocol.js'
import { makeCtx, type LogLine } from './fake-ctx.js'

const GROUP_PLAYING: PlayerInfo = {
  state: 'PLAYING',
  volume: { volume: 90, muted: false },
  infoText: { title: 'Song', subText1: 'Artist', subText2: 'Album' },
  mainArt: { url: 'https://art/x.jpg' },
}

function echo(id: string, parentClusters?: string[]): EchoDevice {
  return {
    id,
    name: id,
    family: 'ECHO',
    online: true,
    kind: 'device',
    dnd: false,
    deviceType: 'T1',
    ...(parentClusters !== undefined ? { parentClusters } : {}),
  }
}

const GROUP: EchoDevice = {
  id: 'G1',
  name: 'Salone',
  family: 'WHA',
  online: true,
  kind: 'group',
  dnd: false,
  deviceType: 'WHA',
}

function session(players: Record<string, PlayerInfo>, devices: readonly EchoDevice[]) {
  const playerState = vi.fn(async (serial: string): Promise<PlayerInfo> => players[serial] ?? {})
  const fake: EchoSession = {
    state: 'ready',
    rateLimitedUntil: null,
    devices,
    playerState,
    npCommand: vi.fn(async () => undefined),
    setVolume: vi.fn(async () => undefined),
    dndState: vi.fn(async () => new Map<string, boolean>()),
    deviceVolumes: vi.fn(async () => new Map([['S1', { volume: 33, muted: false }]])),
    setDnd: vi.fn(async () => undefined),
  }
  return { fake, playerState }
}

async function build(serial: string): Promise<{ device: AlexaEchoDevice; logs: LogLine[] }> {
  const logs: LogLine[] = []
  const { ctx } = makeCtx(
    { brokerId: 'b', serial, deviceType: 'T1', system: 'alexa' },
    { type: DeviceType.MediaPlayer, logs },
  )
  const device = new AlexaEchoDevice(ctx)
  await device.onActivate()
  await vi.advanceTimersByTimeAsync(0)
  return { device, logs }
}

function media(device: AlexaEchoDevice): Record<string, unknown> | undefined {
  return device.runtimeState.getCapState<Record<string, unknown>>('media-player')
}

describe('AlexaEchoDevice in a speaker group', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.useRealTimers()
    alexaEchoSessions.clear()
  })

  it('an empty member answer takes the playing group state, keeps its own volume, logs once', async () => {
    const { fake } = session({ G1: GROUP_PLAYING }, [echo('S1', ['G1']), GROUP])
    alexaEchoSessions.setResolver(() => fake)
    const { device, logs } = await build('S1')
    expect(media(device)).toMatchObject({
      state: 'playing',
      volumeLevel: 33,
      currentMedia: {
        title: 'Song',
        artist: 'Artist',
        album: 'Album',
        imageUrl: 'https://art/x.jpg',
      },
    })
    await vi.advanceTimersByTimeAsync(30_000)
    const via = logs.filter((l) => l.message.includes('playing via group'))
    expect(via).toHaveLength(1)
    expect(via[0]?.message).toContain('Salone')
    expect(via[0]?.extras).toMatchObject({ tags: { deviceId: 7 } })
    await device.removeDevice()
  })

  it("the member's own playback wins and the group is not read", async () => {
    const own: PlayerInfo = { state: 'PLAYING', infoText: { title: 'Mine' } }
    const { fake, playerState } = session({ S1: own, G1: GROUP_PLAYING }, [
      echo('S1', ['G1']),
      GROUP,
    ])
    alexaEchoSessions.setResolver(() => fake)
    const { device } = await build('S1')
    expect(media(device)).toMatchObject({ currentMedia: { title: 'Mine' } })
    expect(playerState).not.toHaveBeenCalledWith('G1', expect.anything(), expect.anything())
    await device.removeDevice()
  })

  it('an Echo in no group stays idle and reads nothing extra', async () => {
    const { fake, playerState } = session({ G1: GROUP_PLAYING }, [echo('S1'), GROUP])
    alexaEchoSessions.setResolver(() => fake)
    const { device } = await build('S1')
    expect(media(device)).toMatchObject({ state: 'idle', currentMedia: null })
    expect(playerState).toHaveBeenCalledTimes(1)
    await device.removeDevice()
  })

  it('an idle group leaves the member idle', async () => {
    const { fake } = session({}, [echo('S1', ['G1']), GROUP])
    alexaEchoSessions.setResolver(() => fake)
    const { device } = await build('S1')
    expect(media(device)).toMatchObject({ state: 'idle', currentMedia: null })
    await device.removeDevice()
  })

  it('two members of one group in the same poll share one group read', async () => {
    const { fake, playerState } = session({ G1: GROUP_PLAYING }, [
      echo('S1', ['G1']),
      echo('S2', ['G1']),
      GROUP,
    ])
    alexaEchoSessions.setResolver(() => fake)
    const a = await build('S1')
    const b = await build('S2')
    expect(media(a.device)).toMatchObject({ state: 'playing' })
    expect(media(b.device)).toMatchObject({ state: 'playing' })
    expect(playerState.mock.calls.filter((c) => c[0] === 'G1')).toHaveLength(1)
    await a.device.removeDevice()
    await b.device.removeDevice()
  })
})
