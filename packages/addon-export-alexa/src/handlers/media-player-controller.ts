/**
 * The directives of a media player exported as a TV (planning#398):
 * `Alexa.PowerController`, `Alexa.StepSpeaker`, `Alexa.Speaker`,
 * `Alexa.ChannelController`, `Alexa.PlaybackController`, `Alexa.InputController`,
 * each routed to the `media-player` cap. A step count goes through as `steps`
 * (the remote sends that many trains); a command the player cannot do comes back
 * as an ErrorResponse, never as a success.
 */
import type { AddonContext, IScopedLogger } from '@camstack/types'
import { MEDIA_PLAYER_MAX_STEPS } from '@camstack/types'
import { z } from 'zod'
import {
  CAP_MEDIA_PLAYER,
  inputPairs,
  mediaPlayerProperties,
  readMediaPlayerSlice,
} from '../endpoints/adapters/media-player-model.js'
import type { AdapterDirectiveContext, GenericProperty } from '../endpoints/adapters/types.js'
import { errorEnvelope } from './error-envelope.js'

export interface MediaPlayerControllerContext {
  readonly ctx: AddonContext
  readonly logger: IScopedLogger
}

const UNCERTAINTY_MS = 1000
const CAP_SWITCH = 'switch'

const StepsPayload = z.object({ volumeSteps: z.number().int() })
const ChannelPayload = z.object({ channelCount: z.number().int() })
const MutePayload = z.object({ mute: z.boolean() })
const InputPayload = z.object({ input: z.string() })

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function success(c: AdapterDirectiveContext, properties: readonly GenericProperty[]): unknown {
  const now = new Date().toISOString()
  return {
    event: {
      header: {
        namespace: 'Alexa',
        name: 'Response',
        messageId: c.header.messageId,
        ...(c.header.correlationToken !== undefined
          ? { correlationToken: c.header.correlationToken }
          : {}),
        payloadVersion: '3',
      },
      endpoint: { endpointId: c.endpoint.endpointId },
      payload: {},
    },
    context: {
      properties: properties.map((p) => ({
        ...p,
        timeOfSample: now,
        uncertaintyInMilliseconds: UNCERTAINTY_MS,
      })),
    },
  }
}

/** PowerController on a media player, not on a switch: decided by the bound caps. */
export async function claimsMediaPlayerPower(c: AdapterDirectiveContext): Promise<boolean> {
  const deps = c.deps.mediaPlayerController
  try {
    const bindings = await deps.ctx.api.deviceManager.getBindings.query({
      deviceId: c.deviceId,
    })
    const caps = bindings.entries.map((e) => e.capName)
    return caps.includes(CAP_MEDIA_PLAYER) && !caps.includes(CAP_SWITCH)
  } catch (err: unknown) {
    deps.logger.warn('alexa media-player-controller: the bound caps could not be read', {
      tags: { deviceId: c.deviceId },
      meta: {
        error: message(err),
        decidedFrom: 'no previous answer: not claimed',
      },
    })
    return false
  }
}

/** How long a step command may run before Alexa is answered anyway (its own budget is ~8 s). */
export const STEP_ANSWER_BUDGET_MS = 3000

/** The properties a command may assert: only those the player READS back, never an assumption (D393). */
async function reportedProperties(
  c: AdapterDirectiveContext,
  namespace: string,
): Promise<readonly GenericProperty[]> {
  const deps = c.deps.mediaPlayerController
  try {
    const slice = await deps.ctx.api.deviceState.getCapSlice.query({
      deviceId: c.deviceId,
      capName: CAP_MEDIA_PLAYER,
    })
    const status = readMediaPlayerSlice(slice)
    if (status === null || status.stateSource !== 'reported') return []
    return mediaPlayerProperties(slice).filter((p) => p.namespace === namespace)
  } catch (err: unknown) {
    deps.logger.warn('alexa media-player-controller: the state could not be re-read', {
      tags: { deviceId: c.deviceId },
      meta: { error: message(err) },
    })
    return []
  }
}

