/**
 * Provider entry store for Modal: create / list / delete, migrate the
 * legacy single-account settings into an entry named "Default", and
 * validate credentials by entryId.
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_MODAL_ENTRY_NAME,
  MODAL_TYPE_ID,
  createModalEntry,
  deleteModalEntry,
  effectiveModalEntries,
  ensureModalEntryIds,
  findModalEntry,
  migrateLegacyModalConfig,
  normalizeModalEntry,
  updateModalEntry,
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

describe('modal entry store', () => {
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

  it('create / list / delete entries by id', () => {
    let config: ModalEntriesConfig = { entries: [], tokenId: '', tokenSecret: '' }
    const created = createModalEntry(config, { typeId: MODAL_TYPE_ID, name: 'Lab' }, () => 'e-lab')
    expect(created.ok).toBe(true)
    if (!created.ok) return
    config = created.config
    expect(effectiveModalEntries(config).map((e) => e.id)).toEqual(['e-lab'])
    expect(findModalEntry(config, 'e-lab')?.name).toBe('Lab')

    const second = createModalEntry(
      config,
      { typeId: MODAL_TYPE_ID, name: 'Cloud' },
      () => 'e-cloud',
    )
    expect(second.ok).toBe(true)
    if (!second.ok) return
    config = second.config
    expect(effectiveModalEntries(config).map((e) => e.name)).toEqual(['Lab', 'Cloud'])

    const removed = deleteModalEntry(config, 'e-lab')
    expect(removed.ok).toBe(true)
    if (!removed.ok) return
    config = removed.config
    expect(findModalEntry(config, 'e-lab')).toBeNull()
    expect(effectiveModalEntries(config).map((e) => e.id)).toEqual(['e-cloud'])
  })

  it('refuses create for an unknown typeId', () => {
    const config: ModalEntriesConfig = { entries: [], tokenId: '', tokenSecret: '' }
    const created = createModalEntry(config, { typeId: 'runpod', name: 'X' }, () => 'e-x')
    expect(created).toEqual({ ok: false, reason: 'unknown-type' })
  })

  it('refuses delete of an unknown entry', () => {
    const config: ModalEntriesConfig = {
      entries: [blankEntry()],
      tokenId: '',
      tokenSecret: '',
    }
    expect(deleteModalEntry(config, 'missing')).toEqual({ ok: false, reason: 'unknown-entry' })
  })

  it('createEntry always persists a generated id (never operator-supplied)', () => {
    const ids: string[] = []
    const created = createModalEntry(
      { entries: [], tokenId: '', tokenSecret: '' },
      { typeId: MODAL_TYPE_ID, name: 'Lab' },
      () => {
        const id = `minted-${String(ids.length + 1)}`
        ids.push(id)
        return id
      },
    )
    expect(created.ok).toBe(true)
    if (!created.ok) return
    expect(created.entryId).toBe('minted-1')
    expect(created.config.entries[0]?.id).toBe('minted-1')
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

  it('updateModalEntry patches fields and keeps an empty tokenSecret', () => {
    const config: ModalEntriesConfig = {
      entries: [blankEntry({ tokenSecret: 'as-keep' })],
      tokenId: '',
      tokenSecret: '',
    }
    const updated = updateModalEntry(config, 'entry-1', {
      name: 'Renamed',
      tokenId: 'ak-2',
      tokenSecret: '',
      gpuType: 'H100',
      costCapUsd: 12,
      maxRuntimeHours: 8,
    })
    expect(updated.ok).toBe(true)
    if (!updated.ok) return
    const entry = findModalEntry(updated.config, 'entry-1')
    expect(entry?.name).toBe('Renamed')
    expect(entry?.tokenId).toBe('ak-2')
    expect(entry?.tokenSecret).toBe('as-keep')
    expect(entry?.gpuType).toBe('H100')
    expect(entry?.costCapUsd).toBe(12)
    expect(entry?.maxRuntimeHours).toBe(8)
  })

  it('updateModalEntry replaces tokenSecret when non-empty', () => {
    const config: ModalEntriesConfig = {
      entries: [blankEntry({ tokenSecret: 'as-old' })],
      tokenId: '',
      tokenSecret: '',
    }
    const updated = updateModalEntry(config, 'entry-1', { tokenSecret: 'as-new' })
    expect(updated.ok).toBe(true)
    if (!updated.ok) return
    expect(findModalEntry(updated.config, 'entry-1')?.tokenSecret).toBe('as-new')
  })

  it('refuses update of an unknown entry', () => {
    const config: ModalEntriesConfig = {
      entries: [blankEntry()],
      tokenId: '',
      tokenSecret: '',
    }
    expect(updateModalEntry(config, 'missing', { name: 'X' })).toEqual({
      ok: false,
      reason: 'unknown-entry',
    })
  })

  it('normalizeModalEntry fills omitted secret fields so describe can trim', () => {
    const entry = normalizeModalEntry({ id: 'e-1', name: 'Bare', tokenId: 'ak' })
    expect(entry.tokenSecret).toBe('')
    expect(entry.environment).toBe('')
    expect(typeof entry.tokenSecret === 'string' ? entry.tokenSecret.trim() : 'x').toBe('')
  })

  it('effectiveModalEntries normalizes stored rows missing tokenSecret', () => {
    const config: ModalEntriesConfig = {
      entries: [{ id: 'e-1', name: 'Bare' } as ModalEntryRecord],
      tokenId: '',
      tokenSecret: '',
    }
    const [entry] = effectiveModalEntries(config)
    expect(entry?.tokenSecret).toBe('')
    expect(entry?.tokenId).toBe('')
    expect(entry?.gpuType).toBe('L4')
  })

  it('delete of the synthetic legacy entry clears flat credential fields in the patch', () => {
    const removed = deleteModalEntry(LEGACY, 'legacy-default')
    expect(removed.ok).toBe(true)
    if (!removed.ok) return
    expect(removed.config.entries).toEqual([])
    expect(removed.config.tokenId).toBe('')
    expect(removed.config.tokenSecret).toBe('')
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
