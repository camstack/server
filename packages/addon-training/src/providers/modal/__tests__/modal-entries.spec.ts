/**
 * Provider entry helpers for Modal: migrate the legacy single-account settings into an entry
 * named "Default", heal missing ids, and validate credentials by entryId.
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_MODAL_ENTRY_NAME,
  ensureModalEntryIds,
  migrateLegacyModalConfig,
  normalizeModalEntry,
  type ModalEntriesConfig,
  type ModalEntryRecord,
} from '../modal-entries.js'
import { FakeTrainingProvider } from '../../fake/fake-provider.js'
import { MemoryPeerBytes } from '../../fake/memory-peer-bytes.js'

const LEGACY: ModalEntriesConfig = {
  entries: [],
  tokenId: 'ak-legacy',
  tokenSecret: 'as-legacy',
  environment: 'prod',
  gpuType: 'L4',
  region: '',
  costCapUsd: 5,
  maxRuntimeHours: 4,
  failedDatasetGraceHours: 24,
}

function blankEntry(overrides: Partial<ModalEntryRecord> = {}): ModalEntryRecord {
  return {
    id: 'entry-1',
    name: 'Home',
    tokenId: 'ak-1',
    tokenSecret: 'as-1',
    environment: '',
    gpuType: 'L4',
    region: '',
    costCapUsd: 5,
    maxRuntimeHours: 4,
    failedDatasetGraceHours: 24,
    ...overrides,
  }
}

describe('modal entry helpers', () => {
  it('migrates a legacy flat config into one Default entry', () => {
    const migrated = migrateLegacyModalConfig(LEGACY, () => 'entry-default')
    expect(migrated.entries).toHaveLength(1)
    const entry = migrated.entries[0]
    expect(entry?.id).toBe('entry-default')
    expect(entry?.name).toBe(DEFAULT_MODAL_ENTRY_NAME)
    expect(entry?.tokenId).toBe('ak-legacy')
    expect(entry?.tokenSecret).toBe('as-legacy')
    expect(entry?.environment).toBe('prod')
    expect(migrated.tokenId).toBe('')
    expect(migrated.tokenSecret).toBe('')
  })

  it('ensureModalEntryIds mints missing ids and leaves good ones alone', () => {
    const config: ModalEntriesConfig = {
      entries: [blankEntry({ id: '' }), blankEntry({ id: 'keep-me', name: 'Keep' })],
      tokenId: '',
      tokenSecret: '',
    }
    const fixed = ensureModalEntryIds(config, () => 'healed')
    expect(fixed.entries.map((e) => e.id)).toEqual(['healed', 'keep-me'])
    expect(ensureModalEntryIds(fixed, () => 'again')).toBe(fixed)
  })

  it('normalizeModalEntry fills omitted secret fields so describe can trim', () => {
    const entry = normalizeModalEntry({ id: 'e-1', name: 'Bare', tokenId: 'ak' })
    expect(entry.tokenSecret).toBe('')
    expect(entry.environment).toBe('')
    expect(typeof entry.tokenSecret === 'string' ? entry.tokenSecret.trim() : 'x').toBe('')
  })
})

describe('validateCredentials by entryId', () => {
  it('checks the named entry, not a sibling', async () => {
    const peer = new MemoryPeerBytes()
    const provider = new FakeTrainingProvider({
      peer,
      now: () => 1000,
      entries: [
        { entryId: 'ok-entry', name: 'OK', configured: true },
        { entryId: 'bare-entry', name: 'Bare', configured: false },
      ],
    })
    expect(await provider.validateCredentials({ entryId: 'ok-entry' })).toEqual({
      ok: true,
      account: 'fake-workspace',
    })
    expect(await provider.validateCredentials({ entryId: 'bare-entry' })).toEqual({
      ok: false,
      reason: 'missing',
    })
    expect(await provider.validateCredentials({ entryId: 'ghost' })).toEqual({
      ok: false,
      reason: 'missing',
      detail: 'unknown entry',
    })
  })
})
