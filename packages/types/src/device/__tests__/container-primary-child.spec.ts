import { describe, expect, it } from 'vitest'
import {
  CONTAINER_CHILD_PRIORITY,
  resolveContainerPrimaryChild,
} from '../container-primary-child.js'

/**
 * One definition of "which child IS the container", in the package everything
 * already depends on. Three copies of this list existed — admin-ui's renderer,
 * the Home Assistant adoption mapping and the viewer's panel — each with a
 * comment asking the others to stay in sync.
 */
import type { ContainerChildRef } from '../container-primary-child.js'

const child = (id: number, type: string, stableId = `s${String(id)}`): ContainerChildRef => ({
  id,
  stableId,
  type,
})

describe('resolveContainerPrimaryChild', () => {
  it('prefers the defining actuator over auxiliary switches', () => {
    const picked = resolveContainerPrimaryChild(
      [child(1, 'switch'), child(2, 'climate'), child(3, 'light')],
      undefined,
    )
    expect(picked?.type).toBe('climate')
  })

  it('prefers dishwasher over sensor children when no override is set', () => {
    const picked = resolveContainerPrimaryChild(
      [
        child(30, 'sensor', 'energy-sensor'),
        child(29, 'dishwasher', 'dishwasher-main'),
        { id: 31, stableId: 'door', type: 'sensor', role: 'binary-sensor', name: 'Door' },
      ],
      undefined,
    )
    expect(picked?.type).toBe('dishwasher')
    expect(picked?.id).toBe(29)
  })

  it('keeps siren BELOW switch — a camera siren is not what the container is', () => {
    expect(CONTAINER_CHILD_PRIORITY.indexOf('siren')).toBeGreaterThan(
      CONTAINER_CHILD_PRIORITY.indexOf('switch'),
    )
  })

  it("honours the operator's explicit pick over priority", () => {
    const picked = resolveContainerPrimaryChild(
      [child(1, 'climate', 'clima'), child(2, 'light', 'luce')],
      'luce',
    )
    expect(picked?.stableId).toBe('luce')
  })

  it('falls back to priority when the pick no longer exists', () => {
    // A re-sync that dropped the chosen entity must not leave the container
    // unrepresented — that is a blank row where a control belongs.
    const picked = resolveContainerPrimaryChild([child(1, 'climate'), child(2, 'light')], 'gone')
    expect(picked?.type).toBe('climate')
  })

  it('treats an explicit null pick as "no pick", not as "no child"', () => {
    expect(resolveContainerPrimaryChild([child(1, 'light')], null)?.type).toBe('light')
  })

  it('sorts an unknown type after every known one', () => {
    const picked = resolveContainerPrimaryChild(
      [child(1, 'quantum-flux'), child(2, 'sensor')],
      undefined,
    )
    expect(picked?.type).toBe('sensor')
  })

  it('answers null for a childless container rather than inventing one', () => {
    expect(resolveContainerPrimaryChild([], undefined)).toBeNull()
  })

  it('does not mutate the caller’s array', () => {
    const children = [child(1, 'switch'), child(2, 'climate')]
    resolveContainerPrimaryChild(children, undefined)
    expect(children[0]?.type).toBe('switch')
  })
})

/**
 * The key the pick is matched on.
 *
 * It is `stableId`, because that is the one identity present in EVERY
 * projection. Linked-devices resolution runs on the `slim` projection — chosen
 * to stop a measured 36 814-queries-per-minute config sweep — and `slim` does
 * not rebuild `sourceInfo`. Measured on the live hub, 677 of 925 container
 * children have a `sourceInfo.id` different from their `stableId`, so a
 * resolver keyed on `sourceInfo.id` would have missed the pick for three
 * children in four and quietly served the priority default instead.
 */
