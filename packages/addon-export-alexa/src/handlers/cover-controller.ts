/**
 * `Alexa.RangeController` (SetRangeValue / AdjustRangeValue) and
 * `Alexa.ModeController` (SetMode) on a cover exported as its own device
 * (D869), through the `cover` cap.
 *
 * A cover moves slowly, so each directive runs through `runWithDeferral`:
 * answered at once when the cover is already there, otherwise
 * `DeferredResponse` now and the real `Response` when the cover reports the
 * target (or an `ErrorResponse` at the timeout).
 */
import type { IScopedLogger } from '@camstack/types'
import type { AddonApi, AddonContext } from '@camstack/types'
import { z } from 'zod'
import {
  ADJUST_STEP,
  ARRIVAL_TOLERANCE,
  coverProperties,
  INSTANCE_POSITION,
  INSTANCE_STATE,
  INSTANCE_TILT,
  MODE_CLOSED,
  MODE_OPEN,
  readCoverSlice,
} from '../endpoints/adapters/cover-model.js'
import type { AdapterDirectiveContext } from '../endpoints/adapters/types.js'
import {
  type AsyncResponseInput,
  type DeferralDeps,
  type DeferralPlan,
  type DeferralReading,
  type ResponseProperty,
  runWithDeferral,
} from './deferred-response.js'
import { errorEnvelope } from './error-envelope.js'
import type { DirectiveHeader } from './types.js'

export interface CoverControllerContext {
  readonly ctx: AddonContext
  readonly logger: IScopedLogger
  /** Sends the asynchronous Response of a deferred directive (event gateway). */
  readonly sendAsyncResponse: (input: AsyncResponseInput) => Promise<boolean>
  /** Test seams for the deferral clock. */
  readonly sleep?: (ms: number) => Promise<void>
  readonly now?: () => number
  /** Settled background tasks, for a spec to await. */
  readonly onSettled?: (settled: Promise<void>) => void
}

const SetRangePayload = z.object({ rangeValue: z.number() })
const AdjustRangePayload = z.object({
  rangeValueDelta: z.number(),
  rangeValueDeltaDefault: z.boolean().optional(),
})
const SetModePayload = z.object({ mode: z.string() })

type Position = 'position' | 'tilt'

type Target =
  | { readonly kind: 'range'; readonly axis: Position; readonly value: number }
  | { readonly kind: 'mode'; readonly mode: typeof MODE_OPEN | typeof MODE_CLOSED }

function clamp(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)))
}

function axisOfInstance(instance: string | undefined): Position | null {
  if (instance === INSTANCE_POSITION) return 'position'
  if (instance === INSTANCE_TILT) return 'tilt'
  return null
}

async function readSlice(api: AddonApi, deviceId: number): Promise<unknown> {
  return api.deviceState.getCapSlice.query({ deviceId, capName: 'cover' })
}

/** The properties for ONE instance, plus whether they show `target` reached. */
function readingFor(slice: unknown, instance: string, target: Target): DeferralReading | null {
  const parsed = readCoverSlice(slice)
  if (parsed === null) return null
  const all: readonly ResponseProperty[] = coverProperties(slice)
  const properties = all.filter((p) => p.instance === instance)
  if (properties.length === 0) return null
  if (target.kind === 'mode') {
    const reached = target.mode === MODE_OPEN ? parsed.state === 'open' : parsed.state === 'closed'
    return { properties, reached }
  }
  const current = target.axis === 'position' ? parsed.position : parsed.tiltPosition
  return {
    properties,
    reached: current !== null && Math.abs(current - target.value) <= ARRIVAL_TOLERANCE,
  }
}

function outOfRange(header: DirectiveHeader): unknown {
  const envelope = errorEnvelope(header, 'VALUE_OUT_OF_RANGE', 'rangeValue must be 0-100')
  return {
    event: {
      ...envelope.event,
      payload: {
        ...envelope.event.payload,
        validRange: { minimumValue: 0, maximumValue: 100 },
      },
    },
  }
}

async function command(api: AddonApi, deviceId: number, target: Target): Promise<void> {
  if (target.kind === 'mode') {
    if (target.mode === MODE_OPEN) await api.cover.open.mutate({ deviceId })
    else await api.cover.close.mutate({ deviceId })
    return
  }
  if (target.axis === 'position') {
    await api.cover.setPosition.mutate({ deviceId, position: target.value })
  } else {
    await api.cover.setTiltPosition.mutate({ deviceId, tiltPosition: target.value })
  }
}

