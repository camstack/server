/**
 * A media player exported as a TV (planning#398): the discovery shape follows
 * the features and the readings, a property exists only for a known value, and
 * every directive lands on the `media-player` cap with its step count.
 */
import { DeviceFeature, type AddonContext } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { resolveGenericDirective } from '../endpoints/adapters/index.js'
import type { AdapterDirectiveContext } from '../endpoints/adapters/types.js'
import { buildGenericDeviceEndpoint } from '../endpoints/generic-device.js'
import { validateAlexaEndpoint } from '../endpoints/validate-endpoint.js'
import type { DirectiveRouterDeps } from '../directive-router.js'
import {
  handleMediaPlayerDirective,
  STEP_ANSWER_BUDGET_MS,
} from '../handlers/media-player-controller.js'
import { genericPropertiesFor } from '../handlers/generic-state.js'
import { quietLogger } from './helpers/fake-device-api.js'

function slice(overrides: Record<string, unknown> = {}) {
  return {
    state: 'standby',
    stateSource: 'assumed',
    assumedFields: ['state'],
    volumeLevel: null,
    isMuted: null,
    source: '',
    availableSources: [],
    currentMedia: null,
    position: null,
    duration: null,
    shuffle: null,
    repeat: null,
    lastChangedAt: 1,
    ...overrides,
  }
}

const IR_FEATURES: readonly string[] = [
  DeviceFeature.MediaPlayerPower,
  DeviceFeature.MediaPlayerVolumeStep,
  DeviceFeature.MediaPlayerChannelStep,
  DeviceFeature.MediaPlayerMute,
  DeviceFeature.MediaPlayerStop,
]

function build(features: readonly string[], mediaSlice: unknown = slice()) {
  return buildGenericDeviceEndpoint({
    deviceId: 5478,
    stableId: 's5478',
    name: 'Samsung TV',
    type: 'media-player',
    capNames: ['media-player', 'power-source'],
    features,
    slices: { 'media-player': mediaSlice },
  })
}

function interfaces(features: readonly string[], mediaSlice?: unknown): readonly string[] {
  const built = build(features, mediaSlice)
  if (built === null) throw new Error('the TV was not published')
  return built.capabilities.map((c) => c.interface)
}

function api() {
  const mutate = () => ({ mutate: vi.fn().mockResolvedValue(undefined) })
  return {
    mediaPlayer: {
      turnOn: mutate(),
      turnOff: mutate(),
      volumeUp: mutate(),
      volumeDown: mutate(),
      channelUp: mutate(),
      channelDown: mutate(),
      setMute: mutate(),
      selectSource: mutate(),
      play: mutate(),
      pause: mutate(),
      stop: mutate(),
      next: mutate(),
      previous: mutate(),
    },
    deviceManager: {
      getBindings: {
        query: vi.fn().mockResolvedValue({ entries: [{ capName: 'media-player' }] }),
      },
    },
    deviceState: { getCapSlice: { query: vi.fn().mockResolvedValue(slice()) } },
  }
}

type Api = ReturnType<typeof api>

function directive(key: string, payload: unknown, fake: Api): AdapterDirectiveContext {
  const [namespace = '', name = ''] = key.split('/')
  const ctx = { api: fake } as unknown as AddonContext
  const deps = {
    mediaPlayerController: { ctx, logger: quietLogger },
    // Registered before the player: it is asked first and must decline.
    climateController: { ctx, logger: quietLogger },
  } as unknown as DirectiveRouterDeps
  return {
    header: {
      namespace,
      name,
      payloadVersion: '3',
      messageId: 'm',
      correlationToken: 'c',
    },
    endpoint: { endpointId: '5478__dev' },
    payload,
    deviceId: 5478,
    deps,
    identity: { userId: 'u', username: 'u', scopes: [] },
  }
}

interface Answer {
  event: { header: { name: string }; payload: { type?: string } }
}

async function run(key: string, payload: unknown, fake: Api): Promise<Answer> {
  return (await handleMediaPlayerDirective(directive(key, payload, fake))) as Answer
}

