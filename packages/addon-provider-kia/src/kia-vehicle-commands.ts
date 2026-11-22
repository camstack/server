import {
  type climateControlCapability,
  type InferNativeProvider,
  type IScopedLogger,
  type lockControlCapability,
  errMsg,
} from '@camstack/types'
import { KiaBridgeError, type KiaCommand } from './kia-bridge.js'
import type { KiaVehicleHandle } from './kia-device-handle.js'
import { KIA_CLIMATE_MAX_C, KIA_CLIMATE_MIN_C, KIA_CLIMATE_STEP_C } from './kia-domain-mapping.js'
import { KiaBudgetExhaustedError } from './kia-integration-manager.js'

/**
 * The commands a car's accessories send (D1061): each one goes to the cloud and returns. The
 * commanded value is NEVER written to a slice here; the readback the manager folds into the
 * handle is what the accessory reports, so a command the car did not carry out never reads as
 * done. A command costs quota, so a refusal says which limit it hit.
 */

/** Default cabin pre-conditioning target when nothing else is known, degrees Celsius. */
export const KIA_DEFAULT_CLIMATE_C = 21
/** How long the car runs its climate for, minutes. */
export const KIA_CLIMATE_DURATION_MIN = 10

export interface KiaCommandDeps {
  readonly deviceId: number
  readonly logger: IScopedLogger
  readonly resolveHandle: () => KiaVehicleHandle | null
}

/** Send one command; every failure becomes an Error that names its cause. */
async function send(deps: KiaCommandDeps, command: KiaCommand): Promise<void> {
  const tags = { deviceId: deps.deviceId }
  const handle = deps.resolveHandle()
  if (handle === null) {
    deps.logger.warn('Kia command refused: no cloud connection', {
      tags,
      meta: { command: command.command },
    })
    throw new Error('Kia: the cloud connection is not available')
  }
  try {
    const result = await handle.command(command)
    deps.logger.info('Kia command sent', {
      tags,
      meta: { command: command.command, outcome: result.outcome },
    })
  } catch (err: unknown) {
    if (err instanceof KiaBudgetExhaustedError) {
      deps.logger.warn('Kia command refused: the daily allowance is spent', {
        tags,
        meta: { command: command.command, retryAt: err.retryAt },
      })
      throw new Error(
        `Kia: the daily allowance of cloud calls is spent; try again after ${new Date(err.retryAt).toISOString()}`,
      )
    }
    const code = err instanceof KiaBridgeError ? err.code : 'failed'
    deps.logger.warn('Kia command failed', {
      tags,
      meta: { command: command.command, code, error: errMsg(err) },
    })
    if (err instanceof KiaBridgeError && err.code === 'vehicle-unreachable') {
      throw new Error(`Kia: the vehicle is unreachable (${err.message})`)
    }
    throw new Error(`Kia: the ${command.command} command failed (${code}): ${errMsg(err)}`)
  }
}

/** The command half of a cap provider: the device adds `getStatus` from its own slice. */
export type KiaLockCommands = Omit<InferNativeProvider<typeof lockControlCapability>, 'getStatus'>
export type KiaClimateCommands = Omit<
  InferNativeProvider<typeof climateControlCapability>,
  'getStatus'
>

export function createKiaLockProvider(deps: KiaCommandDeps): KiaLockCommands {
  // The PIN lives in the worker (a password field of the account); a code argument is ignored.
  return {
    lock: async () => send(deps, { command: 'lock' }),
    unlock: async () => send(deps, { command: 'unlock' }),
  }
}

function inRange(target: number): boolean {
  if (target < KIA_CLIMATE_MIN_C || target > KIA_CLIMATE_MAX_C) return false
  return Math.abs(target / KIA_CLIMATE_STEP_C - Math.round(target / KIA_CLIMATE_STEP_C)) < 1e-9
}

export function createKiaClimateProvider(deps: KiaCommandDeps): KiaClimateCommands {
  // The target to use the next time the climate starts: the operator's, then the cloud's.
  let preferredC: number | null = null

  const start = (temperature: number): Promise<void> =>
    send(deps, {
      command: 'climate-start',
      temperature,
      durationMinutes: KIA_CLIMATE_DURATION_MIN,
    })

  return {
    setMode: async ({ mode }) => {
      if (mode === 'off') return send(deps, { command: 'climate-stop' })
      if (mode === 'auto' || mode === 'heat' || mode === 'cool') {
        const known = deps.resolveHandle()?.state.climateTargetC ?? null
        return start(preferredC ?? known ?? KIA_DEFAULT_CLIMATE_C)
      }
      throw new Error(`Kia climate does not support the mode "${mode}"`)
    },
    setTarget: async ({ target }) => {
      if (!inRange(target)) {
        throw new Error(
          `Kia climate target ${target} is outside the range ${KIA_CLIMATE_MIN_C}-${KIA_CLIMATE_MAX_C} in steps of ${KIA_CLIMATE_STEP_C}`,
        )
      }
      preferredC = target
      // Only a running climate is restarted; an off or unknown one just remembers the target.
      if (deps.resolveHandle()?.state.climateOn === true) await start(target)
    },
  }
}
