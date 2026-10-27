import { describe, expect, it } from 'vitest'
import { verdictOf } from '../composer-verdict.js'
import type { LiveComposition } from '../composer-verdict.js'

describe('composer verdict — incomplete', () => {
  const base: LiveComposition = {
    planned: {
      block: { id: 'b1', name: null, enabled: true, updatedAt: 0 },
      fields: [],
      events: [],
      problems: [
        'features[0].fields.temperature: `temperature-sensor.temperature` is required and has no source',
      ],
      declaration: null,
      shape: null,
      spec: null,
      target: { kind: 'new' },
    },
    device: null,
    runtime: null,
    appliedName: null,
    rebuildError: null,
    heldFields: [],
  }

  it('only-unfilled → incomplete', () => {
    const v = verdictOf('b1', base, false)
    expect(v.status).toBe('incomplete')
  })

  it('a real validation problem → still failed', () => {
    const entry: LiveComposition = {
      ...base,
      planned: {
        ...base.planned,
        problems: [...base.planned.problems, 'features[0].fields.temperature: cycle detected'],
      },
    }
    expect(verdictOf('b1', entry, false).status).toBe('failed')
  })

  it('disarm: without the incomplete branch only-unfilled would be failed', () => {
    const v = verdictOf('b1', base, false)
    expect(v.status).not.toBe('failed')
  })
})
