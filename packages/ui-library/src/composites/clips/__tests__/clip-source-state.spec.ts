/**
 * The five source states, each in its OWN words.
 *
 * This is the whole point of the external-videoclips line (D549 § 7b): an
 * empty clip list is ambiguous, and every one of these states used to render
 * as "no clips". A camera with no SD card (106) is not a quiet camera; a
 * camera whose own calendar marks a day present and then lists nothing (108,
 * 6–20 September) is a camera with a broken index, not an empty one; a
 * sleeping battery camera is showing you a CACHE.
 *
 * So the assertions are on DISTINCTNESS and on the words, not on a tone enum:
 * a test that only checked `tone` would pass with all five saying "no clips"
 * in three colours.
 */
import { describe, expect, it } from 'vitest'
import type { ClipSource } from '@camstack/types'
import { describeSource, formatCatalogAge } from '../clip-source-state.js'

type SourceState = ClipSource['availability']['state']

function source(state: SourceState, reason?: string): ClipSource {
  return {
    source: 'native:reolink:onboard',
    label: 'SD card',
    availability: { state, ...(reason === undefined ? {} : { reason }) },
  }
}

describe('describeSource', () => {
  it('gives each state its own headline — no two states share words', () => {
    const states = ['ok', 'sleeping', 'unreachable', 'no-storage', 'index-empty'] as const
    const headlines = states.map((state) => describeSource(source(state)).headline)
    expect(new Set(headlines).size).toBe(states.length)
  })

  it('never says "no clips" for a camera that was not asked', () => {
    for (const state of ['sleeping', 'unreachable', 'no-storage', 'index-empty'] as const) {
      const notice = describeSource(source(state))
      expect(notice.headline.toLowerCase()).not.toContain('no clips')
    }
  })

  it('no-storage is about the CARD, index-empty is about the INDEX', () => {
    expect(describeSource(source('no-storage')).headline).toMatch(/card|storage/i)
    const indexEmpty = describeSource(source('index-empty')).headline
    expect(indexEmpty).toMatch(/index|calendar/i)
  })

  it('carries the provider reason VERBATIM, never re-worded', () => {
    const notice = describeSource({
      source: 'native:reolink:hub',
      label: 'Home Hub',
      availability: {
        state: 'unreachable',
        reason: 'library parser for the events view is not landed',
      },
    })
    expect(notice.detail).toBe('library parser for the events view is not landed')
  })

  it('says which sources CONTRIBUTED rows and which are silent', () => {
    expect(describeSource(source('ok')).answered).toBe(true)
    // A sleeping camera still serves its persisted catalog (D549 4).
    expect(describeSource(source('sleeping')).answered).toBe(true)
    for (const state of ['unreachable', 'no-storage', 'index-empty'] as const) {
      expect(describeSource(source(state)).answered).toBe(false)
    }
  })

  it('a sleeping source is warn, an unreachable one is an error, ok is neither', () => {
    expect(describeSource(source('ok')).tone).toBe('ok')
    expect(describeSource(source('sleeping')).tone).toBe('warn')
    expect(describeSource(source('unreachable')).tone).toBe('error')
  })
})

describe('formatCatalogAge', () => {
  it('is null when the source did not say — never "now"', () => {
    expect(formatCatalogAge(undefined, Date.parse('2026-09-20T10:00:00Z'))).toBeNull()
  })

  it('names the age of a cached catalog', () => {
    const now = Date.parse('2026-09-20T10:00:00Z')
    expect(formatCatalogAge(now - 90_000, now)).toMatch(/1 min/)
    expect(formatCatalogAge(now - 3 * 3_600_000, now)).toMatch(/3 h/)
  })
})
