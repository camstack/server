import { describe, expect, it } from 'vitest'
import { decideAgentBootMode } from '../agent-boot-mode.js'

describe('decideAgentBootMode', () => {
  it('an unpaired agent boots no addons: there is no hub to read settings from', () => {
    expect(decideAgentBootMode({ paired: false, hubAddress: null })).toBe('pairing-only')
  })
  it('a paired agent with a hub address boots in full', () => {
    expect(decideAgentBootMode({ paired: true, hubAddress: '192.0.2.9' })).toBe('full')
  })
  it.each([null, undefined, '', '  '])(
    'a paired agent with no hub address (%j) waits for one instead of crash-looping (#494)',
    (hubAddress) => {
      expect(decideAgentBootMode({ paired: true, hubAddress })).toBe('awaiting-hub')
    },
  )
})
