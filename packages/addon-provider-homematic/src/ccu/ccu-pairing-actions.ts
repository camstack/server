import { HM_DELETE_FLAGS } from 'nodehomematic'
import type { CcuActionDeps } from './ccu-facade.js'
import { errorText, requireConfirmed, requireFacade } from './ccu-facade.js'
import type { PairingStatus } from './ccu-schemas.js'

/** The interfaces with a pairing window the CCU lets a client open. */
const PAIRABLE_INTERFACE = /^(BidCos-RF|HmIP-RF)$/
const BIDCOS_INTERFACE = /^BidCos-RF$/

interface IntegrationInput {
  readonly integrationId: string
}
interface SetInstallModeInput extends IntegrationInput {
  readonly interface: string
  readonly on: boolean
  readonly seconds?: number
  readonly mode?: 'normal' | 'secure'
  readonly confirmed: boolean
}
interface DeleteDeviceInput extends IntegrationInput {
  readonly address: string
  readonly reset: boolean
  readonly force: boolean
  readonly confirmed: boolean
}

function deleteFlags(reset: boolean, force: boolean): number {
  return (reset ? HM_DELETE_FLAGS.RESET : 0) | (force ? HM_DELETE_FLAGS.FORCE : 0)
}

/** The Pairing tab: the learn-mode windows of the radio interfaces, and removing a device from the CCU. */
export function buildCcuPairingHandlers(deps: CcuActionDeps) {
  return {
    ccuPairingStatus: async (input: IntegrationInput): Promise<PairingStatus> => {
      const facade = requireFacade(deps, input.integrationId)
      let names: readonly string[]
      try {
        names = (await facade.listInterfaces())
          .map((iface) => iface.name)
          .filter((name) => PAIRABLE_INTERFACE.test(name))
      } catch (err) {
        deps.logger.warn('Homematic: pairing interfaces unavailable', {
          meta: { integrationId: input.integrationId, error: errorText(err) },
        })
        return { interfaces: [], error: errorText(err) }
      }
      const interfaces = await Promise.all(
        names.map(async (name) => {
          const supportsSecure = BIDCOS_INTERFACE.test(name)
          try {
            return {
              name,
              secondsLeft: await facade.getInstallMode(name),
              supportsSecure,
              error: null,
            }
          } catch (err) {
            return { name, secondsLeft: null, supportsSecure, error: errorText(err) }
          }
        }),
      )
      return { interfaces, error: null }
    },

    setCcuInstallMode: async (input: SetInstallModeInput): Promise<{ ok: true }> => {
      requireConfirmed(input.confirmed)
      const facade = requireFacade(deps, input.integrationId)
      if (!PAIRABLE_INTERFACE.test(input.interface)) {
        throw new Error(`Interface ${input.interface} has no pairing window`)
      }
      if (input.mode === 'secure' && !BIDCOS_INTERFACE.test(input.interface)) {
        throw new Error('Secure pairing is offered by BidCos-RF only')
      }
      await facade.setInstallMode({
        interface: input.interface,
        on: input.on,
        ...(input.on && input.seconds !== undefined ? { seconds: input.seconds } : {}),
        ...(input.on && input.mode !== undefined ? { mode: input.mode } : {}),
      })
      deps.logger.info('Homematic: pairing window changed', {
        meta: {
          integrationId: input.integrationId,
          interface: input.interface,
          on: input.on,
          seconds: input.seconds,
          mode: input.mode,
        },
      })
      return { ok: true }
    },

    deleteCcuDevice: async (input: DeleteDeviceInput): Promise<{ ok: true }> => {
      requireConfirmed(input.confirmed)
      const facade = requireFacade(deps, input.integrationId)
      await facade.deleteDevice(input.address, deleteFlags(input.reset, input.force))
      deps.logger.info('Homematic: device deleted from the CCU', {
        meta: {
          integrationId: input.integrationId,
          address: input.address,
          reset: input.reset,
          force: input.force,
        },
      })
      return { ok: true }
    },
  }
}
