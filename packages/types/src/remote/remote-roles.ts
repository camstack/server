/**
 * The role vocabulary of a remote (D963): what a button MEANS, independent of
 * how it is wired. A layout template places buttons by role; a device binds a
 * role to an action; an exporter asks for a role by name. Roles are shared so
 * one layout fits every appliance and one voice command fits every binding.
 *
 * A role outside this list is `custom:<key>` — the operator's own button (a
 * SmartIR source, a channel preset). The key is a lowercase slug.
 */
import { z } from 'zod'

export const REMOTE_KNOWN_ROLES = [
  'power',
  'power_on',
  'power_off',
  'volume_up',
  'volume_down',
  'mute',
  'channel_up',
  'channel_down',
  'up',
  'down',
  'left',
  'right',
  'ok',
  'back',
  'home',
  'menu',
  'info',
  'guide',
  'exit',
  'input',
  'play',
  'pause',
  'play_pause',
  'stop',
  'next',
  'previous',
  'fast_forward',
  'rewind',
  'digit_0',
  'digit_1',
  'digit_2',
  'digit_3',
  'digit_4',
  'digit_5',
  'digit_6',
  'digit_7',
  'digit_8',
  'digit_9',
] as const
export type RemoteKnownRole = (typeof REMOTE_KNOWN_ROLES)[number]

export const REMOTE_CUSTOM_ROLE_PREFIX = 'custom:'
const CUSTOM_KEY_RE = /^[a-z0-9][a-z0-9_]{0,47}$/

const KNOWN_ROLES: ReadonlySet<string> = new Set(REMOTE_KNOWN_ROLES)

export function isRemoteKnownRole(value: string): value is RemoteKnownRole {
  return KNOWN_ROLES.has(value)
}

export function isRemoteCustomKey(key: string): boolean {
  return CUSTOM_KEY_RE.test(key)
}

export function customRole(key: string): string {
  return `${REMOTE_CUSTOM_ROLE_PREFIX}${key}`
}

/** The key of a `custom:<key>` role, or null for any other string. */
export function customKeyOfRole(role: string): string | null {
  if (!role.startsWith(REMOTE_CUSTOM_ROLE_PREFIX)) return null
  const key = role.slice(REMOTE_CUSTOM_ROLE_PREFIX.length)
  return isRemoteCustomKey(key) ? key : null
}

export function isRemoteRole(value: string): boolean {
  return isRemoteKnownRole(value) || customKeyOfRole(value) !== null
}

export const RemoteRoleSchema = z.string().refine(isRemoteRole, {
  message: 'a role is one of the known roles or custom:<key> (lowercase letters, digits, _)',
})
export type RemoteRole = z.infer<typeof RemoteRoleSchema>
