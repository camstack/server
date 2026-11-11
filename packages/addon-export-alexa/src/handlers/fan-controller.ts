/**
 * The directives of a fan exported as its own device (D869), through the
 * `fan-control` cap:
 *
 *   `Alexa.RangeController` SetRangeValue / AdjustRangeValue on `Fan.Speed`;
 *   `Alexa.ToggleController` TurnOn / TurnOff on `Fan.Oscillating`;
 *   `Alexa.ModeController` SetMode on `Fan.Preset` — a NATIVE preset goes to
 *   `fan-control.setPreset`, a CUSTOM one (the operator's `fan-presets`) to
 *   `fan-presets.applyPreset`, which applies its fan-control fields and reports each.
 *
 * The commands are quick, so the answer is synchronous: the Response carries
 * the state the command set, projected from the slice read before it. A custom
 * preset that did not fully apply is an ErrorResponse naming the step.
 */
import type { IScopedLogger } from '@camstack/types'
import type { AddonContext } from '@camstack/types'
import { z } from 'zod'
import {
  fanProperties,
  INSTANCE_OSCILLATING,
  INSTANCE_PRESET,
  INSTANCE_SPEED,
  presetModesOf,
  readFanSlice,
  type FanSlice,
} from '../endpoints/adapters/fan-model.js'
import type { AdapterDirectiveContext, GenericProperty } from '../endpoints/adapters/types.js'
import { errorEnvelope } from './error-envelope.js'

export interface FanControllerContext {
  readonly ctx: AddonContext
  readonly logger: IScopedLogger
}

const CAP_FAN = 'fan-control'
const UNCERTAINTY_MS = 500
/** What AdjustRangeValue moves by when the device states no step of its own. */
const DEFAULT_ADJUST = 10

const SetRangePayload = z.object({ rangeValue: z.number() })
const AdjustRangePayload = z.object({
  rangeValueDelta: z.number(),
  rangeValueDeltaDefault: z.boolean().optional(),
})
const SetModePayload = z.object({ mode: z.string() })

function clamp(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)))
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

async function readSlice(
  c: AdapterDirectiveContext,
  deps: FanControllerContext,
): Promise<FanSlice | null> {
  try {
    return readFanSlice(
      await deps.ctx.api.deviceState.getCapSlice.query({
        deviceId: c.deviceId,
        capName: CAP_FAN,
      }),
    )
  } catch (err: unknown) {
    deps.logger.warn('alexa fan-controller: the fan state could not be read', {
      tags: { deviceId: c.deviceId },
      meta: { error: message(err) },
    })
    return null
  }
}

