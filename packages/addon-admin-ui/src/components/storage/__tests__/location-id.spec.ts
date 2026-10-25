/**
 * Unit tests for the wizard's id-generation helpers.
 *
 * The persisted record's `id` follows `^[a-z][a-z0-9-]*:[a-z0-9-]+$`.
 * `buildLocationId` derives a candidate from the user's display name;
 * the regression risk is producing strings that fail
 * `StorageLocationSchema.id.parse(...)` — these tests pin the
 * acceptable transforms.
 */
import { describe, expect, it } from 'vitest'
import { buildLocationId, slugifyDisplayName } from '../location-id'

describe('slugifyDisplayName', () => {
  it('lowercases and replaces non-alphanumerics with hyphens', () => {
    expect(slugifyDisplayName('NAS Backup 01')).toBe('nas-backup-01')
  })

  it('strips leading/trailing hyphens', () => {
    expect(slugifyDisplayName('  -- Hello! --  ')).toBe('hello')
  })

  it('returns empty string for whitespace-only input', () => {
    expect(slugifyDisplayName('   ')).toBe('')
  })

  it('collapses runs of separators into a single hyphen', () => {
    expect(slugifyDisplayName('foo___bar  baz')).toBe('foo-bar-baz')
  })

  it('returns empty for punctuation-only input', () => {
    expect(slugifyDisplayName('!!!')).toBe('')
  })
})

describe('buildLocationId', () => {
  it('joins type and slug with a colon', () => {
    expect(buildLocationId('backups', 'NAS Backup 01')).toBe('backups:nas-backup-01')
  })

  it('falls back to "default" when the slug is empty', () => {
    expect(buildLocationId('backups', '   ')).toBe('backups:default')
    expect(buildLocationId('recordings', '!!!')).toBe('recordings:default')
  })

  it('matches the StorageLocationSchema.id regex for normal inputs', () => {
    const re = /^[a-z][a-z0-9-]*:[a-z0-9-]+$/
    expect(re.test(buildLocationId('backups', 'NAS Backup 01'))).toBe(true)
    expect(re.test(buildLocationId('recordings-high', 'Camera Hot Drive'))).toBe(true)
    expect(re.test(buildLocationId('event-images', '   '))).toBe(true)
  })
})
