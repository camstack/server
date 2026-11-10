import { describe, expect, it } from 'vitest'
import { awaitingHubBoot, decideAgentBootMode } from '../agent-boot-mode.js'

describe('decideAgentBootMode', () => {
  it('an unpaired agent boots no addons: there is no hub to read settings from', () => {
    expect(decideAgentBootMode({ paired: false, hubAddress: null })).toBe('pairing-only')
  })
  it('a paired agent with a hub address boots in full', () => {
    expect(decideAgentBootMode({ paired: true, hubAddress: '192.0.2.9' })).toBe('full')
  })
  it.each([
    null,
    undefined,
    '',
    '  ',
  ])('a paired agent with no hub address (%j) waits for one instead of crash-looping (#494)', (hubAddress) => {
    expect(decideAgentBootMode({ paired: true, hubAddress })).toBe('awaiting-hub')
  })
})

describe('awaitingHubBoot', () => {
  it('browses before the broker and keeps watching, and a later address relaunches', () => {
    expect(awaitingHubBoot({ paired: true, hubAddress: null })).toEqual({
      rediscoverBeforeBroker: true,
      watchUntilFound: true,
      onReconnect: 'relaunch',
    })
  })

  it('an unpaired agent does not browse and does not relaunch on restart: pairing relaunches on its own', () => {
    expect(awaitingHubBoot({ paired: false, hubAddress: null })).toEqual({
      rediscoverBeforeBroker: false,
      watchUntilFound: false,
      onReconnect: 'reconnect',
    })
  })

  it('a paired agent that already has an address dials it and only replaces the transport', () => {
    expect(awaitingHubBoot({ paired: true, hubAddress: '192.0.2.9' })).toEqual({
      rediscoverBeforeBroker: false,
      watchUntilFound: false,
      onReconnect: 'reconnect',
    })
  })
})
