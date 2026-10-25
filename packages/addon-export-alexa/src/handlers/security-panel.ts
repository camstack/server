/**
 * `Alexa.SecurityPanelController/{Arm,Disarm}` handlers.
 *
 * Routing: the endpoint id is `${deviceId}__alarm` — a standalone device with
 * a routing tag, not a child (see `endpoint-id.ts`). Anything else is refused.
 *
 * The state vocabulary and both directions of the mode translation live in
 * `security-panel-arm-state.ts`, pure and tested on its own. What is decided
 * HERE is everything about a command that can fail, and the shape of saying so.
 *
 * ## The panel is asked what it accepts, first
 *
 * Every directive reads `alarmPanel.getStatus` before it commands anything:
 * `availableModes` decides which panel mode an Alexa arm state becomes, and
 * `requiresCode` decides whether the command may be attempted at all. A status
 * read that FAILS is unknown, never "no modes and no PIN" — the command goes
 * through optimistically with the primary mode and the panel is left to be the
 * one that refuses, and the fact that we were flying blind is logged against
 * the device id.
 *
 * ## `requiresCode`
 *
 * Alexa's **Disarm** directive can carry a PIN (`payload.authorization`, type
 * `FOUR_DIGIT_PIN`); it is passed straight through as the cap's `code` and is
 * never logged. Alexa's **Arm** directive carries no authorization field at
 * all — there is nowhere for a PIN to come from — so arming a panel that
 * requires one is REFUSED with `AUTHORIZATION_REQUIRED` and a WARN naming the
 * device, rather than attempted code-less. A code-less attempt would be a
 * guaranteed refusal that reads in the log exactly like a broken panel, and
 * repeated bad attempts are what locks a real alarm out.
 *
 * ## What the response reports
 *
 * The panel is re-read after the command and the response carries what it
 * SAYS, not what was asked for. A panel in its exit delay reports `arming`,
 * which is `DISARMED` — the system is not set, and telling the customer it is
 * while they are still inside is the one lie this mapping exists to refuse. An
 * INFO names the exit delay so the operator knows why Alexa shows the panel
 * off for its duration.
 *
 * `exitDelayInSeconds` — the field Alexa provides for exactly this — is NOT
 * sent: `alarm-panel` exposes no delay length, and a number we invented would
 * be worse than the omission. A panel cap that grows one should fill it here.
 */

import type { AddonApi, AddonContext, IScopedLogger } from '@camstack/types'
import { AlarmPanelStatusSchema } from '@camstack/types'
import { z } from 'zod'

import type { VerifiedDirectiveIdentity } from '../directive-router.js'
import { parseCameraEndpointId } from './endpoint-id.js'
import { errorEnvelope } from './error-envelope.js'
import {
  type AlexaArmState,
  alarmArmModeForAlexa,
  alexaArmStateFor,
  burglaryAlarmFor,
} from './security-panel-arm-state.js'
import { type DirectiveHeader, EndpointRefSchema } from './types.js'

export interface SecurityPanelContext {
  readonly ctx: AddonContext
  readonly logger: IScopedLogger
}

const ArmPayloadSchema = z.object({
  armState: z.enum(['ARMED_STAY', 'ARMED_AWAY', 'ARMED_NIGHT']),
})

const DisarmPayloadSchema = z.object({
  authorization: z
    .object({
      type: z.literal('FOUR_DIGIT_PIN'),
      value: z.string().min(1),
    })
    .optional(),
})

/** The subset of the panel status the directives read. */
const PanelReadSchema = AlarmPanelStatusSchema.pick({
  state: true,
  targetMode: true,
  availableModes: true,
  requiresCode: true,
})

type PanelFacts = z.infer<typeof PanelReadSchema>

/**
 * `Alexa.SecurityPanelController.ErrorResponse`.
 *
 * A namespace of its own, because the four types that matter here
 * (`AUTHORIZATION_REQUIRED`, `UNAUTHORIZED`, `NOT_READY_FOR_ARM`,
 * `BYPASS_NEEDED`) are only understood under it — the generic `Alexa`
 * `ErrorResponse` from `error-envelope.ts` carries none of them, and a PIN
 * problem reported there is a message the Alexa app cannot act on.
 */
function securityPanelError(header: DirectiveHeader, type: string, message: string): unknown {
  return {
    event: {
      header: {
        namespace: 'Alexa.SecurityPanelController',
        name: 'ErrorResponse',
        messageId: header.messageId,
        correlationToken: header.correlationToken,
        payloadVersion: '3',
      },
      payload: { type, message },
    },
  }
}