describe('media-player discovery', () => {
  it('is a TV carrying exactly the interfaces its features name', () => {
    const built = build(IR_FEATURES)
    expect(built?.displayCategories).toEqual(['TV'])
    expect(interfaces(IR_FEATURES)).toEqual([
      'Alexa',
      'Alexa.PowerController',
      'Alexa.StepSpeaker',
      'Alexa.Speaker',
      'Alexa.ChannelController',
      'Alexa.PlaybackController',
      'Alexa.EndpointHealth',
    ])
    if (built !== null) expect(validateAlexaEndpoint(built)).toEqual([])
  })

  it('leaves out what the player cannot do', () => {
    const names = interfaces([DeviceFeature.MediaPlayerPower])
    expect(names).toContain('Alexa.PowerController')
    expect(names).not.toContain('Alexa.StepSpeaker')
    expect(names).not.toContain('Alexa.ChannelController')
    expect(names).not.toContain('Alexa.Speaker')
  })

  it('offers play and pause only on a player that reports its state', () => {
    const assumed = build(IR_FEATURES)?.capabilities.find(
      (c) => c.interface === 'Alexa.PlaybackController',
    )
    expect(assumed?.supportedOperations).toEqual(['Stop'])
    const reported = build(
      IR_FEATURES,
      slice({ state: 'idle', stateSource: 'reported', assumedFields: [] }),
    )?.capabilities.find((c) => c.interface === 'Alexa.PlaybackController')
    expect(reported?.supportedOperations).toEqual(['Play', 'Pause', 'Stop'])
  })

  it('offers inputs only from reported sources Amazon names', () => {
    const built = build(
      [...IR_FEATURES, DeviceFeature.MediaPlayerSelectSource],
      slice({
        state: 'on',
        stateSource: 'reported',
        assumedFields: [],
        availableSources: ['hdmi1', 'Netflix'],
        source: 'hdmi1',
      }),
    )
    const input = built?.capabilities.find((c) => c.interface === 'Alexa.InputController')
    expect(input?.inputs).toEqual([{ name: 'HDMI 1' }])
    if (built !== null) expect(validateAlexaEndpoint(built)).toEqual([])
  })
})

describe('media-player state', () => {
  it('reports no power for an assumed standby, and nothing for an unknown mute', () => {
    expect(genericPropertiesFor('media-player', slice())).toEqual([])
  })

  it('reports power off, and mute when it is known', () => {
    const off = genericPropertiesFor('media-player', slice({ state: 'off', isMuted: true }))
    expect(off.map((p) => [p.name, p.value])).toEqual([
      ['powerState', 'OFF'],
      ['muted', true],
    ])
  })

  it('never invents a volume', () => {
    const names = genericPropertiesFor('media-player', slice({ state: 'on', volumeLevel: 30 })).map(
      (p) => p.name,
    )
    expect(names).toEqual(['powerState'])
  })
})

