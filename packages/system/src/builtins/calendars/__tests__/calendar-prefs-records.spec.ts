import { createRecordsAccess } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { makeRecordsWorld } from '../../sqlite-storage/__tests__/support/records-world.js'
import { CalendarPrefsStore } from '../calendar-prefs-store.js'
import { calendarsRecordKinds } from '../record-kinds.js'

describe('CalendarPrefsStore — records', () => {
  it('round-trips preferences for a user id', async () => {
    const world = makeRecordsWorld()
    await world.provider.init()
    const records = createRecordsAccess({
      owner: 'calendars',
      transport: world.transportFor('calendars'),
      secrets: null,
    })
    await records.declare(calendarsRecordKinds)
    const store = CalendarPrefsStore.of(records)
    await store.save('u1', { calendars: { 'ha:a': { visible: false } } }, 100)
    expect(await store.load('u1')).toEqual({ calendars: { 'ha:a': { visible: false } } })
    expect(await store.load('missing')).toEqual({ calendars: {} })
  })
})
