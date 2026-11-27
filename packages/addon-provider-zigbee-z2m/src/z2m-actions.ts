/**
 * Management of a Zigbee2MQTT server as integration custom actions: permit join (timed), rename,
 * remove (with a force option) and a bridge restart. Each one is a `bridge/request/*` the server
 * answers with `status: ok | error`; a refusal reaches the button as the server's own reason.
 * Every action is `auth: 'admin'`: they change the network.
 */
import { customAction, defineCustomActions } from '@camstack/types'
import { z } from 'zod'
import type { IScopedLogger } from '@camstack/types'
import { type Delay, realDelay, startFirmwareUpdate } from './z2m-firmware.js'
import type { Z2mHub } from './z2m-hub.js'
import { type Z2mDevice, Z2mOtaCheckSchema, Z2mUpdateStateSchema } from './z2m-protocol.js'
import type { Z2mSession } from './z2m-session.js'

/** The longest window the server accepts for permit join, in seconds. */
export const Z2M_PERMIT_JOIN_MAX_S = 254
export const Z2M_PERMIT_JOIN_DEFAULT_S = 60

/** Which integration an action is for; a caller that sends none acts on the only open one. */
const Target = z.object({ instanceId: z.string().optional() })

const Done = z.object({ message: z.string() })

const DeviceUpdate = z.object({
  device: z.string(),
  deviceId: z.number().nullable(),
  state: z.enum(['available', 'updating', 'idle', 'scheduled']),
  progress: z.number().nullable(),
  remainingS: z.number().nullable(),
  installedVersion: z.number().nullable(),
  latestVersion: z.number().nullable(),
})
export type DeviceUpdate = z.infer<typeof DeviceUpdate>

export const zigbeeZ2mActions = defineCustomActions({
  /** Open the network for new devices for `seconds` (1 to 254); `0` closes it again. */
  permitJoin: customAction(
    Target.extend({ seconds: z.union([z.number(), z.string()]).optional() }),
    z.object({ message: z.string(), seconds: z.number() }),
    { kind: 'mutation', auth: 'admin' },
  ),
  /** `rename` is `current name -> new name`: one prompt on the button carries both. */
  renameDevice: customAction(Target.extend({ rename: z.string() }), Done, {
    kind: 'mutation',
    auth: 'admin',
  }),
  /** `device` is a friendly name or an IEEE address; `force` removes it although it does not answer. */
  removeDevice: customAction(
    Target.extend({ device: z.string(), force: z.boolean().optional() }),
    Done,
    { kind: 'mutation', auth: 'admin' },
  ),
  restartBridge: customAction(Target.optional(), Done, { kind: 'mutation', auth: 'admin' }),
  /** Ask the server whether a firmware image is available for one device (it may contact the device). */
  checkDeviceUpdate: customAction(
    Target.extend({ device: z.string() }),
    z.object({ message: z.string(), updateAvailable: z.boolean() }),
    { kind: 'mutation', auth: 'admin' },
  ),
  /** Start the firmware update of one device. It runs for minutes: this answers once it is accepted. */
  updateDevice: customAction(Target.extend({ device: z.string() }), Done, {
    kind: 'mutation',
    auth: 'admin',
  }),
  /** Where each device's firmware stands, from the `update` block the server pushes with its state. */
  deviceUpdates: customAction(Target.optional(), z.object({ devices: z.array(DeviceUpdate) }), {
    kind: 'query',
    auth: 'admin',
  }),
})

export interface PermitJoinWindow {
  readonly seconds: number
}

/** A window in seconds from a button prompt (text) or a caller (number); refuses what the server would. */
export function parsePermitJoinSeconds(raw: number | string | undefined): number {
  if (raw === undefined || raw === '') return Z2M_PERMIT_JOIN_DEFAULT_S
  const seconds = typeof raw === 'number' ? raw : Number(raw.trim())
  if (!Number.isInteger(seconds) || seconds < 0 || seconds > Z2M_PERMIT_JOIN_MAX_S) {
    throw new Error(
      `permit join takes a whole number of seconds from 0 to ${Z2M_PERMIT_JOIN_MAX_S}`,
    )
  }
  return seconds
}

export interface Rename {
  readonly from: string
  readonly to: string
}

const RENAME_SEPARATOR = '->'

export function parseRename(text: string): Rename {
  const at = text.indexOf(RENAME_SEPARATOR)
  const from = at < 0 ? '' : text.slice(0, at).trim()
  const to = at < 0 ? '' : text.slice(at + RENAME_SEPARATOR.length).trim()
  if (from === '' || to === '') throw new Error('write the rename as: current name -> new name')
  return { from, to }
}

export type Z2mActionInput = z.input<typeof Target> | undefined

