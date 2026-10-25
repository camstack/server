// @vitest-environment jsdom
/**
 * What a backup carries — selection → payload mapping, defaults, legacy rows,
 * presence (unknown is not absent), and the picker / badges / restore copy.
 */
import type { DataStoreDatabase } from '@camstack/types'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const available = vi.hoisted(() => ({
  data: undefined as
    | { answered: boolean; databases: readonly ('settings' | 'events' | 'history')[] }
    | undefined,
}))

vi.mock('@camstack/ui-library', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@camstack/ui-library')>()
  return { ...actual, useBackupListAvailableDatabases: () => ({ data: available.data }) }
})

import { BackupDatabaseBadges } from '../BackupDatabaseBadges'
import { BackupDatabasePicker } from '../BackupDatabasePicker'
import {
  DEFAULT_DATABASE_SELECTION,
  databasePresence,
  databasesOfArchive,
  databasesPayload,
  isDatabaseDisabled,
  isSnapshotsOnly,
  selectionOfRow,
  toggleDatabase,
  triggerInputFor,
} from '../backup-databases'

afterEach(() => {
  cleanup()
  available.data = undefined
})

const set = (...ids: DataStoreDatabase[]): ReadonlySet<DataStoreDatabase> => new Set(ids)

describe('selection → payload', () => {
  it('a new schedule and a manual run default to settings', () => {
    expect(DEFAULT_DATABASE_SELECTION).toEqual(['settings'])
    expect(triggerInputFor(new Set(DEFAULT_DATABASE_SELECTION))).toEqual({
      databases: ['settings'],
    })
  })

  it('writes the selection in the server order whatever order it was ticked in', () => {
    expect(databasesPayload(set('history', 'events'))).toEqual(['events', 'history'])
    expect(databasesPayload(set('history', 'settings'))).toEqual(['settings', 'history'])
  })

  it('toggling returns a new set and leaves the old one alone', () => {
    const before = set('settings')
    const after = toggleDatabase(before, 'events')
    expect([...before]).toEqual(['settings'])
    expect([...after].toSorted()).toEqual(['events', 'settings'])
    expect([...toggleDatabase(after, 'settings')]).toEqual(['events'])
  })

  it('an existing row without a list (NULL) or with an empty one shows as settings', () => {
    expect(selectionOfRow(undefined)).toEqual(['settings'])
    expect(selectionOfRow([])).toEqual(['settings'])
    expect(selectionOfRow(['history', 'events'])).toEqual(['events', 'history'])
  })

  it('a run without settings is snapshots-only', () => {
    expect(isSnapshotsOnly(['events', 'history'])).toBe(true)
    expect(isSnapshotsOnly(['settings', 'events'])).toBe(false)
  })
})

describe('presence', () => {
  it('an unanswered query is unknown, never absent', () => {
    expect(databasePresence('history', undefined)).toBe('unknown')
    expect(databasePresence('history', { answered: false, databases: [] })).toBe('unknown')
  })

  it('an answered list says present or absent', () => {
    const answer = { answered: true, databases: ['settings', 'events'] } as const
    expect(databasePresence('events', answer)).toBe('present')
    expect(databasePresence('history', answer)).toBe('absent')
  })

  it('an absent database cannot be newly ticked, but one already selected can be unticked', () => {
    const answer = { answered: true, databases: ['settings'] } as const
    expect(isDatabaseDisabled('history', answer, set('settings'))).toBe(true)
    expect(isDatabaseDisabled('history', answer, set('history'))).toBe(false)
    expect(isDatabaseDisabled('history', undefined, set('settings'))).toBe(false)
  })
})

describe('archive databases', () => {
  it('uses what the run asked for, else the manifest snapshots, else settings', () => {
    expect(databasesOfArchive(['events', 'history'], undefined)).toEqual(['events', 'history'])
    expect(databasesOfArchive(undefined, [{ databaseId: 'events' }])).toEqual(['events'])
    expect(databasesOfArchive(undefined, [{}])).toEqual(['settings'])
    expect(databasesOfArchive(undefined, undefined)).toEqual(['settings'])
  })
})

describe('BackupDatabasePicker', () => {
  it('shows a database that does not exist yet disabled, with the hint, not hidden', () => {
    available.data = { answered: true, databases: ['settings', 'events'] }
    render(<BackupDatabasePicker selected={set('settings')} onChange={() => undefined} />)
    expect(screen.getByText('Configuration & files')).toBeTruthy()
    expect(screen.getByText('Events & detections')).toBeTruthy()
    expect(screen.getByText('History (statistics)')).toBeTruthy()
    const history = screen.getByTestId('backup-databases-history') as HTMLInputElement
    expect(history.disabled).toBe(true)
    expect(screen.getByText('Created when this feature is enabled')).toBeTruthy()
    expect((screen.getByTestId('backup-databases-events') as HTMLInputElement).disabled).toBe(false)
  })

  it('reports the toggled selection', () => {
    available.data = { answered: true, databases: ['settings', 'events'] }
    const onChange = vi.fn()
    render(<BackupDatabasePicker selected={set('settings')} onChange={onChange} />)
    fireEvent.click(screen.getByTestId('backup-databases-events'))
    const next = onChange.mock.calls[0]?.[0] as ReadonlySet<DataStoreDatabase>
    expect([...databasesPayload(next)]).toEqual(['settings', 'events'])
  })

  it('does not call a database absent while the owner has not answered', () => {
    render(<BackupDatabasePicker selected={set('settings')} onChange={() => undefined} />)
    expect((screen.getByTestId('backup-databases-history') as HTMLInputElement).disabled).toBe(
      false,
    )
    expect(screen.queryByText('Created when this feature is enabled')).toBeNull()
  })
})

describe('BackupDatabaseBadges', () => {
  it('lists the databases as one compact uppercase text line', () => {
    render(<BackupDatabaseBadges databases={['settings', 'events', 'history']} />)
    const el = screen.getByTestId('backup-database-badges')
    expect(el.textContent).toBe('Settings · Events · History')
    expect(el.className).toContain('uppercase')
  })

  it('carries no extra label for an archive without settings', () => {
    render(<BackupDatabaseBadges databases={['events', 'history']} />)
    expect(screen.getByTestId('backup-database-badges').textContent).toBe('Events · History')
    expect(screen.queryByText('Snapshots only')).toBeNull()
  })
})