describe('the pick is keyed on stableId', () => {
  it('matches a pick against stableId', () => {
    const picked = resolveContainerPrimaryChild(
      [child(1, 'climate', 'gree:ac'), child(2, 'switch', 'gree:light')],
      'gree:light',
    )
    expect(picked?.id).toBe(2)
  })

  it('still resolves a pick stored under the LEGACY entityId key', () => {
    // A pick written before stableId became the key must keep working. It
    // decaying into the priority default would look exactly like an operator
    // who never chose anything.
    const picked = resolveContainerPrimaryChild(
      [
        { id: 1, stableId: 's1', type: 'climate' },
        { id: 2, stableId: 's2', entityId: 'ha:light.kitchen', type: 'light' },
      ],
      'ha:light.kitchen',
    )
    expect(picked?.id).toBe(2)
  })

  it('prefers the canonical key when both could match different children', () => {
    // Ambiguity resolves toward the key new picks are written as, never toward
    // the one being retired.
    const picked = resolveContainerPrimaryChild(
      [
        { id: 1, stableId: 'shared', type: 'sensor' },
        { id: 2, stableId: 's2', entityId: 'shared', type: 'climate' },
      ],
      'shared',
    )
    expect(picked?.id).toBe(1)
  })
})

describe('ordered criteria: role, then namesake, then type', () => {
  /**
   * THE LIVE CASE (container 4127, 2026-09-04). Home Assistant maps a door
   * contact, a battery level, a temperature reading and a "last seen" timestamp
   * all to `DeviceType.Sensor`, and the type list ranks `button` ABOVE `sensor`.
   * So the container stood for its "Identifica" button instead of the door
   * contact it is named after. The role is the thing that tells them apart.
   */
  const CONTAINER_4127: readonly ContainerChildRef[] = [
    { id: 4128, stableId: 'c-battery', type: 'sensor', role: 'battery-sensor', name: 'Batteria' },
    {
      id: 4129,
      stableId: 'c-temp',
      type: 'sensor',
      role: 'temperature-sensor',
      name: 'Temperatura',
    },
    { id: 4130, stableId: 'c-seen', type: 'sensor', role: 'datetime-sensor', name: 'Last seen' },
    {
      id: 4131,
      stableId: 'c-contact',
      type: 'sensor',
      role: 'contact-sensor',
      name: 'Contatto porta front door',
    },
    { id: 4337, stableId: 'c-identify', type: 'button', name: 'Identifica' },
  ]

  it('promotes the contact sensor over a role-less button that outranks it by type', () => {
    expect(resolveContainerPrimaryChild(CONTAINER_4127, null)?.id).toBe(4131)
  })

  it('still lets an explicit operator pick win over every criterion', () => {
    expect(resolveContainerPrimaryChild(CONTAINER_4127, 'c-identify')?.id).toBe(4337)
  })

  it('falls back to the namesake when no child carries a defining role', () => {
    const children: readonly ContainerChildRef[] = [
      { id: 1, stableId: 's1', type: 'sensor', role: 'battery-sensor', name: 'Batteria' },
      { id: 2, stableId: 's2', type: 'sensor', role: 'temperature-sensor', name: 'Luce patio' },
    ]
    expect(resolveContainerPrimaryChild(children, null, 'Luce patio')?.id).toBe(2)
  })

  it('a defining role beats the namesake — the role is the stronger statement', () => {
    const children: readonly ContainerChildRef[] = [
      { id: 1, stableId: 's1', type: 'sensor', role: 'contact-sensor', name: 'Contatto' },
      { id: 2, stableId: 's2', type: 'sensor', role: 'battery-sensor', name: 'Porta kitchen' },
    ]
    expect(resolveContainerPrimaryChild(children, null, 'Porta kitchen')?.id).toBe(1)
  })

  it('keeps type priority when no role and no namesake apply', () => {
    const children: readonly ContainerChildRef[] = [
      { id: 1, stableId: 's1', type: 'sensor', name: 'Batteria' },
      { id: 2, stableId: 's2', type: 'lock', name: 'Serratura' },
    ]
    expect(resolveContainerPrimaryChild(children, null)?.id).toBe(2)
  })

  it('a diagnostic role is never treated as defining', () => {
    const children: readonly ContainerChildRef[] = [
      { id: 1, stableId: 's1', type: 'sensor', role: 'temperature-sensor', name: 'Temperatura' },
      { id: 2, stableId: 's2', type: 'switch', role: undefined, name: 'Interruttore' },
    ]
    expect(resolveContainerPrimaryChild(children, null)?.id).toBe(2)
  })
})

