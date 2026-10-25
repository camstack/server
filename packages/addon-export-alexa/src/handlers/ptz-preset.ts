/**
 * `Alexa.ModeController/SetMode` handler — dispatches three PTZ instances:
 *
 *   `ptz.preset` — preset-recall. Decodes the preset name from the mode
 *     value and calls `ptz.goToPreset({deviceId, presetId})`.
 *
 *   `ptz.pan`  — momentary pan. `ptz.pan.left|right` runs a `runPtzTravel`
 *     (ptz-travel.ts): ~1 s of the driver's self-terminating `ptz.move`
 *     pulses, no `continuousMove` / timer / `stop`. `ptz.pan.center` drives
 *     nothing — `move` already stops the head itself. The response is sent
 *     once the travel has finished (≈1 s, inside Alexa's 8 s deadline) and
 *     always reports `center`, so a subsequent pick re-triggers the move.
 *     A failed first pulse answers `INTERNAL_ERROR`; a later one is logged
 *     and the directive succeeds, because the head did move.
 *
 *   `ptz.tilt` — momentary tilt. Mirrors ptz.pan with up|down|center.
 */

import type { AddonApi, AddonContext, IScopedLogger } from '@camstack/types'
import { z } from 'zod'
import type { VerifiedDirectiveIdentity } from '../directive-router.js'
import { parseCameraEndpointId } from './endpoint-id.js'
import { errorEnvelope } from './error-envelope.js'
import { isAlexaRecallablePreset } from './ptz-preset-recallable.js'
import { runPtzTravel } from './ptz-travel.js'
import { type DirectiveHeader, EndpointRefSchema, SetModePayloadSchema } from './types.js'

const SetModeDirectiveSchema = z.object({
  header: z.object({
    namespace: z.literal('Alexa.ModeController'),
    name: z.literal('SetMode'),
    instance: z.string().optional(),
  }),
  endpoint: EndpointRefSchema,
  payload: SetModePayloadSchema,
})

const PTZ_PRESET_MODE_PREFIX = 'ptz.preset.'

const PTZ_PAN_MOVES: Readonly<Record<string, { pan?: number }>> = {
  'ptz.pan.left': { pan: -1 },
  'ptz.pan.right': { pan: 1 },
  'ptz.pan.center': {},
}
const PTZ_TILT_MOVES: Readonly<Record<string, { tilt?: number }>> = {
  'ptz.tilt.up': { tilt: 1 },
  'ptz.tilt.down': { tilt: -1 },
  'ptz.tilt.center': {},
}

export interface PtzPresetContext {
  readonly ctx: AddonContext
  readonly logger: IScopedLogger
}

export async function handleSetMode(
  header: DirectiveHeader & { instance?: string },
  endpointRaw: unknown,
  payloadRaw: unknown,
  deps: PtzPresetContext,
  _callerIdentity: VerifiedDirectiveIdentity,
): Promise<unknown> {
  const parsed = SetModeDirectiveSchema.safeParse({
    header: { namespace: header.namespace, name: header.name, instance: header.instance },
    endpoint: endpointRaw,
    payload: payloadRaw ?? {},
  })
  if (!parsed.success) {
    return errorEnvelope(
      header,
      'INVALID_DIRECTIVE',
      `payload validation failed: ${parsed.error.message}`,
    )
  }
  const instance = parsed.data.header.instance
  if (instance !== 'ptz.preset' && instance !== 'ptz.pan' && instance !== 'ptz.tilt') {
    return errorEnvelope(
      header,
      'INVALID_DIRECTIVE',
      `ModeController instance not supported: ${instance ?? '(missing)'}`,
    )
  }

  // Token is already verified by the centralized entry check in
  // handleDirective (http-server.ts). No per-handler re-verification needed.

  const endpointId = parsed.data.endpoint.endpointId
  const parsedId = parseCameraEndpointId(endpointId)
  if (parsedId.kind !== 'camera') {
    return errorEnvelope(
      header,
      'INVALID_DIRECTIVE',
      `ModeController only supported on camera endpoints — got ${endpointId}`,
    )
  }

  const mode = parsed.data.payload.mode
  const api: AddonApi = deps.ctx.api

  if (instance === 'ptz.pan' || instance === 'ptz.tilt') {
    const moves = instance === 'ptz.pan' ? PTZ_PAN_MOVES : PTZ_TILT_MOVES
    const move = moves[mode]
    if (!move) {
      return errorEnvelope(
        header,
        'INVALID_DIRECTIVE',
        `mode '${mode}' is not a valid ${instance} mode`,
      )
    }
    // `center` has no move: there is nothing to stop, `move` ends on its own.
    if (Object.keys(move).length > 0) {
      const deviceId = parsedId.deviceId
      try {
        const travel = await runPtzTravel(api.ptz, deviceId, move)
        if (travel.error) {
          deps.logger.warn('alexa ptz-mode: ptz.move failed mid-travel', {
            meta: {
              deviceId,
              instance,
              mode,
              issued: travel.issued,
              pulses: travel.pulses,
              error: travel.error.message,
            },
          })
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        deps.logger.warn('alexa ptz-mode: ptz.move failed', {
          meta: { deviceId, instance, mode, error: message },
        })
        return errorEnvelope(header, 'INTERNAL_ERROR', `ptz.move failed: ${message}`)
      }
    }
    // Echo the dropdown back to `center` so a subsequent pick of the
    // same direction re-fires the move (the Alexa UI would otherwise
    // think the dropdown is already at the target and suppress the
    // directive). Mirrors the ToggleController momentary pattern.
    const centerMode = instance === 'ptz.pan' ? 'ptz.pan.center' : 'ptz.tilt.center'
    return modeSuccessResponse(header, endpointId, instance, centerMode)
  }

  // ptz.preset
  if (!mode.startsWith(PTZ_PRESET_MODE_PREFIX)) {
    return errorEnvelope(header, 'INVALID_DIRECTIVE', `mode '${mode}' is not a ptz.preset mode`)
  }
  const presetName = mode.slice(PTZ_PRESET_MODE_PREFIX.length)
  if (presetName.length === 0) {
    return errorEnvelope(header, 'INVALID_DIRECTIVE', 'preset name missing after prefix')
  }

  const presets = await api.ptz.getPresets.query({ deviceId: parsedId.deviceId })
  // Only what discovery offered can be recalled: a firmware function sharing
  // the preset namespace (`Remote reboot`) is refused even when a directive
  // names it directly.
  const preset = presets.find((p) => p.name === presetName && isAlexaRecallablePreset(p))
  if (!preset) {
    return errorEnvelope(
      header,
      'INVALID_DIRECTIVE',
      `preset '${presetName}' is not a recallable preset on device ${parsedId.deviceId}`,
    )
  }

  await api.ptz.goToPreset.mutate({ deviceId: parsedId.deviceId, presetId: preset.id })

  return modeSuccessResponse(header, endpointId, 'ptz.preset', mode)
}

function modeSuccessResponse(
  header: DirectiveHeader & { instance?: string },
  endpointId: string,
  instance: string,
  mode: string,
): unknown {
  return {
    event: {
      header: {
        namespace: 'Alexa',
        name: 'Response',
        messageId: header.messageId,
        correlationToken: header.correlationToken,
        payloadVersion: '3',
      },
      endpoint: { endpointId },
      payload: {},
    },
    context: {
      properties: [
        {
          namespace: 'Alexa.ModeController',
          instance,
          name: 'mode',
          value: mode,
          timeOfSample: new Date().toISOString(),
          uncertaintyInMilliseconds: 500,
        },
      ],
    },
  }
}
