/**
 * Provider entry helpers for Modal: normalise an entry and validate credentials by entryId.
 */
import { describe, expect, it } from 'vitest'
import {
  normalizeModalEntry,
  type ModalEntriesConfig,
  type ModalEntryRecord,
} from '../modal-entries.js'
import { FakeTrainingProvider } from '../../fake/fake-provider.js'
import { MemoryPeerBytes } from '../../fake/memory-peer-bytes.js'

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