/** Resolve the alarm panel this directive targets, or the refusal to send. */
function resolveDeviceId(endpointRaw: unknown): { deviceId: number } | { reason: string } {
  const parsedEndpoint = EndpointRefSchema.safeParse(endpointRaw)
  if (!parsedEndpoint.success) return { reason: 'missing or malformed endpoint' }
  const parsedId = parseCameraEndpointId(parsedEndpoint.data.endpointId)
  if (parsedId.kind === 'alarm-panel') return { deviceId: parsedId.deviceId }
  return {
    reason: `SecurityPanelController is only exposed on alarm-panel endpoints — got '${parsedEndpoint.data.endpointId}'`,
  }
}

/**
 * What the panel currently accepts, or `null` when it could not be read.
 *
 * `null` is the honest answer and the callers treat it as unknown; nothing
 * here substitutes a default that would read as "accepts nothing, needs no
 * PIN".
 */
async function readPanel(
  api: AddonApi,
  deviceId: number,
  logger: IScopedLogger,
  phase: string,
): Promise<PanelFacts | null> {
  const raw = await api.alarmPanel.getStatus.query({ deviceId }).catch((err: unknown) => {
    logger.warn('alexa security-panel: alarmPanel.getStatus failed — proceeding without it', {
      tags: { deviceId },
      meta: { phase, error: err instanceof Error ? err.message : String(err) },
    })
    return null
  })
  const parsed = PanelReadSchema.safeParse(raw)
  if (!parsed.success) {
    if (raw !== null) {
      logger.warn('alexa security-panel: panel status did not match the cap schema', {
        tags: { deviceId },
        meta: { phase },
      })
    }
    return null
  }
  return parsed.data
}

/** The `context.properties` block for a panel whose state we re-read. */
function panelProperties(facts: PanelFacts | null, fallback: AlexaArmState): unknown[] {
  const timeOfSample = new Date().toISOString()
  const parsedState = facts === null ? null : AlarmPanelStatusSchema.shape.state.parse(facts.state)
  const armState =
    parsedState === null ? fallback : alexaArmStateFor(parsedState, facts?.targetMode ?? null)
  const burglary = parsedState === null ? { value: 'OK' } : burglaryAlarmFor(parsedState)
  return [
    {
      namespace: 'Alexa.SecurityPanelController',
      name: 'armState',
      value: armState,
      timeOfSample,
      uncertaintyInMilliseconds: 0,
    },
    {
      namespace: 'Alexa.SecurityPanelController',
      name: 'burglaryAlarm',
      value: burglary,
      timeOfSample,
      uncertaintyInMilliseconds: 0,
    },
  ]
}

// ── Arm ─────────────────────────────────────────────────────────────