/** Resolve the target the directive asks for; an answer envelope on refusal. */
async function resolveTarget(
  c: AdapterDirectiveContext,
  api: AddonApi,
  deps: CoverControllerContext,
): Promise<{ readonly target: Target; readonly instance: string } | { readonly refusal: unknown }> {
  const { header } = c
  const key = `${header.namespace}/${header.name}`
  const instance = header.instance
  if (key === 'Alexa.ModeController/SetMode') {
    const payload = SetModePayload.safeParse(c.payload)
    if (instance !== INSTANCE_STATE || !payload.success) {
      return {
        refusal: errorEnvelope(header, 'INVALID_DIRECTIVE', 'unsupported mode instance or payload'),
      }
    }
    if (payload.data.mode !== MODE_OPEN && payload.data.mode !== MODE_CLOSED) {
      return {
        refusal: errorEnvelope(header, 'INVALID_VALUE', `unknown mode ${payload.data.mode}`),
      }
    }
    return { target: { kind: 'mode', mode: payload.data.mode }, instance: INSTANCE_STATE }
  }
  const axis = axisOfInstance(instance)
  if (axis === null || instance === undefined) {
    return {
      refusal: errorEnvelope(header, 'INVALID_DIRECTIVE', `unknown range instance ${instance}`),
    }
  }
  if (key === 'Alexa.RangeController/SetRangeValue') {
    const payload = SetRangePayload.safeParse(c.payload)
    if (!payload.success) {
      return { refusal: errorEnvelope(header, 'INVALID_DIRECTIVE', payload.error.message) }
    }
    if (payload.data.rangeValue < 0 || payload.data.rangeValue > 100) {
      return { refusal: outOfRange(header) }
    }
    return { target: { kind: 'range', axis, value: clamp(payload.data.rangeValue) }, instance }
  }
  const payload = AdjustRangePayload.safeParse(c.payload)
  if (!payload.success) {
    return { refusal: errorEnvelope(header, 'INVALID_DIRECTIVE', payload.error.message) }
  }
  const slice = await readSlice(api, c.deviceId).catch((err: unknown) => {
    deps.logger.warn('alexa cover-controller: AdjustRangeValue could not read the cover', {
      tags: { deviceId: c.deviceId },
      meta: { error: err instanceof Error ? err.message : String(err) },
    })
    return null
  })
  const parsed = readCoverSlice(slice)
  const current =
    parsed === null ? null : axis === 'position' ? parsed.position : parsed.tiltPosition
  if (current === null) {
    return {
      refusal: errorEnvelope(
        header,
        'ENDPOINT_UNREACHABLE',
        'the cover position is unknown, so it cannot be adjusted',
      ),
    }
  }
  const delta = payload.data.rangeValueDeltaDefault
    ? Math.sign(payload.data.rangeValueDelta) * ADJUST_STEP
    : payload.data.rangeValueDelta
  return { target: { kind: 'range', axis, value: clamp(current + delta) }, instance }
}

/** The one handler behind SetRangeValue, AdjustRangeValue and SetMode. */
export async function handleCoverDirective(c: AdapterDirectiveContext): Promise<unknown> {
  const deps = c.deps.coverController
  const api = deps.ctx.api
  const resolved = await resolveTarget(c, api, deps)
  if ('refusal' in resolved) return resolved.refusal
  const { target, instance } = resolved
  const plan: DeferralPlan = {
    header: c.header,
    endpointId: c.endpoint.endpointId,
    userId: c.identity.userId,
    deviceId: c.deviceId,
    command: () => command(api, c.deviceId, target),
    read: async () => readingFor(await readSlice(api, c.deviceId), instance, target),
    commandErrorType: 'ENDPOINT_UNREACHABLE',
  }
  const deferralDeps: DeferralDeps = {
    sendAsyncResponse: deps.sendAsyncResponse,
    logger: deps.logger,
    ...(deps.sleep !== undefined ? { sleep: deps.sleep } : {}),
    ...(deps.now !== undefined ? { now: deps.now } : {}),
  }
  const { body, settled } = await runWithDeferral(plan, deferralDeps)
  if (settled !== null) deps.onSettled?.(settled)
  deps.logger.info(`alexa cover-controller: ${c.header.name}`, {
    tags: { deviceId: c.deviceId },
    meta: { instance, target },
  })
  return body
}
