/**
 * The events a notification rule can name on its own devices: what each
 * selected event device DECLARES it can fire (the vocabulary of its
 * `event-emitter` slice), by native token, under the declared label.
 *
 * The engine matches the token on the device (`eventTypeTokens` against the
 * fire's `eventType`), not the part of the device that fired it, so a token
 * several parts declare is one choice.
 */
import { EventEmitterStatusSchema, readEventVocabulary } from '@camstack/types'
import type { RuleCameraOption } from './notification-condition-fields'
import type { DeclaredEventDevice, PickOption } from './notification-rule-pickers'
import type { RuleDeviceOption } from './rule-device-filter'

/** The cap whose slice carries the vocabulary. */
export const EVENT_EMITTER_CAP = 'event-emitter'

/** One selected device's `event-emitter` slice read. */
export interface DeclaredEventRead {
  readonly deviceId: number
  readonly deviceName: string
  readonly status: 'pending' | 'error' | 'success'
  /** The slice; `null` when the device has none — it is not an event device. */
  readonly data: unknown
}

export interface DeclaredEventOptions {
  readonly options: readonly PickOption[]
  /** A read has not answered: not-yet-known is never "no events" (D315). */
  readonly pending: boolean
  /** Devices whose read failed or did not parse: their events are unknown. */
  readonly unknownDevices: readonly string[]
  /** How many of the selected devices answered as event devices. */
  readonly eventDeviceCount: number
}

interface DeclaredToken {
  readonly label: string
  readonly devices: readonly string[]
}

export function declaredEventOptions(reads: readonly DeclaredEventRead[]): DeclaredEventOptions {
  const tokens = new Map<string, DeclaredToken>()
  const unknownDevices: string[] = []
  let pending = false
  let eventDeviceCount = 0
  for (const read of reads) {
    if (read.status === 'pending') {
      pending = true
      continue
    }
    if (read.status === 'error') {
      unknownDevices.push(read.deviceName)
      continue
    }
    if (read.data === null || read.data === undefined) continue
    const parsed = EventEmitterStatusSchema.safeParse(read.data)
    if (!parsed.success) {
      unknownDevices.push(read.deviceName)
      continue
    }
    eventDeviceCount += 1
    for (const entry of readEventVocabulary(parsed.data)) {
      const known = tokens.get(entry.id)
      if (known === undefined) {
        tokens.set(entry.id, { label: entry.label, devices: [read.deviceName] })
      } else if (!known.devices.includes(read.deviceName)) {
        tokens.set(entry.id, { label: known.label, devices: [...known.devices, read.deviceName] })
      }
    }
  }
  const named = eventDeviceCount > 1
  const options = [...tokens.entries()].map(([value, token]): PickOption => {
    return named
      ? { value, label: token.label, hint: token.devices.join(', ') }
      : { value, label: token.label }
  })
  return { options, pending, unknownDevices, eventDeviceCount }
}

/**
 * The selected devices that may be event devices: every one that is not a
 * camera, under the name the fleet gives it.
 */
export function declaredEventCandidates(
  deviceIds: readonly number[],
  cameras: readonly RuleCameraOption[],
  allDevices: readonly RuleDeviceOption[] | undefined,
): DeclaredEventDevice[] {
  const cameraIds = new Set(cameras.map((camera) => camera.id))
  const names = new Map((allDevices ?? []).map((device) => [device.id, device.name]))
  return deviceIds
    .filter((deviceId) => !cameraIds.has(deviceId))
    .map((deviceId) => ({ deviceId, deviceName: names.get(deviceId) ?? `#${deviceId}` }))
}
