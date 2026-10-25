/**
 * A type with a REAL hero card must not be routed to the placeholder.
 *
 * Written after exactly that: `DeviceType.AlarmPanel` sat on `DummyHero` while
 * `alarm-hero-card.tsx` had existed in ui-library the whole time, keyed `alarm`
 * in the control registry. The one device whose state matters most — armed,
 * triggered, disarmed — rendered "Controls coming soon", and nothing said so.
 *
 * This is the guard rather than a paragraph: the type→control-kind decision in
 * @camstack/types already says which types have a real card, so the two maps
 * can be compared instead of trusted.
 *
 * The guard has since done its job twice: `Script` and `Automation` were the
 * remaining `dummy` kinds, and the moment they stopped being `dummy` this test
 * failed with `stranded: ['script']` until the registry entry followed.
 */

import { DeviceType, resolveDeviceControlKind } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { ControlHero } from '../ControlHero'
import { DummyHero } from '../DummyHero'
import { GenericHero } from '../GenericHero'
import { resolveHero } from '../HeroRegistry'

/**
 * Types this registry deliberately does not route. `Camera` never reaches it —
 * DeviceDetail sends cameras to the stream panel directly.
 */
const NOT_ROUTED_HERE: readonly DeviceType[] = [DeviceType.Camera]

describe('every type with a real hero card gets it', () => {
  it('never leaves a card-carrying type on the placeholder', () => {
    const stranded: string[] = []
    for (const type of Object.values(DeviceType)) {
      if (NOT_ROUTED_HERE.includes(type)) continue
      // The type→kind decision is single-sourced in @camstack/types. A kind
      // other than `dummy` means ui-library HAS a real card for it — the
      // dummy kind carries a HeroCard too, so "a card exists" is not the
      // question, "which kind" is.
      const kind = resolveDeviceControlKind(type)
      if (kind === null || kind === 'dummy') continue
      const hero = resolveHero(type)
      if (hero === DummyHero || hero === GenericHero) stranded.push(String(type))
    }
    expect(stranded).toEqual([])
  })

  it('routes the alarm panel to a real hero', () => {
    // The specific regression, named so a future reader sees the case and not
    // only the rule.
    expect(resolveHero(DeviceType.AlarmPanel)).not.toBe(DummyHero)
  })

  it('routes Dishwasher to ControlHero', () => {
    expect(resolveHero(DeviceType.Dishwasher)).toBe(ControlHero)
  })

  it('routes Script and Automation to a real hero', () => {
    // Same shape as the alarm: both carried a cap with real runtime state
    // (`script-runner`, `automation-control`) while rendering "Controls coming
    // soon" — the operator could see a script existed and not run it.
    expect(resolveHero(DeviceType.Script)).not.toBe(DummyHero)
    expect(resolveHero(DeviceType.Automation)).not.toBe(DummyHero)
  })
})
