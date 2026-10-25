import { describe, expect, it } from 'vitest'
import { alarmGateWords, panelAwareLookup } from '../alarm-gate-words.js'

describe('alarmGateWords', () => {
  it('pending and triggered also answer as the mode they belong to', () => {
    expect(alarmGateWords('pending', 'armed_away')).toEqual(['pending', 'armed_away'])
    expect(alarmGateWords('triggered', 'armed_night')).toEqual(['triggered', 'armed_night'])
  })
  it('arming does NOT answer as the mode — people are still leaving', () => {
    expect(alarmGateWords('arming', 'armed_away')).toEqual(['arming'])
  })
  it('a settled state is itself', () => {
    expect(alarmGateWords('armed_home', 'armed_home')).toEqual(['armed_home'])
    expect(alarmGateWords('disarmed', 'disarmed')).toEqual(['disarmed'])
  })
  it('a pending/triggered whose target is not an armed mode answers only itself', () => {
    expect(alarmGateWords('triggered', 'disarmed')).toEqual(['triggered'])
  })
})

describe('panelAwareLookup', () => {
  const PANEL = 900
  const OTHER = 77

  it('answers the panel words when the mirror agrees on the state', () => {
    const read = (id: number): string | undefined => (id === PANEL ? 'pending' : undefined)
    const lookup = panelAwareLookup(read, { deviceId: PANEL, words: ['pending', 'armed_away'] })
    expect(lookup(PANEL)).toEqual(['pending', 'armed_away'])
  })

  it('any other device answers its one cached word', () => {
    const read = (id: number): string | undefined => (id === OTHER ? 'on' : undefined)
    const lookup = panelAwareLookup(read, { deviceId: PANEL, words: ['pending', 'armed_away'] })
    expect(lookup(OTHER)).toEqual(['on'])
    expect(lookup(12345)).toBeUndefined()
  })

  it('an unreadable panel stays unreadable — the alias never un-gates a cold mirror (D49)', () => {
    const lookup = panelAwareLookup(() => undefined, {
      deviceId: PANEL,
      words: ['triggered', 'armed_away'],
    })
    expect(lookup(PANEL)).toBeUndefined()
  })

  it('a mirror that disagrees with the last publish answers the mirror alone', () => {
    // The target belongs to the state it was published with; paired with a
    // different state it is a guess.
    const read = (): string | undefined => 'disarmed'
    const lookup = panelAwareLookup(read, { deviceId: PANEL, words: ['triggered', 'armed_away'] })
    expect(lookup(PANEL)).toEqual(['disarmed'])
  })

  it('with no panel every device answers its cached word', () => {
    const lookup = panelAwareLookup(() => 'armed_away', null)
    expect(lookup(PANEL)).toEqual(['armed_away'])
  })
})
