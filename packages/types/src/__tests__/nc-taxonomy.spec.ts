import { describe, it, expect } from 'vitest'
import { buildNcTaxonomy, NC_TAXONOMY, NcTaxonomySchema } from '../catalogs/nc-taxonomy.js'

describe('nc-taxonomy — derived NC picker vocabulary', () => {
  it('parses against its own schema', () => {
    expect(() => NcTaxonomySchema.parse(NC_TAXONOMY)).not.toThrow()
  })

  it('videoClasses carry detection macros and subs with parent links', () => {
    const { videoClasses } = buildNcTaxonomy()
    const kinds = new Set(videoClasses.map((e) => e.kind))
    expect(kinds.has('person')).toBe(true)
    expect(kinds.has('vehicle')).toBe(true)
    expect(kinds.has('animal')).toBe(true)
    const car = videoClasses.find((e) => e.kind === 'car')
    expect(car?.parentKind).toBe('vehicle')
    const dog = videoClasses.find((e) => e.kind === 'dog')
    expect(dog?.parentKind).toBe('animal')
    // Macros are their own top (no parent).
    expect(videoClasses.find((e) => e.kind === 'person')?.parentKind).toBeNull()
  })

  it('audioKinds are the namespaced audio subs only', () => {
    const { audioKinds } = buildNcTaxonomy()
    expect(audioKinds.length).toBeGreaterThan(0)
    expect(audioKinds.every((e) => e.kind.startsWith('audio-'))).toBe(true)
    expect(audioKinds.some((e) => e.kind === 'audio-scream')).toBe(true)
    expect(audioKinds.some((e) => e.kind === 'audio-glass_breaking')).toBe(true)
    // No detection/sensor kinds leak in.
    expect(audioKinds.some((e) => e.kind === 'person')).toBe(false)
  })

  it('labels are the sensor + control taxonomy kinds', () => {
    const { labels } = buildNcTaxonomy()
    const kinds = new Set(labels.map((e) => e.kind))
    expect(kinds.has('doorbell')).toBe(true)
    expect(kinds.has('contact')).toBe(true)
    expect(kinds.has('lock')).toBe(true)
    // Sensor vs control grouping is recoverable from parentKind.
    expect(labels.find((e) => e.kind === 'doorbell')?.parentKind).toBe('control')
    expect(labels.find((e) => e.kind === 'contact')?.parentKind).toBe('sensor')
  })
})
