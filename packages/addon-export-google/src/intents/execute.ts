/**
 * `action.devices.EXECUTE` — Google actuates a device.
 *
 * One result entry per (device, execution) pair. Google permits grouping ids
 * that share an outcome; not grouping keeps a partial failure attributable to
 * the device it happened on, which is what an operator asks for first.
 *
 * Every refusal path returns a documented Google error code AND logs the human
 * reason with `tags: { deviceId }`. A command Google reports as "sorry, that
 * didn't work" with nothing in the hub log is unanswerable.
 */
import type { IScopedLogger } from '@camstack/types'

import type { ActionSceneExports } from '../action-scenes.js'
import { parseActionSceneId } from '../action-scenes.js'
import type { DeviceGateway } from '../device-gateway.js'
import type {
  ExecuteCommandResult,
  ExecuteInput,
  ExecuteResponsePayload,
  GoogleErrorCode,
} from '../google-home/protocol.js'
import { statesAfterCall, traitForCommand } from '../google-home/trait-catalog.js'

export interface ExecuteDeps {
  readonly gateway: DeviceGateway
  readonly logger: IScopedLogger
  readonly isExposed: (deviceId: number) => boolean
  /** Exported actions, fired as scenes (D968). */
  readonly actions?: ActionSceneExports
}

interface ExecutionRequest {
  readonly rawId: string
  readonly command: string
  readonly params: Readonly<Record<string, unknown>>
}

export async function handleExecute(
  input: ExecuteInput,
  deps: ExecuteDeps,
  userId = '',
): Promise<ExecuteResponsePayload> {
  const requests: ExecutionRequest[] = []
  for (const group of input.payload.commands) {
    for (const device of group.devices) {
      for (const execution of group.execution) {
        requests.push({
          rawId: device.id,
          command: execution.command,
          params: execution.params ?? {},
        })
      }
    }
  }

  // Sequential on purpose. Two EXECUTEs against the same device (Google splits
  // "turn the lamp on and dim it" into two executions in one request) must
  // reach the provider in order; a lane pool would race them.
  const commands: ExecuteCommandResult[] = []
  for (const request of requests) {
    commands.push(
      parseActionSceneId(request.rawId) !== null
        ? await executeScene(request, deps, userId)
        : await executeOne(request, deps),
    )
  }
  return { commands }
}

function failure(rawId: string, errorCode: GoogleErrorCode): ExecuteCommandResult {
  return { ids: [rawId], status: 'ERROR', errorCode }
}

async function executeScene(
  request: ExecutionRequest,
  deps: ExecuteDeps,
  userId: string,
): Promise<ExecuteCommandResult> {
  if (deps.actions === undefined) {
    deps.logger.warn('google execute: refused — action scenes are not available', {
      meta: { requestedId: request.rawId, command: request.command },
    })
    return failure(request.rawId, 'deviceNotFound')
  }
  return deps.actions.executeScene(request.rawId, request.command, request.params, userId)
}

async function executeOne(
  request: ExecutionRequest,
  deps: ExecuteDeps,
): Promise<ExecuteCommandResult> {
  const deviceId = Number.parseInt(request.rawId, 10)
  if (!Number.isFinite(deviceId)) {
    deps.logger.warn('google execute: refused — device id is not numeric', {
      meta: { requestedId: request.rawId, command: request.command },
    })
    return failure(request.rawId, 'deviceNotFound')
  }
  if (!deps.isExposed(deviceId)) {
    deps.logger.warn('google execute: refused — device is not exposed to Google', {
      tags: { deviceId },
      meta: { command: request.command },
    })
    return failure(request.rawId, 'deviceNotFound')
  }

  const facts = await deps.gateway.loadFacts(deviceId).catch((err: unknown) => {
    deps.logger.warn('google execute: registry read failed', {
      tags: { deviceId },
      meta: {
        command: request.command,
        error: err instanceof Error ? err.message : String(err),
      },
    })
    return null
  })
  if (facts === null) return failure(request.rawId, 'deviceNotFound')

  const descriptor = traitForCommand(facts.capNames, request.command)
  if (descriptor === null) {
    deps.logger.warn('google execute: refused — no bound capability answers this command', {
      tags: { deviceId },
      meta: { command: request.command, capNames: facts.capNames },
    })
    return failure(request.rawId, 'functionNotSupported')
  }

  const resolution = descriptor.resolveCommand({
    deviceId,
    command: request.command,
    params: request.params,
    features: facts.features,
  })
  if (resolution.kind === 'refused') {
    deps.logger.warn('google execute: refused by trait', {
      tags: { deviceId },
      meta: {
        command: request.command,
        cap: descriptor.capName,
        reason: resolution.reason,
        errorCode: resolution.errorCode,
      },
    })
    return failure(request.rawId, resolution.errorCode)
  }

  try {
    await deps.gateway.dispatch(resolution.call)
  } catch (err: unknown) {
    deps.logger.warn('google execute: capability call failed', {
      tags: { deviceId },
      meta: {
        command: request.command,
        call: resolution.call.kind,
        error: err instanceof Error ? err.message : String(err),
      },
    })
    return failure(request.rawId, 'deviceOffline')
  }

  deps.logger.info('google execute: applied', {
    tags: { deviceId },
    meta: { command: request.command, call: resolution.call.kind },
  })
  return {
    ids: [request.rawId],
    status: 'SUCCESS',
    states: { online: true, ...statesAfterCall(resolution.call) },
  }
}
