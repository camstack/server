import { describe, it, expect } from 'vitest'
import { childEntityId, type ContainerChild } from '../container-primary'
import { resolveContainerPrimaryChild } from '@camstack/types'

/**
 * REGRESSION (container 4127, 2026-09-04). The picker wrote
 * `childEntityId(child)` — `sourceInfo.id` when the integration has one — while
 * `resolveContainerPrimaryChild` matches on `stableId`. The two differ for 677
 * of 925 container children on the live hub, so the operator's pick was stored,
 * the mutation answered success, and the container kept its priority default.
 * The operator made the same pick twice before reporting it.
 *
 * This asserts the two identities against the resolver directly, which is where
 * the mismatch actually bites.
 */
const CHILDREN: readonly ContainerChild[] = [
  {
    id: 4131,
    stableId: 'ha:ha_001:dev:f746-binary_sensor.contatto_porta_front_door',
    type: 'sensor',
    sourceInfo: { id: 'binary_sensor.contatto_porta_front_door' },
  },
  {
    id: 4337,
    stableId: 'ha:ha_001:dev:f746-button.contatto_porta_front_door_identify',
    type: 'button',
    sourceInfo: { id: 'button.contatto_porta_front_door_identify' },
  },
]

const refs = CHILDREN.map((c) => ({ id: c.id, stableId: c.stableId, type: c.type }))

describe('the key a primary-child pick is written under', () => {
  it('resolves when the pick is the stableId — the canonical key', () => {
    expect(resolveContainerPrimaryChild(refs, CHILDREN[0]!.stableId)?.id).toBe(4131)
  })

  it('does NOT resolve when the pick is the sourceInfo id and the ref carries no entityId', () => {
    // Exactly what the picker used to write. Falls through to priority, and
    // `button` outranks `sensor`, so the operator gets back the very child they
    // just replaced.
    const fallback = resolveContainerPrimaryChild(refs, childEntityId(CHILDREN[0]!))
    expect(fallback?.id).toBe(4337)
  })

  it('still honours a legacy pick when the ref DOES carry the entityId', () => {
    const legacyRefs = CHILDREN.map((c) => ({
      id: c.id,
      stableId: c.stableId,
      entityId: c.sourceInfo?.id,
      type: c.type,
    }))
    expect(
      resolveContainerPrimaryChild(legacyRefs, 'binary_sensor.contatto_porta_front_door')?.id,
    ).toBe(4131)
  })

  it('the two identities are genuinely different for an HA child', () => {
    expect(childEntityId(CHILDREN[0]!)).not.toBe(CHILDREN[0]!.stableId)
  })
})
