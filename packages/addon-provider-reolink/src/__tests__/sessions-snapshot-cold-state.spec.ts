import type { ConfigUISchema } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { buildSessionsTabSections, type SessionsSnapshot } from '../sessions-snapshot.js'

/**
 * Cold-state honesty for the Sessions tab.
 *
 * Mains-powered cameras (and the hub) auto-refresh the snapshot on form
 * open, so a null snapshot is genuinely transient → "Loading…". Battery
 * cams are NOT auto-refreshed (a fetch wakes the radio), so a null
 * snapshot is NOT going to populate on its own → "Click Refresh to load"
 * is the honest label. The `autoRefreshes` opts flag selects the text.
 */

type Section = ConfigUISchema['sections'][number]
type Field = Section['fields'][number]

function findField(sections: readonly Section[], key: string): Field {
  for (const section of sections) {
    for (const field of section.fields) {
      if (field.key === key) return field
    }
  }
  throw new Error(`field ${key} not found`)
}

function infoContent(field: Field): string {
  if (field.type !== 'info') throw new Error('expected info field')
  return field.content
}

function arrayEmptyMessage(field: Field): string | undefined {
  if (field.type !== 'object-array') throw new Error('expected object-array field')
  return field.emptyMessage
}

const populatedSnapshot: SessionsSnapshot = {
  ts: Date.now(),
  onlineUsers: [
    { userName: 'admin', ip: '192.168.10.10', sessionId: 42, level: 'admin', online: true },
  ],
  socketPool: [{ tag: 'general', state: 'open' }],
  dedicatedSessions: [],
  cooldown: null,
}

describe('buildSessionsTabSections cold-state text', () => {
  it('uses "Click Refresh to load" when autoRefreshes is false and snapshot is null', () => {
    const sections = buildSessionsTabSections(null, {
      tabId: 'sessions',
      title: 'Camera Sessions',
      autoRefreshes: false,
    })
    expect(infoContent(findField(sections, 'sessionsLastRefreshed'))).toBe('Click Refresh to load')
    expect(arrayEmptyMessage(findField(sections, 'sessionsOnlineUsers'))).toBe(
      'Click Refresh to load',
    )
    expect(arrayEmptyMessage(findField(sections, 'sessionsSocketPool'))).toBe(
      'Click Refresh to load',
    )
    expect(infoContent(findField(sections, 'sessionsCooldown'))).toBe('Click Refresh to load')
  })

  it('uses "Loading…" when autoRefreshes is true and snapshot is null', () => {
    const sections = buildSessionsTabSections(null, {
      tabId: 'sessions',
      title: 'Hub Sessions',
      autoRefreshes: true,
    })
    expect(infoContent(findField(sections, 'sessionsLastRefreshed'))).toBe('Loading…')
    expect(arrayEmptyMessage(findField(sections, 'sessionsOnlineUsers'))).toBe('Loading…')
    expect(arrayEmptyMessage(findField(sections, 'sessionsSocketPool'))).toBe('Loading…')
    expect(infoContent(findField(sections, 'sessionsCooldown'))).toBe('Loading…')
  })

  it('renders a populated snapshot identically regardless of autoRefreshes', () => {
    const asBattery = buildSessionsTabSections(populatedSnapshot, {
      tabId: 'sessions',
      title: 'Camera Sessions',
      autoRefreshes: false,
    })
    const asMains = buildSessionsTabSections(populatedSnapshot, {
      tabId: 'sessions',
      title: 'Camera Sessions',
      autoRefreshes: true,
    })

    for (const sections of [asBattery, asMains]) {
      // Age string is real, not a cold placeholder.
      const age = infoContent(findField(sections, 'sessionsLastRefreshed'))
      expect(age).toMatch(/ago/)
      expect(age).not.toBe('Loading…')
      expect(age).not.toBe('Click Refresh to load')

      // Online users + socket pool rows render from the snapshot.
      const onlineField = findField(sections, 'sessionsOnlineUsers')
      if (onlineField.type !== 'object-array') throw new Error('expected object-array')
      expect(onlineField.value).toHaveLength(1)

      const poolField = findField(sections, 'sessionsSocketPool')
      if (poolField.type !== 'object-array') throw new Error('expected object-array')
      expect(poolField.value).toHaveLength(1)
    }

    // The two outputs are byte-for-byte identical.
    expect(JSON.stringify(asBattery)).toBe(JSON.stringify(asMains))
  })
})