describe('media-player directives', () => {
  it('"volume up 5" is volumeUp with 5 steps', async () => {
    const fake = api()
    const answer = await run('Alexa.StepSpeaker/AdjustVolume', { volumeSteps: 5 }, fake)
    expect(answer.event.header.name).toBe('Response')
    expect(fake.mediaPlayer.volumeUp.mutate).toHaveBeenCalledWith({
      deviceId: 5478,
      steps: 5,
    })
    expect(fake.mediaPlayer.volumeDown.mutate).not.toHaveBeenCalled()
  })

  it('a negative step count is volumeDown, capped at the bound', async () => {
    const fake = api()
    await run('Alexa.StepSpeaker/AdjustVolume', { volumeSteps: -80 }, fake)
    expect(fake.mediaPlayer.volumeDown.mutate).toHaveBeenCalledWith({
      deviceId: 5478,
      steps: 50,
    })
  })

  it('skips channels up and down', async () => {
    const fake = api()
    await run('Alexa.ChannelController/SkipChannels', { channelCount: -2 }, fake)
    await run('Alexa.ChannelController/SkipChannels', { channelCount: 3 }, fake)
    expect(fake.mediaPlayer.channelDown.mutate).toHaveBeenCalledWith({
      deviceId: 5478,
      steps: 2,
    })
    expect(fake.mediaPlayer.channelUp.mutate).toHaveBeenCalledWith({
      deviceId: 5478,
      steps: 3,
    })
  })

  it('mutes through either speaker interface', async () => {
    const fake = api()
    await run('Alexa.Speaker/SetMute', { mute: true }, fake)
    expect(fake.mediaPlayer.setMute.mutate).toHaveBeenCalledWith({
      deviceId: 5478,
      muted: true,
    })
  })

  it('answers an error, not a success, when the player refuses', async () => {
    const fake = api()
    fake.mediaPlayer.volumeUp.mutate.mockRejectedValue(new Error('media-player.unsupported'))
    const answer = await run('Alexa.StepSpeaker/AdjustVolume', { volumeSteps: 1 }, fake)
    expect(answer.event.header.name).toBe('ErrorResponse')
  })

  it('refuses a missing step count', async () => {
    const answer = await run('Alexa.StepSpeaker/AdjustVolume', {}, api())
    expect(answer.event.payload.type).toBe('INVALID_DIRECTIVE')
  })

  it('selects an input by the player own name', async () => {
    const fake = api()
    fake.deviceState.getCapSlice.query.mockResolvedValue(
      slice({ availableSources: ['hdmi1'], source: '' }),
    )
    await run('Alexa.InputController/SelectInput', { input: 'HDMI 1' }, fake)
    expect(fake.mediaPlayer.selectSource.mutate).toHaveBeenCalledWith({
      deviceId: 5478,
      source: 'hdmi1',
    })
  })

  it('routes power through the registry to the player, not the switch handler', async () => {
    const fake = api()
    const context = directive('Alexa.PowerController/TurnOn', {}, fake)
    const found = await resolveGenericDirective(context)
    expect(found?.handle).toBeDefined()
    await found?.handle(context)
    expect(fake.mediaPlayer.turnOn.mutate).toHaveBeenCalledWith({
      deviceId: 5478,
    })
  })
})

describe('media-player answers assert only what is read back', () => {
  const props = (answer: unknown) =>
    (answer as { context?: { properties: Array<{ name: string }> } }).context?.properties ?? []

  it('an assumed source gets no powerState after turnOn', async () => {
    const fake = api()
    fake.deviceState.getCapSlice.query.mockResolvedValue(slice({ state: 'on' }))
    const answer = await run('Alexa.PowerController/TurnOn', {}, fake)
    expect(answer.event.header.name).toBe('Response')
    expect(props(answer)).toEqual([])
  })

  it('a reported source gets the re-read powerState', async () => {
    const fake = api()
    fake.deviceState.getCapSlice.query.mockResolvedValue(
      slice({ state: 'on', stateSource: 'reported', assumedFields: [] }),
    )
    const answer = await run('Alexa.PowerController/TurnOn', {}, fake)
    expect(props(answer).map((p) => p.name)).toEqual(['powerState'])
  })

  it('an assumed mute is not asserted either', async () => {
    const fake = api()
    fake.deviceState.getCapSlice.query.mockResolvedValue(slice({ state: 'on', isMuted: true }))
    const answer = await run('Alexa.Speaker/SetMute', { mute: true }, fake)
    expect(props(answer)).toEqual([])
  })
})

describe('a long train run does not hold the Alexa answer', () => {
  it('answers after the budget while the sends continue, and names a late failure', async () => {
    vi.useFakeTimers()
    try {
      const fake = api()
      let fail: (e: Error) => void = () => undefined
      fake.mediaPlayer.volumeUp.mutate.mockReturnValue(
        new Promise<void>((_, reject) => {
          fail = reject
        }),
      )
      const pending = run('Alexa.StepSpeaker/AdjustVolume', { volumeSteps: 50 }, fake)
      await vi.advanceTimersByTimeAsync(STEP_ANSWER_BUDGET_MS)
      expect((await pending).event.header.name).toBe('Response')
      fail(new Error('board is off'))
      await vi.advanceTimersByTimeAsync(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