type Settled = { readonly ok: true } | { readonly ok: false; readonly error: unknown }

async function attempt(
  c: AdapterDirectiveContext,
  what: string,
  run: () => Promise<unknown>,
  options: { readonly namespace?: string; readonly slow?: boolean } = {},
): Promise<unknown> {
  const deps = c.deps.mediaPlayerController
  const settled: Promise<Settled> = run().then(
    (): Settled => ({ ok: true }),
    (error: unknown): Settled => ({ ok: false, error }),
  )
  let timer: ReturnType<typeof setTimeout> | undefined
  const outcome =
    options.slow === true
      ? await Promise.race([
          settled,
          new Promise<null>((resolve) => {
            timer = setTimeout(() => resolve(null), STEP_ANSWER_BUDGET_MS)
          }),
        ])
      : await settled
  if (timer !== undefined) clearTimeout(timer)
  if (outcome === null) {
    // Many trains take longer than Alexa waits: answer now, and name a late failure.
    deps.logger.info(`alexa media-player-controller: ${what} still sending, answered`, {
      tags: { deviceId: c.deviceId },
    })
    void settled.then((late) => {
      if (!late.ok) {
        deps.logger.warn(`alexa media-player-controller: ${what} failed after the answer`, {
          tags: { deviceId: c.deviceId },
          meta: { error: message(late.error) },
        })
      }
    })
    return success(c, [])
  }
  if (!outcome.ok) {
    deps.logger.warn(`alexa media-player-controller: ${what} failed`, {
      tags: { deviceId: c.deviceId },
      meta: { error: message(outcome.error) },
    })
    return errorEnvelope(c.header, 'ENDPOINT_UNREACHABLE', `the player did not accept ${what}`)
  }
  deps.logger.info(`alexa media-player-controller: ${what}`, { tags: { deviceId: c.deviceId } })
  return success(
    c,
    options.namespace === undefined ? [] : await reportedProperties(c, options.namespace),
  )
}

async function volume(c: AdapterDirectiveContext): Promise<unknown> {
  const payload = StepsPayload.safeParse(c.payload)
  if (!payload.success || payload.data.volumeSteps === 0) {
    return errorEnvelope(c.header, 'INVALID_DIRECTIVE', 'volumeSteps is required')
  }
  const steps = Math.min(Math.abs(payload.data.volumeSteps), MEDIA_PLAYER_MAX_STEPS)
  const api = c.deps.mediaPlayerController.ctx.api.mediaPlayer
  const up = payload.data.volumeSteps > 0
  return attempt(
    c,
    `volume ${up ? 'up' : 'down'} ${steps}`,
    () =>
      up
        ? api.volumeUp.mutate({ deviceId: c.deviceId, steps })
        : api.volumeDown.mutate({ deviceId: c.deviceId, steps }),
    { slow: true },
  )
}

async function channel(c: AdapterDirectiveContext): Promise<unknown> {
  const payload = ChannelPayload.safeParse(c.payload)
  if (!payload.success || payload.data.channelCount === 0) {
    return errorEnvelope(c.header, 'INVALID_DIRECTIVE', 'channelCount is required')
  }
  const steps = Math.min(Math.abs(payload.data.channelCount), MEDIA_PLAYER_MAX_STEPS)
  const api = c.deps.mediaPlayerController.ctx.api.mediaPlayer
  const up = payload.data.channelCount > 0
  return attempt(
    c,
    `channel ${up ? 'up' : 'down'} ${steps}`,
    () =>
      up
        ? api.channelUp.mutate({ deviceId: c.deviceId, steps })
        : api.channelDown.mutate({ deviceId: c.deviceId, steps }),
    { slow: true },
  )
}