describe('a generic role never outranks a real actuator type', () => {
  /**
   * REGRESSION, caught live within minutes of shipping the role tier
   * (container 1837, 2026-09-05). The container holds the actual lock — type
   * `lock`, features `['lock-open']` — next to a child named "Actuator" whose
   * only role is the generic `binary-sensor`. Ranking that role above type made
   * the container stand for the Actuator, and the operator's lock disappeared
   * from the panel.
   */
  it('picks the lock, not a child whose only role is the generic binary-sensor', () => {
    const children: readonly ContainerChildRef[] = [
      { id: 1840, stableId: 'lock', type: 'lock', name: 'Serratura front door' },
      { id: 1846, stableId: 'actuator', type: 'sensor', role: 'binary-sensor', name: 'Actuator' },
      { id: 1841, stableId: 'batt', type: 'sensor', role: 'battery-sensor', name: 'Batteria' },
    ]
    expect(resolveContainerPrimaryChild(children, null)?.id).toBe(1840)
  })

  it('still promotes a SUBJECT role over a button, which is the case the tier exists for', () => {
    const children: readonly ContainerChildRef[] = [
      { id: 4131, stableId: 'contact', type: 'sensor', role: 'contact-sensor', name: 'Contatto' },
      { id: 4337, stableId: 'identify', type: 'button', name: 'Identifica' },
    ]
    expect(resolveContainerPrimaryChild(children, null)?.id).toBe(4131)
  })
})

/**
 * THE ESPHOME SHUTTER — the namesake must not be decided by a hyphen.
 *
 * The operator, 2026-09-22: the shutters did not appear in the viewer's
 * accessory panel on kitchen, studio, or either porch camera. Read off the
 * live hub, container #1893 `Tapparella-Kitchen` has fourteen children,
 * including:
 *
 *   #1900  "Tapparella kitchen"   cover     role null
 *   #1907  "tapparella-kitchen"   presence  role null   ← the ESPHome slug
 *
 * Both role-less, so the namesake decided — and the slug carries the
 * container's name verbatim while the actuator has a space. The presence
 * entity won, the panel correctly drew nothing for it (no actuating control),
 * and the shutter was invisible.
 *
 * `Markise` is the control: there the cover IS named like its container, so it
 * won and did appear. Same rule, opposite outcome, same day.
 */
describe('a container named with separators still picks its actuator', () => {
  const cover = { id: 1900, stableId: 's-1900', type: 'cover', name: 'Tapparella kitchen' }
  const presence = { id: 1907, stableId: 's-1907', type: 'presence', name: 'tapparella-kitchen' }

  it('picks the COVER, not the slug-named presence entity', () => {
    expect(
      resolveContainerPrimaryChild([presence, cover], undefined, 'Tapparella-Kitchen')?.id,
    ).toBe(1900)
  })

  it('picks it whatever order the children arrive in', () => {
    expect(
      resolveContainerPrimaryChild([cover, presence], undefined, 'Tapparella-Kitchen')?.id,
    ).toBe(1900)
  })

  it('treats hyphen, underscore and space as the same separator', () => {
    for (const container of ['Tapparella-Kitchen', 'Tapparella_Kitchen', 'tapparella  kitchen']) {
      expect(
        resolveContainerPrimaryChild([presence, cover], undefined, container)?.id,
        container,
      ).toBe(1900)
    }
  })

  it('keeps the namesake working where the child really IS the namesake', () => {
    // Markise: the cover carries the container's own name, and there is a
    // lower-priority `update` child that must not win.
    const markise = { id: 2048, stableId: 's-2048', type: 'cover', name: 'Markise' }
    const update = { id: 2045, stableId: 's-2045', type: 'update', name: 'Update' }
    expect(resolveContainerPrimaryChild([update, markise], undefined, 'Markise')?.id).toBe(2048)
  })

  it('answers the SAME whether or not the caller passes the container name', () => {
    // admin-ui omits the third argument and the viewer's linked-devices path
    // passes it. That divergence is what made one surface show the shutter and
    // the other not; the defect was never which answer is right, it was that
    // the two disagreed.
    const withName = resolveContainerPrimaryChild(
      [presence, cover],
      undefined,
      'Tapparella-Kitchen',
    )
    const without = resolveContainerPrimaryChild([presence, cover], undefined)
    expect(withName?.id).toBe(without?.id)
  })
})
