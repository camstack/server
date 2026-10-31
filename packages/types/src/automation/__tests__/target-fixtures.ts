/** Test doubles for D983 target resolution: a registry we can change, and a logger that remembers. */
import { DeviceType } from '../../device/device-type.js'
import type { IScopedLogger } from '../../interfaces/logging.js'
import type { DeviceDirectory, DirectoryDevice } from '../action-target.js'

export interface LoggedLine {
  readonly level: 'debug' | 'info' | 'warn' | 'error'
  readonly message: string
  readonly extras: unknown
}

export function recordingLogger(): {
  logger: IScopedLogger
  lines: LoggedLine[]
} {
  const lines: LoggedLine[] = []
  const logger: IScopedLogger = {
    debug: (message, extras) => void lines.push({ level: 'debug', message, extras }),
    info: (message, extras) => void lines.push({ level: 'info', message, extras }),
    warn: (message, extras) => void lines.push({ level: 'warn', message, extras }),
    error: (message, extras) => void lines.push({ level: 'error', message, extras }),
    child: () => logger,
    withTags: () => logger,
  }
  return { logger, lines }
}

export interface FakeRegistry {
  readonly directory: DeviceDirectory
  /** Devices by id, and the caps each is bound to. Mutate to simulate the fleet changing. */
  readonly devices: Map<number, DirectoryDevice & { caps: string[] }>
  readonly reads: { ids: number; devices: number }
}

export function fakeRegistry(
  seed: readonly (Pick<DirectoryDevice, 'id'> & Partial<DirectoryDevice> & { caps: string[] })[],
): FakeRegistry {
  const devices = new Map(
    seed.map((d) => [d.id, { type: DeviceType.Generic, location: null, disabled: false, ...d }]),
  )
  const reads = { ids: 0, devices: 0 }
  return {
    devices,
    reads,
    directory: {
      listDeviceIdsByCaps: async (capNames) => {
        reads.ids += 1
        return [...devices.values()]
          .filter((d) => d.caps.some((c) => capNames.includes(c)))
          .map((d) => d.id)
      },
      listDevices: async (ids) => {
        reads.devices += 1
        return ids.flatMap((id) => {
          const d = devices.get(id)
          return d === undefined
            ? []
            : [
                {
                  id: d.id,
                  type: d.type,
                  location: d.location,
                  disabled: d.disabled,
                },
              ]
        })
      },
    },
  }
}