function successResponse(
  c: AdapterDirectiveContext,
  properties: readonly GenericProperty[],
): unknown {
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

function unreachable(c: AdapterDirectiveContext, text: string): unknown {
  return errorEnvelope(c.header, 'ENDPOINT_UNREACHABLE', text)
}

async function setSpeed(
  c: AdapterDirectiveContext,
  deps: FanControllerContext,
  slice: FanSlice,
  speed: number,
): Promise<unknown> {
  try {
    await deps.ctx.api.fanControl.setPercentage.mutate({
      deviceId: c.deviceId,
      speed,
    })
  } catch (err: unknown) {
    deps.logger.warn('alexa fan-controller: setPercentage failed', {
      tags: { deviceId: c.deviceId },
      meta: { speed, error: message(err) },
    })
    return unreachable(c, 'the fan did not accept the speed')
  }
  deps.logger.info('alexa fan-controller: speed set', {
    tags: { deviceId: c.deviceId },
    meta: { speed },
  })
  return successResponse(
    c,
    fanProperties({ ...slice, speed }).filter((p) => p.instance === INSTANCE_SPEED),
  )
}

async function handleRange(
  c: AdapterDirectiveContext,
  deps: FanControllerContext,
): Promise<unknown> {
  const slice = await readSlice(c, deps)
  if (slice === null) return unreachable(c, 'the fan state could not be read')
  if (c.header.name === 'SetRangeValue') {
    const payload = SetRangePayload.safeParse(c.payload)
    if (!payload.success)
      return errorEnvelope(c.header, 'INVALID_DIRECTIVE', 'rangeValue is required')
    if (payload.data.rangeValue < 0 || payload.data.rangeValue > 100) {
      return errorEnvelope(c.header, 'VALUE_OUT_OF_RANGE', 'rangeValue must be 0-100')
    }
    return setSpeed(c, deps, slice, clamp(payload.data.rangeValue))
  }
  const payload = AdjustRangePayload.safeParse(c.payload)
  if (!payload.success)
    return errorEnvelope(c.header, 'INVALID_DIRECTIVE', 'rangeValueDelta is required')
  if (slice.speed === null) return unreachable(c, 'the fan reports no current speed to adjust')
  const delta =
    payload.data.rangeValueDeltaDefault === true
      ? (slice.percentageStep ?? DEFAULT_ADJUST)
      : payload.data.rangeValueDelta
  return setSpeed(c, deps, slice, clamp(slice.speed + delta))
}

async function handleToggle(
  c: AdapterDirectiveContext,
  deps: FanControllerContext,
): Promise<unknown> {
  const slice = await readSlice(c, deps)
  if (slice === null) return unreachable(c, 'the fan state could not be read')
  const oscillating = c.header.name === 'TurnOn'
  try {
    await deps.ctx.api.fanControl.setOscillating.mutate({
      deviceId: c.deviceId,
      oscillating,
    })
  } catch (err: unknown) {
    deps.logger.warn('alexa fan-controller: setOscillating failed', {
      tags: { deviceId: c.deviceId },
      meta: { oscillating, error: message(err) },
    })
    return unreachable(c, 'the fan did not accept the command')
  }
  deps.logger.info('alexa fan-controller: oscillation set', {
    tags: { deviceId: c.deviceId },
    meta: { oscillating },
  })
  return successResponse(
    c,
    fanProperties({ ...slice, oscillating }).filter((p) => p.instance === INSTANCE_OSCILLATING),
  )
}

async function customNames(
  c: AdapterDirectiveContext,
  deps: FanControllerContext,
): Promise<readonly string[]> {
  try {
    const presets = await deps.ctx.api.fanPresets.getPresets.query({
      deviceId: c.deviceId,
    })
    return presets.map((p) => p.name)
  } catch (err: unknown) {
    deps.logger.warn('alexa fan-controller: the custom presets could not be read', {
      tags: { deviceId: c.deviceId },
      meta: { error: message(err) },
    })
    return []
  }
}

async function handleMode(
  c: AdapterDirectiveContext,
  deps: FanControllerContext,
): Promise<unknown> {
  const payload = SetModePayload.safeParse(c.payload)
  if (!payload.success) return errorEnvelope(c.header, 'INVALID_DIRECTIVE', 'mode is required')
  const slice = await readSlice(c, deps)
  if (slice === null) return unreachable(c, 'the fan state could not be read')
  const modes = presetModesOf(slice.availablePresets, await customNames(c, deps))
  const mode = modes.find((m) => m.value === payload.data.mode)
  if (mode === undefined) {
    return errorEnvelope(c.header, 'INVALID_VALUE', `unknown mode ${payload.data.mode}`)
  }
  if (mode.source === 'native') {
    try {
      await deps.ctx.api.fanControl.setPreset.mutate({
        deviceId: c.deviceId,
        preset: mode.name,
      })
    } catch (err: unknown) {
      deps.logger.warn('alexa fan-controller: setPreset failed', {
        tags: { deviceId: c.deviceId },
        meta: { preset: mode.name, error: message(err) },
      })
      return unreachable(c, 'the fan did not accept the preset')
    }
    deps.logger.info('alexa fan-controller: native preset set', {
      tags: { deviceId: c.deviceId },
      meta: { preset: mode.name },
    })
    return successResponse(c, [
      {
        namespace: 'Alexa.ModeController',
        name: 'mode',
        instance: INSTANCE_PRESET,
        value: mode.value,
      },
    ])
  }
  return applyCustom(c, deps, mode.name)
}

async function applyCustom(
  c: AdapterDirectiveContext,
  deps: FanControllerContext,
  name: string,
): Promise<unknown> {
  try {
    const presets = await deps.ctx.api.fanPresets.getPresets.query({
      deviceId: c.deviceId,
    })
    const preset = presets.find((p) => p.name === name)
    if (preset === undefined) return errorEnvelope(c.header, 'INVALID_VALUE', `no preset ${name}`)
    const result = await deps.ctx.api.fanPresets.applyPreset.mutate({
      deviceId: c.deviceId,
      presetId: preset.id,
    })
    if (result.status === 'applied') {
      deps.logger.info('alexa fan-controller: custom preset applied', {
        tags: { deviceId: c.deviceId },
        meta: { preset: preset.name, fields: result.fields.length },
      })
      return successResponse(c, [])
    }
    const bad = result.fields.find((f) => f.outcome === 'failed' || f.outcome === 'refused')
    const detail =
      bad === undefined ? result.status : `${bad.field}: ${bad.message ?? bad.outcome}`
    deps.logger.warn('alexa fan-controller: custom preset did not fully apply', {
      tags: { deviceId: c.deviceId },
      meta: { preset: preset.name, status: result.status, detail },
    })
    return unreachable(c, `the preset ${result.status}: ${detail}`)
  } catch (err: unknown) {
    deps.logger.warn('alexa fan-controller: applying the custom preset failed', {
      tags: { deviceId: c.deviceId },
      meta: { preset: name, error: message(err) },
    })
    return unreachable(c, 'the preset could not be applied')
  }
}

/** The one handler behind every fan directive. */
export async function handleFanDirective(c: AdapterDirectiveContext): Promise<unknown> {
  const deps = c.deps.fanController
  switch (c.header.namespace) {
    case 'Alexa.RangeController':
      return handleRange(c, deps)
    case 'Alexa.ToggleController':
      return handleToggle(c, deps)
    case 'Alexa.ModeController':
      return handleMode(c, deps)
    default:
      return errorEnvelope(
        c.header,
        'INVALID_DIRECTIVE',
        `${c.header.namespace} is not a fan directive`,
      )
  }
}
