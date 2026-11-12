import { describe, expect, it } from 'vitest'
import {
  assertDeviceOffers,
  findVocabAction,
  VocabActionError,
  vocabCall,
} from '../action-index.js'

describe('vocabCall — the one place an action id becomes a cap method', () => {
  it('names the cap and method of the action and merges the baked args over the step args', () => {
    const found = findVocabAction('switch.on')
    expect(found).toBeDefined()
    expect(vocabCall('switch.on', { note: 'x', on: false })).toEqual({
      cap: found?.cap,
      method: found?.action.method,
      args: { note: 'x', on: true },
    })
  })

  it('treats a step with no args as an empty bag', () => {
    expect(vocabCall('cover.stop', undefined).args).toEqual({})
  })

  it('refuses an unknown action with the typed reason', () => {
    try {
      vocabCall('cover.teleport', {})
      throw new Error('expected a refusal')
    } catch (err) {
      expect(err).toBeInstanceOf(VocabActionError)
      expect(err).toMatchObject({ reason: 'unknown-action', actionId: 'cover.teleport' })
    }
  })
})

describe('assertDeviceOffers', () => {
  it('passes when the device is bound to the cap of the action', () => {
    expect(() => assertDeviceOffers('cover.open', 7, ['cover', 'battery'])).not.toThrow()
  })

  it('refuses a device that does not offer the action, naming the reason and the device', () => {
    try {
      assertDeviceOffers('cover.open', 7, ['switch'])
      throw new Error('expected a refusal')
    } catch (err) {
      expect(err).toBeInstanceOf(VocabActionError)
      expect(err).toMatchObject({ reason: 'not-offered', actionId: 'cover.open', deviceId: 7 })
    }
  })

  it('refuses an unknown action before looking at the device', () => {
    expect(() => assertDeviceOffers('nope.nope', 7, ['cover'])).toThrow(
      expect.objectContaining({ reason: 'unknown-action' }),
    )
  })
})
