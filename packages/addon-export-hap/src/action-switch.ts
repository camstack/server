/**
 * An exported ACTION as a HomeKit accessory (D967).
 *
 * HomeKit has no "run" verb, so an action is a STATELESS MOMENTARY SWITCH:
 * turning it on runs the action, and the switch turns itself off about a
 * second later. It holds no state of its own — what the action did is the
 * action's business (`actions.list` carries its run status) — so a controller
 * that reads it always reads "off" once the pulse is over.
 *
 * It is an accessory beside the devices, never a device (D954): the uuid is
 * derived from the action id, and nothing here touches the device registry.
 * Whether the run was accepted is decided by `actions.run`, which refuses an
 * action that is already running or in cooldown; the caller logs that refusal
 * and this switch still turns itself off — it never queues a second press.
 */
import { Accessory, Categories, Characteristic, Service, uuid } from '@homebridge/hap-nodejs'

import type { Mapper } from './mappers/types.js'

/** How long the switch stays on after a press. */
export const ACTION_SWITCH_AUTO_OFF_MS = 1000

/** Deterministic and distinct from every device accessory uuid. */
export function actionSwitchUuid(actionId: string): string {
  return uuid.generate(`camstack:hap:action:${actionId}`)
}

export interface ActionSwitchInput {
  readonly actionId: string
  readonly displayName: string
  /** Starts the action. Never throws into HomeKit: a failure is the caller's to log. */
  readonly run: () => Promise<void>
  readonly autoOffMs?: number
}

export function buildActionSwitch(input: ActionSwitchInput): Mapper {
  const { actionId, displayName, run } = input
  const autoOffMs = input.autoOffMs ?? ACTION_SWITCH_AUTO_OFF_MS

  const accessory = new Accessory(displayName, actionSwitchUuid(actionId))
  accessory.category = Categories.SWITCH

  const info = accessory.getService(Service.AccessoryInformation)
  info?.setCharacteristic(Characteristic.Manufacturer, 'CamStack')
  info?.setCharacteristic(Characteristic.Model, 'Action')
  info?.setCharacteristic(Characteristic.SerialNumber, `camstack-action-${actionId}`)

  const service = accessory.addService(Service.Switch, displayName)
  const on = service.getCharacteristic(Characteristic.On)
  let timer: NodeJS.Timeout | null = null

  const clearTimer = (): void => {
    if (timer !== null) clearTimeout(timer)
    timer = null
  }

  on.onSet(async (value) => {
    if (value !== true) {
      // A hand-off before the pulse ended: nothing to run, nothing to wait for.
      clearTimer()
      return
    }
    // A press while the pulse is still on is the same press: never a second run.
    if (timer !== null) return
    timer = setTimeout(() => {
      timer = null
      service.updateCharacteristic(Characteristic.On, false)
    }, autoOffMs)
    try {
      await run()
    } catch {
      // The caller logged it (named reason); the pulse still ends on its timer.
    }
  })
  on.onGet(() => false)

  return {
    accessory,
    accessories: [accessory],
    async dispose(): Promise<void> {
      clearTimer()
    },
  }
}
