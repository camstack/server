/**
 * The host-widget guard scans sources that can DECLARE a widget. A spec's
 * fixture ids are test data: they must neither fail the guard for a widget no
 * one ships nor keep a dead registry entry alive.
 */
import { describe, expect, it } from 'vitest'
import { isDeclarerSource } from '../check-host-widget-resolves.js'

describe('isDeclarerSource', () => {
  it('scans production TypeScript', () => {
    expect(isDeclarerSource('motion-zones.cap.ts')).toBe(true)
    expect(isDeclarerSource('HeroCard.tsx')).toBe(true)
  })

  it('skips specs and tests', () => {
    expect(isDeclarerSource('hero-widgets.spec.ts')).toBe(false)
    expect(isDeclarerSource('Hero.test.tsx')).toBe(false)
  })

  it('skips what is not TypeScript', () => {
    expect(isDeclarerSource('README.md')).toBe(false)
  })
})
