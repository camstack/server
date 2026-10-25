import { describe, expect, it } from 'vitest'
import { shapeSections, shownTab } from '../settings-section-shape'

const SECTIONS = [
  {
    id: 'cluster-step-models',
    title: 'Enrichment models',
    description: 'long',
    tab: 'pipeline',
    fields: [{ key: 'clusterModel:face-embedding' }, { key: 'clusterModel:clip-embedding' }],
  },
  { id: 'hwaccel', title: 'Hardware acceleration', tab: 'decoder', fields: [{ key: 'hwaccel' }] },
]

describe('shapeSections', () => {
  it('keeps only the named fields and drops a section left empty', () => {
    const out = shapeSections(SECTIONS, { fieldKeys: ['clusterModel:face-embedding'] })
    expect(out).toHaveLength(1)
    expect(out[0]?.fields).toEqual([{ key: 'clusterModel:face-embedding' }])
  })

  it('strips the section chrome when the host draws its own title', () => {
    const [first] = shapeSections(SECTIONS, { hideSectionChrome: true })
    expect(first?.title).toBe('')
    expect(first?.description).toBeUndefined()
  })

  it('moves a section onto an aliased tab, and leaves the rest', () => {
    const out = shapeSections(SECTIONS, { tabAliases: { decoder: 'engine' } })
    expect(out.map((s) => s.tab)).toEqual(['pipeline', 'engine'])
    expect(shownTab(undefined, { general: 'x' })).toBe('x')
    expect(shownTab('decoder')).toBe('decoder')
  })
})
