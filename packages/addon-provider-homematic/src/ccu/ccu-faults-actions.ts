import type { HmDevice, HmValue } from 'nodehomematic'
import { maintenanceFaultReading } from '../homematic-fault-mapping.js'
import type { CcuActionDeps } from './ccu-facade.js'
import { requireFacade } from './ccu-facade.js'
import { maintenanceChannel } from './ccu-device-rows.js'
import type { CcuFault, CcuFaultRow, CcuFaultsResult, ServiceMessage } from './ccu-schemas.js'

/** A device's MAINTENANCE channel as the parameter map the fault mapping reads. */
function maintenanceValues(device: HmDevice): Map<string, HmValue> {
  const values = new Map<string, HmValue>()
  for (const point of maintenanceChannel(device)?.dataPoints ?? []) {
    values.set(point.parameter, point.value)
  }
  return values
}

type MessageStamp = Pick<ServiceMessage, 'address' | 'type' | 'timestamp'>

/** When the CCU raised a fault: the timestamp of its service message of the same code, else unknown. */
export function faultSince(
  address: string,
  code: string,
  messages: readonly MessageStamp[],
): number | null {
  const found = messages.find(
    (message) =>
      message.address !== null &&
      (message.address === address || message.address.startsWith(`${address}:`)) &&
      message.type === code &&
      message.timestamp !== null,
  )
  return found?.timestamp ?? null
}

/**
 * The active faults CamStack derives from the CCU: the same pure mapping that
 * fills a device's `error` cap, read from the facade's cached MAINTENANCE values.
 * A device whose flags the CCU has not reported is UNKNOWN: it is not a fault
 * row but is named in `unreported`, so no caller reads it as "no fault". Only the `since` lookup is best effort; the device read
 * itself throws, so the page shows its warning instead of an empty list.
 */
export function buildCcuFaultHandlers(deps: CcuActionDeps) {
  return {
    listCcuFaults: async (input: { readonly integrationId: string }): Promise<CcuFaultsResult> => {
      const facade = requireFacade(deps, input.integrationId)
      const adopted = await deps.adoptedAddresses(input.integrationId)
      const messages = await facade.serviceMessages().catch((error: unknown) => {
        deps.logger.warn('listCcuFaults: service messages unreadable, fault start times omitted', {
          meta: {
            integrationId: input.integrationId,
            error: error instanceof Error ? error.message : String(error),
          },
        })
        return []
      })
      const now = Date.now()
      const faults: CcuFaultRow[] = []
      const unreported: string[] = []
      for (const device of facade.devices()) {
        const reading = maintenanceFaultReading(maintenanceValues(device), now)
        if (reading.active === null) {
          unreported.push(device.address)
          continue
        }
        const readingFaults = reading.faults ?? []
        const principal = readingFaults[0]
        if (reading.active !== true || principal === undefined) continue
        const all: CcuFault[] = readingFaults.map((fault) => ({
          code: fault.code,
          label: fault.label,
          severity: fault.severity,
        }))
        faults.push({
          address: device.address,
          name: device.name ?? null,
          deviceId: adopted.get(device.address) ?? null,
          severity: principal.severity,
          code: principal.code,
          label: principal.label,
          since: faultSince(device.address, principal.code, messages),
          faults: all,
        })
      }
      faults.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1))
      return { faults, unreported }
    },
  }
}
