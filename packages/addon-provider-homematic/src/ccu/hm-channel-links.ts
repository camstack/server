import { z } from 'zod'

/**
 * The slice of nodehomematic the button-event actions need. Specs hand in a
 * fake. The installed 0.5.1 build has none of these methods: the adapter
 * feature-checks and answers `unsupported` instead of calling them.
 *
 * What 0.6 must provide, on the facade object:
 * - `getChannelLinkState(address) → { central: boolean; links: { sender, receiver, name }[] }`
 * - `createCentralLink(address)` idempotent
 * - `removeCentralLink(address)` idempotent, throwing a typed error on failure
 * - `name: string | null` on devices and channels (read separately, not here)
 */

export const ChannelLinkSchema = z.object({
  sender: z.string(),
  receiver: z.string(),
  name: z.string(),
})
export type ChannelLink = z.infer<typeof ChannelLinkSchema>

export const ChannelLinkStateSchema = z.object({
  central: z.boolean(),
  links: z.array(ChannelLinkSchema),
})
export type ChannelLinkState = z.infer<typeof ChannelLinkStateSchema>

export type ChannelLinkRead =
  | { readonly kind: 'ok'; readonly state: ChannelLinkState }
  | { readonly kind: 'unsupported' }
  | { readonly kind: 'error'; readonly message: string }

export type ChannelLinkWrite =
  | { readonly kind: 'ok' }
  | { readonly kind: 'unsupported' }
  | { readonly kind: 'error'; readonly message: string }

export interface HmChannelLinkPort {
  getChannelLinkState(address: string): Promise<ChannelLinkRead>
  createCentralLink(address: string): Promise<ChannelLinkWrite>
  removeCentralLink(address: string): Promise<ChannelLinkWrite>
}

const GET_CHANNEL_LINK_STATE = 'getChannelLinkState'
const CREATE_CENTRAL_LINK = 'createCentralLink'
const REMOVE_CENTRAL_LINK = 'removeCentralLink'

type LinkFn = (...args: readonly unknown[]) => unknown

/** A method the installed library actually has, bound to its facade. */
function lookup(target: object, name: string): LinkFn | null {
  const value: unknown = Reflect.get(target, name)
  if (typeof value !== 'function') return null
  const fn: LinkFn = (...args) => Reflect.apply(value, target, [...args])
  return fn
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

async function write(target: object, name: string, address: string): Promise<ChannelLinkWrite> {
  const fn = lookup(target, name)
  if (fn === null) return { kind: 'unsupported' }
  try {
    await fn(address)
    return { kind: 'ok' }
  } catch (err: unknown) {
    return { kind: 'error', message: errorMessage(err) }
  }
}

/** Adapt a live facade. Missing methods are `unsupported`, never a cast. */
export function channelLinkPort(target: object): HmChannelLinkPort {
  return {
    async getChannelLinkState(address) {
      const fn = lookup(target, GET_CHANNEL_LINK_STATE)
      if (fn === null) return { kind: 'unsupported' }
      try {
        const parsed = ChannelLinkStateSchema.safeParse(await fn(address))
        if (!parsed.success) {
          return { kind: 'error', message: 'Channel link state did not match the expected shape' }
        }
        return { kind: 'ok', state: parsed.data }
      } catch (err: unknown) {
        return { kind: 'error', message: errorMessage(err) }
      }
    },
    createCentralLink: (address) => write(target, CREATE_CENTRAL_LINK, address),
    removeCentralLink: (address) => write(target, REMOVE_CENTRAL_LINK, address),
  }
}

/**
 * A CCU name on a device or channel (`name: string | null` in nodehomematic
 * 0.6). 0.5.1 omits the field: that is "no name", not a failure.
 */
export function readHmName(value: object): string | null {
  if (!('name' in value)) return null
  const raw: unknown = Reflect.get(value, 'name')
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  return trimmed.length > 0 ? trimmed : null
}