async function mute(c: AdapterDirectiveContext): Promise<unknown> {
  const payload = MutePayload.safeParse(c.payload)
  if (!payload.success) return errorEnvelope(c.header, 'INVALID_DIRECTIVE', 'mute is required')
  const muted = payload.data.mute
  const api = c.deps.mediaPlayerController.ctx.api.mediaPlayer
  return attempt(
    c,
    `mute ${String(muted)}`,
    () => api.setMute.mutate({ deviceId: c.deviceId, muted }),
    { namespace: 'Alexa.Speaker' },
  )
}

async function power(c: AdapterDirectiveContext): Promise<unknown> {
  const on = c.header.name === 'TurnOn'
  const api = c.deps.mediaPlayerController.ctx.api.mediaPlayer
  return attempt(
    c,
    on ? 'turn on' : 'turn off',
    () =>
      on
        ? api.turnOn.mutate({ deviceId: c.deviceId })
        : api.turnOff.mutate({ deviceId: c.deviceId }),
    { namespace: 'Alexa.PowerController' },
  )
}

async function playback(c: AdapterDirectiveContext): Promise<unknown> {
  const api = c.deps.mediaPlayerController.ctx.api.mediaPlayer
  const input = { deviceId: c.deviceId }
  switch (c.header.name) {
    case 'Play':
      return attempt(c, 'play', () => api.play.mutate(input))
    case 'Pause':
      return attempt(c, 'pause', () => api.pause.mutate(input))
    case 'Stop':
      return attempt(c, 'stop', () => api.stop.mutate(input))
    case 'Next':
      return attempt(c, 'next', () => api.next.mutate(input))
    case 'Previous':
      return attempt(c, 'previous', () => api.previous.mutate(input))
    default:
      return errorEnvelope(c.header, 'INVALID_DIRECTIVE', `unsupported ${c.header.name}`)
  }
}

async function selectInput(c: AdapterDirectiveContext): Promise<unknown> {
  const payload = InputPayload.safeParse(c.payload)
  if (!payload.success) return errorEnvelope(c.header, 'INVALID_DIRECTIVE', 'input is required')
  const deps = c.deps.mediaPlayerController
  let source: string | undefined
  try {
    const slice = await deps.ctx.api.deviceState.getCapSlice.query({
      deviceId: c.deviceId,
      capName: CAP_MEDIA_PLAYER,
    })
    const status = readMediaPlayerSlice(slice)
    source =
      status === null
        ? undefined
        : inputPairs(status).find((i) => i.amazon === payload.data.input)?.source
  } catch (err: unknown) {
    deps.logger.warn('alexa media-player-controller: the sources could not be read', {
      tags: { deviceId: c.deviceId },
      meta: { error: message(err) },
    })
    return errorEnvelope(c.header, 'ENDPOINT_UNREACHABLE', 'the player sources could not be read')
  }
  if (source === undefined) {
    return errorEnvelope(c.header, 'INVALID_VALUE', `the player has no input ${payload.data.input}`)
  }
  const chosen = source
  return attempt(
    c,
    `select input ${chosen}`,
    () =>
      deps.ctx.api.mediaPlayer.selectSource.mutate({
        deviceId: c.deviceId,
        source: chosen,
      }),
    { namespace: 'Alexa.InputController' },
  )
}

/** The one handler behind every media-player directive. */
export async function handleMediaPlayerDirective(c: AdapterDirectiveContext): Promise<unknown> {
  switch (`${c.header.namespace}/${c.header.name}`) {
    case 'Alexa.PowerController/TurnOn':
    case 'Alexa.PowerController/TurnOff':
      return power(c)
    case 'Alexa.StepSpeaker/AdjustVolume':
      return volume(c)
    case 'Alexa.StepSpeaker/SetMute':
    case 'Alexa.Speaker/SetMute':
      return mute(c)
    case 'Alexa.ChannelController/SkipChannels':
      return channel(c)
    case 'Alexa.InputController/SelectInput':
      return selectInput(c)
    default:
      return c.header.namespace === 'Alexa.PlaybackController'
        ? playback(c)
        : errorEnvelope(c.header, 'INVALID_DIRECTIVE', `unsupported ${c.header.name}`)
  }
}
