import { describe, expect, it } from 'vitest'
import { ICON_KEYS } from '../../device/icon-catalog.generated.js'
import { REMOTE_KNOWN_ROLES } from '../remote-roles.js'
import {
  REMOTE_CUSTOM_ROLE_ICON,
  REMOTE_ROLE_VOCABULARY,
  remoteRoleIcon,
  remoteRoleLabel,
} from '../remote-role-vocabulary.js'

const ICONS: ReadonlySet<string> = new Set(ICON_KEYS)

describe('remote role vocabulary', () => {
  it.each(REMOTE_KNOWN_ROLES)('%s has a label in every locale and a catalogue icon', (role) => {
    const entry = REMOTE_ROLE_VOCABULARY[role]
    expect(entry.label.en.trim()).not.toBe('')
    expect(entry.label.it.trim()).not.toBe('')
    expect(ICONS.has(entry.icon)).toBe(true)
  })

  it('carries no entry for a role outside the enum', () => {
    expect(Object.keys(REMOTE_ROLE_VOCABULARY).sort()).toEqual([...REMOTE_KNOWN_ROLES].sort())
  })

  it('a custom role wears the fallback icon and its key as name', () => {
    expect(ICONS.has(REMOTE_CUSTOM_ROLE_ICON)).toBe(true)
    expect(remoteRoleIcon('custom:hdmi_1')).toBe(REMOTE_CUSTOM_ROLE_ICON)
    expect(remoteRoleLabel('custom:hdmi_1', 'en')).toBe('hdmi 1')
    expect(remoteRoleLabel('volume_up', 'it')).toBe('Volume su')
  })
})
