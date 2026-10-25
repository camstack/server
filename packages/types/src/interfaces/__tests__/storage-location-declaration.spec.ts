import { describe, it, expect } from 'vitest'
import { StorageLocationDeclarationSchema } from '../storage-location-declaration.js'

describe('StorageLocationDeclarationSchema', () => {
  it('parses a minimal declaration (defaultRoot omitted → treated as data)', () => {
    const d = StorageLocationDeclarationSchema.parse({
      id: 'recordings',
      displayName: 'Recordings',
      cardinality: 'multi',
    })
    expect(d).toEqual({ id: 'recordings', displayName: 'Recordings', cardinality: 'multi' })
    expect(d.defaultRoot).toBeUndefined()
  })
  it('accepts description + defaultsTo', () => {
    const d = StorageLocationDeclarationSchema.parse({
      id: 'recordingsLow',
      displayName: 'Recordings (Low)',
      cardinality: 'multi',
      description: 'Low + scrub.',
      defaultsTo: 'recordings',
    })
    expect(d.defaultsTo).toBe('recordings')
  })
  it('accepts defaultRoot: media', () => {
    const d = StorageLocationDeclarationSchema.parse({
      id: 'recordings',
      displayName: 'Recordings',
      cardinality: 'multi',
      defaultRoot: 'media',
    })
    expect(d.defaultRoot).toBe('media')
  })
  it('rejects an unknown defaultRoot', () => {
    expect(
      StorageLocationDeclarationSchema.safeParse({
        id: 'x',
        displayName: 'x',
        cardinality: 'multi',
        defaultRoot: 'nas',
      }).success,
    ).toBe(false)
  })
  it('rejects an empty id', () => {
    expect(
      StorageLocationDeclarationSchema.safeParse({
        id: '',
        displayName: 'x',
        cardinality: 'single',
      }).success,
    ).toBe(false)
  })
  it('rejects an unknown cardinality', () => {
    expect(
      StorageLocationDeclarationSchema.safeParse({ id: 'x', displayName: 'x', cardinality: 'many' })
        .success,
    ).toBe(false)
  })
})
