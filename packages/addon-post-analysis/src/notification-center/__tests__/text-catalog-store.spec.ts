/**
 * NcTextCatalogStore — the ONE durable document behind the hub language.
 *
 * What these pin down:
 *  - an empty store answers the DEFAULT snapshot rather than throwing, because
 *    the shipped files are a complete catalog on their own and a hub that has
 *    never opened the settings page must still speak;
 *  - a malformed or unknown language degrades to English with a warning; it can
 *    never leave a notification textless;
 *  - a failed read keeps the snapshot already in memory, exactly like the
 *    snooze and device-mute stores.
 */

import { ncRecordKinds } from '../record-kinds.js'
import { makeNcRecords, ncTable } from './support/nc-test-deps.js'
import type { InMemoryRecords } from '@camstack/types'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  makeLogRecorder,
  makeSilentLogger,
} from '../../pipeline-analytics/__tests__/test-helpers.js'
import { NcTextCatalog } from '../text-catalog.js'
import { NC_RETIRED_TEXT_KEYS, NC_TEXTS_DOC_ID, NcTextCatalogStore } from '../text-catalog-store.js'

describe('NcTextCatalogStore', () => {
  let world: InMemoryRecords
  let store: NcTextCatalogStore

  beforeEach(async () => {
    world = makeNcRecords()
    store = new NcTextCatalogStore({
      kind: world.records.kind(ncRecordKinds.texts),
      logger: makeSilentLogger(),
    })
  })

  it('an empty store answers the default snapshot — English, no overrides', async () => {
    await expect(store.load()).resolves.toEqual({ language: 'en', overrides: {} })
  })

  it('persists the language and reads it back', async () => {
    await store.setLanguage('it')
    const fresh = new NcTextCatalogStore({
      kind: world.records.kind(ncRecordKinds.texts),
      logger: makeSilentLogger(),
    })
    await expect(fresh.load()).resolves.toEqual({ language: 'it', overrides: {} })
  })

  it('persists overrides alongside the language', async () => {
    await store.setLanguage('it')
    await store.setOverrides({ it: { 'occupancy.op.free': 'vuota' } })
    const fresh = new NcTextCatalogStore({
      kind: world.records.kind(ncRecordKinds.texts),
      logger: makeSilentLogger(),
    })
    await expect(fresh.load()).resolves.toEqual({
      language: 'it',
      overrides: { it: { 'occupancy.op.free': 'vuota' } },
    })
  })

  it('setting overrides does not clear the language, and vice versa', async () => {
    await store.setOverrides({ en: { 'occupancy.op.free': 'empty' } })
    await store.setLanguage('it')
    await expect(store.load()).resolves.toEqual({
      language: 'it',
      overrides: { en: { 'occupancy.op.free': 'empty' } },
    })
  })

  it('a row with an unknown language degrades to English rather than throwing', async () => {
    world.seed('texts', { id: NC_TEXTS_DOC_ID, data: { language: 'klingon', overrides: {} } })
    await expect(store.load()).resolves.toEqual({ language: 'en', overrides: {} })
  })

  it('a FAILED read keeps the snapshot already in memory', async () => {
    await store.setLanguage('it')
    const unlucky = new NcTextCatalogStore({
      kind: world.records.kind(ncRecordKinds.texts),
      logger: makeSilentLogger(),
    })
    // First read lands…
    await expect(unlucky.load()).resolves.toEqual({ language: 'it', overrides: {} })
    world.failReads(true)
    // …the second falls over, and the household stays Italian rather than
    // being switched back to English by a transient error.
    await expect(unlucky.load()).resolves.toEqual({ language: 'it', overrides: {} })
    expect(unlucky.snapshot.language).toBe('it')
  })

  it('the loaded snapshot drives a catalog end to end', async () => {
    await store.setLanguage('it')
    await store.setOverrides({ it: { 'occupancy.op.free': 'vuota' } })
    const texts = new NcTextCatalog()
    texts.apply(await store.load())
    expect(texts.language).toBe('it')
    expect(texts.raw('occupancy.op.free')).toBe('vuota')
    expect(texts.raw('occupancy.op.occupied')).toBe('occupata')
  })

  // D692: `detection.body.enhanced` left the shipped catalog with the recognition upgrade. An
  // operator override of it would sit in the document forever, because the editor refuses keys
  // it does not know.
  describe('retired keys (D692)', () => {
    const seed = async (): Promise<void> => {
      world.seed('texts', {
        id: NC_TEXTS_DOC_ID,
        data: {
          language: 'it',
          overrides: {
            it: { 'detection.body.enhanced': 'ora lo conosco', 'occupancy.op.free': 'vuota' },
            en: { 'detection.body.enhanced': 'now known' },
          },
        },
      })
    }

    it('names the one key it retires', () => {
      expect(NC_RETIRED_TEXT_KEYS).toEqual(['detection.body.enhanced'])
    })

    it('load DROPS an override of a retired key, in every language, and keeps the others', async () => {
      await seed()
      await expect(store.load()).resolves.toEqual({
        language: 'it',
        overrides: { it: { 'occupancy.op.free': 'vuota' } },
      })
    })

    it('says so ONCE per key per process, at INFO, and never writes back on load', async () => {
      await seed()
      const rec = makeLogRecorder()
      const loud = new NcTextCatalogStore({
        kind: world.records.kind(ncRecordKinds.texts),
        logger: rec.logger,
      })
      await loud.load()
      await loud.load()
      const lines = rec.entries.filter((e) => e.message.includes('retired text override'))
      expect(lines.map((l) => l.level)).toEqual(['info'])
      expect(lines[0]?.extras?.meta).toMatchObject({ key: 'detection.body.enhanced' })
      const stored = ncTable(world, 'texts').get(NC_TEXTS_DOC_ID)
      expect(JSON.stringify(stored)).toContain('ora lo conosco')
    })

    it('a language whose only override was retired ends up with none', async () => {
      world.seed('texts', {
        id: NC_TEXTS_DOC_ID,
        data: { language: 'en', overrides: { en: { 'detection.body.enhanced': 'now known' } } },
      })
      await expect(store.load()).resolves.toEqual({ language: 'en', overrides: {} })
    })
  })
})
