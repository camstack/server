/**
 * A command whose argument is a list the device answers (a `dynamic` offer) is
 * withdrawn only when that read ANSWERED an empty list. A read that failed or
 * is still pending keeps it offered: unknown is not absent (D315).
 */
import { describe, expect, it } from 'vitest'
import { DeviceType } from '../../device-type.js'
import {
  type DynamicOfferAnswer,
  actionOfferedWith,
  actionsForDevice,
  offeredActionsWith,
} from '../resolve.js'
import type { LooseDynamicOffer } from '../types.js'

const sirenActions = actionsForDevice(['siren'], DeviceType.Siren)
const ids = (answer: DynamicOfferAnswer): readonly string[] =>
  offeredActionsWith(sirenActions, () => answer).map((a) => a.id)

describe('offeredActionsWith — a dynamic argument the device answered', () => {
  it('the siren offers both trigger commands before any answer', () => {
    expect(sirenActions.map((a) => a.id)).toContain('siren.triggerPlays')
  })

  it('a siren that answers no play counts (Hikvision) is not offered "sound N times"', () => {
    const offered = ids({ kind: 'answered', choiceCount: 0 })
    expect(offered).not.toContain('siren.triggerPlays')
    expect(offered).toContain('siren.trigger')
    expect(offered).toContain('siren.stop')
  })

  it('a siren with play counts (Reolink) is offered it', () => {
    expect(ids({ kind: 'answered', choiceCount: 3 })).toContain('siren.triggerPlays')
  })

  it('a read that failed or is pending keeps it offered — unknown is not absent', () => {
    expect(ids({ kind: 'failed' })).toContain('siren.triggerPlays')
    expect(ids({ kind: 'pending' })).toContain('siren.triggerPlays')
  })

  it('asks the answer of the read the argument names, on the action cap', () => {
    const asked: string[] = []
    const triggerPlays = sirenActions.find((a) => a.id === 'siren.triggerPlays')
    expect(triggerPlays).toBeDefined()
    if (triggerPlays === undefined) return
    actionOfferedWith(triggerPlays, (cap: string, offer: LooseDynamicOffer) => {
      asked.push(`${cap}.${offer.from === 'method' ? offer.method : offer.field}`)
      return { kind: 'pending' }
    })
    expect(asked).toEqual(['siren.getPlayChoices'])
  })
})
