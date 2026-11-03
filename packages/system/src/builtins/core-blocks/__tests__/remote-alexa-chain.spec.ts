/**
 * The chain behind "Alexa, volume up 5" on an infrared television (planning#398),
 * composed from the REAL redirect and the REAL remote service, with fake timers and
 * a fake transmitter. The Alexa handler (`media-player-controller.ts`) lives in an
 * addon, and addons never import each other or `system`, so this spec stands where
 * the composition is legal and drives the redirect with the exact call shape the
 * handler issues: `mediaPlayer.volumeUp|volumeDown|channelUp|channelDown` with
 * `{ deviceId, steps }`, `steps` already `min(|n|, MEDIA_PLAYER_MAX_STEPS)`.
 */
import {
  type CapCall,
  EMPTY_REMOTE_CONFIG,
  MEDIA_PLAYER_MAX_STEPS,
  type RemoteConfig,
  REMOTE_MAX_REPEAT,
} from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { remoteCallRedirect } from '../remote-call-redirect.js'
import { REMOTE_REPEAT_GAP_MS, RemoteService } from '../remote-service.js'
import { recordingLogger } from './fixtures.js'

const TV = 12
const BOARD = 3

const ir = (code: number): RemoteConfig['bindings'][string] => ({
  action: {
    kind: 'cap',
    deviceId: BOARD,
    cap: 'ir-transmitter',
    method: 'send',
    args: { timings: [9000, -4500, code] },
  },
})

const CONFIG: RemoteConfig = {
  ...EMPTY_REMOTE_CONFIG,
  bindings: {
    volume_up: ir(1),
    volume_down: ir(2),
    channel_up: ir(3),
    channel_down: ir(4),
  },
}

function chain() {
  const sent: { readonly call: CapCall; readonly at: number }[] = []
  const remote = new RemoteService({
    store: { read: async () => CONFIG, write: async () => undefined },
    invoke: async (call) => {
      sent.push({ call, at: Date.now() })
    },
    templateExists: async () => true,
    isMediaPlayer: async () => true,
    reportedStatus: async () => null,
    runningState: async () => null,
    plugOn: async () => null,
    assumptions: { read: async () => null, write: async () => undefined },
    logger: recordingLogger().logger,
  })
  const redirect = remoteCallRedirect({
    remote,
    hasNative: () => false,
    logger: recordingLogger().logger,
  })
  return { redirect, sent }
}

/** The call the Alexa handler makes for a step directive. */
const alexaStep = (method: string, steps: number) => ({
  capName: 'media-player',
  method,
  deviceId: TV,
  args: { deviceId: TV, steps },
})

async function run(method: string, steps: number) {
  const { redirect, sent } = chain()
  const answer = redirect.attempt(alexaStep(method, steps))
  await vi.runAllTimersAsync()
  expect(await answer).toEqual({ kind: 'redirected', result: undefined })
  return sent
}

describe('Alexa step directive -> redirect -> remote service -> transmitter', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('"volume up 5" is 5 full sends of the volume_up code, 150 ms apart', async () => {
    const sent = await run('volumeUp', 5)
    expect(sent).toHaveLength(5)
    for (const s of sent) {
      expect(s.call).toMatchObject({ deviceId: BOARD, cap: 'ir-transmitter', method: 'send' })
      expect(s.call.args).toEqual({ timings: [9000, -4500, 1] })
    }
    expect(sent.map((s) => s.at - sent[0]!.at)).toEqual([0, 150, 300, 450, 600])
    expect(REMOTE_REPEAT_GAP_MS).toBe(150)
  })

  it('"volume down 2" sends the volume_down code, "channel up 3" the channel_up code', async () => {
    const down = await run('volumeDown', 2)
    expect(down.map((s) => s.call.args)).toEqual([
      { timings: [9000, -4500, 2] },
      { timings: [9000, -4500, 2] },
    ])
    const channel = await run('channelUp', 3)
    expect(channel).toHaveLength(3)
    expect(channel.map((s) => s.at - channel[0]!.at)).toEqual([0, 150, 300])
    expect(channel[0]?.call.args).toEqual({ timings: [9000, -4500, 3] })
  })

  it('a count above the cap is clamped to 50 sends', async () => {
    expect(REMOTE_MAX_REPEAT).toBe(MEDIA_PLAYER_MAX_STEPS)
    const sent = await run('channelDown', 500)
    expect(sent).toHaveLength(50)
    expect(sent[49]!.at - sent[0]!.at).toBe(49 * 150)
  })

  it('a single step is one send with no wait', async () => {
    const sent = await run('volumeUp', 1)
    expect(sent).toHaveLength(1)
  })
})
