import { describe, expect, it } from 'vitest'
import { decideAgentBootMode } from '../agent-boot-mode.js'

describe('decideAgentBootMode', () => {
  it('an unpaired agent boots no addons: there is no hub to read settings from', () => {
    expect(decideAgentBootMode({ paired: false })).toBe('pairing-only')
  })
  it('a paired agent boots in full', () => {
    expect(decideAgentBootMode({ paired: true })).toBe('full')
  })
})