export async function handleArm(
  header: DirectiveHeader,
  endpointRaw: unknown,
  payloadRaw: unknown,
  deps: SecurityPanelContext,
  _callerIdentity: VerifiedDirectiveIdentity,
): Promise<unknown> {
  const target = resolveDeviceId(endpointRaw)
  if (!('deviceId' in target)) {
    return errorEnvelope(header, 'INVALID_DIRECTIVE', target.reason)
  }
  const { deviceId } = target

  const payload = ArmPayloadSchema.safeParse(payloadRaw)
  if (!payload.success) {
    deps.logger.warn('alexa security-panel: Arm payload is not an arm state Alexa defines', {
      tags: { deviceId },
      meta: { error: payload.error.message },
    })
    return errorEnvelope(
      header,
      'INVALID_DIRECTIVE',
      `Arm payload unexpected: ${payload.error.message}`,
    )
  }
  const requested = payload.data.armState

  const api: AddonApi = deps.ctx.api
  const facts = await readPanel(api, deviceId, deps.logger, 'arm')

  if (facts?.requiresCode === true) {
    deps.logger.warn(
      'alexa security-panel: panel requires a PIN and the Arm directive carries none — REFUSED',
      { tags: { deviceId }, meta: { requested } },
    )
    return securityPanelError(
      header,
      'AUTHORIZATION_REQUIRED',
      'this panel requires a PIN to arm, and Alexa cannot supply one on an Arm directive',
    )
  }

  const mode = alarmArmModeForAlexa(requested, facts?.availableModes ?? [])
  if (mode === null) {
    deps.logger.warn('alexa security-panel: panel accepts no mode for this arm state — REFUSED', {
      tags: { deviceId },
      meta: { requested, availableModes: facts?.availableModes ?? null },
    })
    return securityPanelError(header, 'NOT_READY_FOR_ARM', `panel does not accept ${requested}`)
  }

  try {
    await api.alarmPanel.arm.mutate({ deviceId, mode })
  } catch (err: unknown) {
    deps.logger.warn('alexa security-panel: arm command failed', {
      tags: { deviceId },
      meta: { requested, mode, error: err instanceof Error ? err.message : String(err) },
    })
    return securityPanelError(
      header,
      'NOT_READY_FOR_ARM',
      err instanceof Error ? err.message : String(err),
    )
  }

  deps.logger.info('alexa security-panel: armed', {
    tags: { deviceId },
    meta: { requested, mode },
  })

  const after = await readPanel(api, deviceId, deps.logger, 'arm-confirm')
  if (after?.state === 'arming') {
    deps.logger.info(
      'alexa security-panel: panel is in its exit delay — reporting DISARMED until it is set',
      { tags: { deviceId }, meta: { requested, mode } },
    )
  }

  return {
    event: {
      header: {
        namespace: 'Alexa.SecurityPanelController',
        name: 'Arm.Response',
        messageId: header.messageId,
        correlationToken: header.correlationToken,
        payloadVersion: '3',
      },
      endpoint: { endpointId: `${deviceId}__alarm` },
      // No `exitDelayInSeconds`: the cap does not expose one. See the docblock.
      payload: {},
    },
    context: { properties: panelProperties(after, requested) },
  }
}

// ── Disarm ──────────────────────────────────────────────────────────

export async function handleDisarm(
  header: DirectiveHeader,
  endpointRaw: unknown,
  payloadRaw: unknown,
  deps: SecurityPanelContext,
  _callerIdentity: VerifiedDirectiveIdentity,
): Promise<unknown> {
  const target = resolveDeviceId(endpointRaw)
  if (!('deviceId' in target)) {
    return errorEnvelope(header, 'INVALID_DIRECTIVE', target.reason)
  }
  const { deviceId } = target

  const payload = DisarmPayloadSchema.safeParse(payloadRaw ?? {})
  if (!payload.success) {
    return errorEnvelope(
      header,
      'INVALID_DIRECTIVE',
      `Disarm payload unexpected: ${payload.error.message}`,
    )
  }
  const code = payload.data.authorization?.value

  const api: AddonApi = deps.ctx.api
  const facts = await readPanel(api, deviceId, deps.logger, 'disarm')

  if (facts?.requiresCode === true && code === undefined) {
    deps.logger.warn(
      'alexa security-panel: panel requires a PIN and the Disarm directive carried none — REFUSED',
      { tags: { deviceId } },
    )
    return securityPanelError(
      header,
      'AUTHORIZATION_REQUIRED',
      'this panel requires a PIN to disarm',
    )
  }

  try {
    // The PIN travels as the cap's `code` and is never persisted or logged —
    // the cap's own contract says so, and this is the only place it passes
    // through this addon.
    await api.alarmPanel.disarm.mutate(code === undefined ? { deviceId } : { deviceId, code })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    deps.logger.warn('alexa security-panel: disarm command failed', {
      tags: { deviceId },
      // `codeSupplied`, never the code.
      meta: { codeSupplied: code !== undefined, error: message },
    })
    // A refusal of a disarm that CARRIED a PIN is, far more often than not, a
    // wrong PIN, and `UNAUTHORIZED` is what makes the Alexa app ask again.
    // Reporting it when no PIN was involved would blame the operator for
    // something else entirely.
    return code === undefined
      ? errorEnvelope(header, 'INTERNAL_ERROR', message)
      : securityPanelError(header, 'UNAUTHORIZED', message)
  }

  deps.logger.info('alexa security-panel: disarmed', {
    tags: { deviceId },
    meta: { codeSupplied: code !== undefined },
  })

  const after = await readPanel(api, deviceId, deps.logger, 'disarm-confirm')
  return {
    event: {
      header: {
        namespace: 'Alexa',
        name: 'Response',
        messageId: header.messageId,
        correlationToken: header.correlationToken,
        payloadVersion: '3',
      },
      endpoint: { endpointId: `${deviceId}__alarm` },
      payload: {},
    },
    context: { properties: panelProperties(after, 'DISARMED') },
  }
}
