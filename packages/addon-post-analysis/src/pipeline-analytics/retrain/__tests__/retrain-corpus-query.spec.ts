import { describe, expect, it } from 'vitest'
import { workStateOf } from '../retrain-corpus-query.js'

describe('workStateOf', () => {
  it('unannotated when annotationCount is 0 regardless of complete flag misuse', () => {
    expect(workStateOf({ complete: false }, 0)).toBe('unannotated')
    expect(workStateOf({ complete: true }, 0)).toBe('unannotated')
  })
  it('annotated when count>0 and not complete', () => {
    expect(workStateOf({ complete: false }, 2)).toBe('annotated')
  })
  it('complete only when complete===true and count>0', () => {
    expect(workStateOf({ complete: true }, 1)).toBe('complete')
  })
})
