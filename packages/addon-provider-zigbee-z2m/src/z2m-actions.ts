/**
 * Management of a Zigbee2MQTT server as integration custom actions: permit join (timed), rename,
 * remove (with a force option) and a bridge restart. Each one is a `bridge/request/*` the server
 * answers with `status: ok | error`; a refusal reaches the button as the server's own reason.
 * Every action is `auth: 'admin'`: they change the network.
 */
import { customAction, defineCustomActions } from '@camstack/types'
import { z } from 'zod'
import type { Z2mHub } from './z2m-hub.js'

/** The longest window the server accepts for permit join, in seconds. */
export const Z2M_PERMIT_JOIN_MAX_S = 254
export const Z2M_PERMIT_JOIN_DEFAULT_S = 60

/** Which integration an action is for; a caller that sends none acts on the only open one. */
const Target = z.object({ instanceId: z.string().optional() })

const Done = z.object({ message: z.string() })

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
  constructor(private readonly hub: Z2mHub) {}

  private sessionOf(input: Z2mActionInput) {
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
}

export type ZigbeeZ2mActions = typeof zigbeeZ2mActions