/** What each action does, reading the sessions through the hub. */
export class Z2mManagement {
  constructor(
    private readonly hub: Z2mHub,
    private readonly logger: IScopedLogger,
    private readonly delay: Delay = realDelay,
  ) {}

  private sessionOf(input: Z2mActionInput): Z2mSession {
    const id = input?.instanceId
    if (id !== undefined) {
      const session = this.hub.session(id)
      if (session === null) throw new Error('this Zigbee2MQTT integration has no open connection')
      return session
    }
    const open = this.hub.sessionIds()
    const only = open.length === 1 ? open[0] : undefined
    const session = only === undefined ? null : this.hub.session(only)
    if (session === null) {
      throw new Error(
        open.length === 0
          ? 'no Zigbee2MQTT integration is connected'
          : 'several Zigbee2MQTT integrations are connected: say which one',
      )
    }
    return session
  }

  async permitJoin(input: z.input<typeof Target> & { seconds?: number | string }) {
    const seconds = parsePermitJoinSeconds(input.seconds)
    await this.sessionOf(input).request('bridge/request/permit_join', { time: seconds })
    return {
      seconds,
      message: seconds === 0 ? 'Joining is closed.' : `Joining is open for ${seconds} s.`,
    }
  }

  async renameDevice(input: z.input<typeof Target> & { rename: string }) {
    const { from, to } = parseRename(input.rename)
    await this.sessionOf(input).request('bridge/request/device/rename', {
      from,
      to,
      homeassistant_rename: false,
    })
    return { message: `Renamed ${from} to ${to}.` }
  }

  async removeDevice(input: z.input<typeof Target> & { device: string; force?: boolean }) {
    const device = input.device.trim()
    if (device === '') throw new Error('name the device to remove')
    const force = input.force === true
    await this.sessionOf(input).request('bridge/request/device/remove', {
      id: device,
      force,
      block: false,
    })
    return { message: force ? `Removed ${device} (forced).` : `Removed ${device}.` }
  }

  async restartBridge(input: Z2mActionInput) {
    await this.sessionOf(input).request('bridge/request/restart', {})
    return { message: 'Zigbee2MQTT is restarting; devices reconnect on their own.' }
  }

  /** The table entry named by a friendly name or an IEEE address. */
  private deviceNamed(session: Z2mSession, name: string): Z2mDevice {
    const wanted = name.trim()
    if (wanted === '') throw new Error('name the device')
    for (const device of session.deviceTable().values()) {
      if (device.friendly_name === wanted || device.ieee_address === wanted) return device
    }
    throw new Error(`Zigbee2MQTT does not list a device named ${wanted}`)
  }

  async checkDeviceUpdate(input: z.input<typeof Target> & { device: string }) {
    const session = this.sessionOf(input)
    const device = this.deviceNamed(session, input.device)
    const data = await session.request('bridge/request/device/ota_update/check', {
      id: device.ieee_address,
    })
    const parsed = Z2mOtaCheckSchema.safeParse(data)
    if (!parsed.success)
      throw new Error('Zigbee2MQTT answered the update check in an unknown shape')
    const updateAvailable = parsed.data.update_available
    return {
      updateAvailable,
      message: updateAvailable
        ? `A firmware update is available for ${device.friendly_name}.`
        : `${device.friendly_name} is up to date.`,
    }
  }

  async updateDevice(input: z.input<typeof Target> & { device: string }) {
    const session = this.sessionOf(input)
    const device = this.deviceNamed(session, input.device)
    const { finished } = await startFirmwareUpdate(
      this.hub,
      session,
      { ieee: device.ieee_address, name: device.friendly_name },
      this.logger,
      this.delay,
    )
    return {
      message: finished
        ? `${device.friendly_name} finished its firmware update.`
        : `Firmware update of ${device.friendly_name} started. Follow it under the device updates; do not power the device off.`,
    }
  }

  deviceUpdates(input: Z2mActionInput): { devices: DeviceUpdate[] } {
    const session = this.sessionOf(input)
    const integrationId = session.integrationId
    const devices: DeviceUpdate[] = []
    for (const device of session.deviceTable().values()) {
      const block = session.stateOf(device.ieee_address)?.['update']
      const parsed = Z2mUpdateStateSchema.safeParse(block)
      if (!parsed.success) continue
      devices.push({
        device: device.friendly_name,
        deviceId: this.hub.deviceIdOf(integrationId, device.ieee_address),
        state: parsed.data.state,
        progress: parsed.data.progress ?? null,
        remainingS: parsed.data.remaining ?? null,
        installedVersion: parsed.data.installed_version ?? null,
        latestVersion: parsed.data.latest_version ?? null,
      })
    }
    return { devices }
  }
}

export type ZigbeeZ2mActions = typeof zigbeeZ2mActions
