/**
 * A power-source row stored in a spelling the strict decoder does not
 * reproduce is still a LINK: its one source is recovered, so Edit opens the
 * link dialog and not the formula editor.
 */
import { CAP_CUSTOMIZE_CATALOG, type CompositionFieldsFeature } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { decodeLooseSourceLink } from '../override-link-decode'

const target = CAP_CUSTOMIZE_CATALOG['power-source']?.targets.find((t) => t.id === 'switch')
const SOURCE = { addonId: 'provider-unifi', stableId: 'port-3' }

describe('decodeLooseSourceLink', () => {
  it('recovers the source of a stored plain link', () => {
    expect(target).toBeDefined()
    if (target === undefined) return
    const feature: CompositionFieldsFeature = {
      kind: 'fields',
      cap: 'power-source',
      fields: {
        switchOn: { kind: 'from', source: SOURCE, cap: 'switch', fieldPath: 'on' },
        offSeconds: { kind: 'expression', expr: '0', bindings: {} },
      },
    }
    const decoded = decodeLooseSourceLink(feature, 'power-source', target)
    expect(decoded?.draft.source).toEqual({ ...SOURCE, cap: 'switch', fieldPath: 'on' })
    expect(decoded?.apply).toBe('add')
  })

  it('a formula with no source link is not a link', () => {
    if (target === undefined) return
    const feature: CompositionFieldsFeature = {
      kind: 'fields',
      cap: 'power-source',
      fields: { switchOn: { kind: 'expression', expr: 'true', bindings: {} } },
    }
    expect(decodeLooseSourceLink(feature, 'power-source', target)).toBeNull()
  })
})
