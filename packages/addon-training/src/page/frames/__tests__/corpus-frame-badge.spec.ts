import { describe, expect, it } from 'vitest'
import { corpusFrameBadge } from '../corpus-frame-badge.js'

describe('corpusFrameBadge', () => {
  it('maps the three exclusive work states', () => {
    expect(corpusFrameBadge('unannotated')).toEqual({ labelKey: 'todo', variant: 'default' })
    expect(corpusFrameBadge('annotated')).toEqual({ labelKey: 'inProgress', variant: 'warning' })
    expect(corpusFrameBadge('complete')).toEqual({ labelKey: 'complete', variant: 'success' })
  })
})
