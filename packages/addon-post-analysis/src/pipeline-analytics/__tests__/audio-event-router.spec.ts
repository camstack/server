import { describe, it, expect } from 'vitest'
import { classifyAudioFrame } from '../audio-event-router'

const cfg = { classificationMinScore: 0.6, allowedClasses: [] }

describe('classifyAudioFrame', () => {
  it('routes a confident non-silence classification to a classification event', () => {
    expect(classifyAudioFrame({ className: 'dog', score: 0.7 }, cfg)).toEqual({
      kind: 'classification',
      className: 'dog',
      score: 0.7,
    })
  })
  it('routes a low-score classification to the level path', () => {
    expect(classifyAudioFrame({ className: 'dog', score: 0.4 }, cfg)).toEqual({
      kind: 'level',
    })
  })
  it('routes a silence classification to the level path regardless of score', () => {
    expect(classifyAudioFrame({ className: 'silence', score: 0.95 }, cfg)).toEqual({
      kind: 'level',
    })
  })
  it('routes a missing classification to the level path', () => {
    expect(classifyAudioFrame(undefined, cfg)).toEqual({ kind: 'level' })
  })
})

/**
 * The allowlist is the EVENT GENERATOR's policy, not the classifier's. The
 * classifier keeps reporting every macro class it hears with its score; this
 * gate decides which of them is allowed to become an event on this camera.
 */
describe('classifyAudioFrame — per-device class allowlist', () => {
  it('lets every class through when the allowlist is empty (unset = no policy)', () => {
    const open = { classificationMinScore: 0.6, allowedClasses: [] }
    expect(classifyAudioFrame({ className: 'dog', score: 0.7 }, open)).toEqual({
      kind: 'classification',
      className: 'dog',
      score: 0.7,
    })
  })

  it('routes a class absent from a non-empty allowlist to the level path', () => {
    const only = { classificationMinScore: 0.6, allowedClasses: ['doorbell'] }
    expect(classifyAudioFrame({ className: 'dog', score: 0.95 }, only)).toEqual({ kind: 'level' })
  })

  it('keeps a listed class that also clears the score', () => {
    const only = {
      classificationMinScore: 0.6,
      allowedClasses: ['doorbell', 'dog'],
    }
    expect(classifyAudioFrame({ className: 'dog', score: 0.7 }, only)).toEqual({
      kind: 'classification',
      className: 'dog',
      score: 0.7,
    })
  })

  it('still drops a listed class that fails the score — the two gates compose', () => {
    const only = { classificationMinScore: 0.6, allowedClasses: ['dog'] }
    expect(classifyAudioFrame({ className: 'dog', score: 0.4 }, only)).toEqual({
      kind: 'level',
    })
  })
})
