/** The one burst rule of the derived device changes (D1084). */
import type { TransitionValue } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  coalesceChanges,
  fieldKey,
  SETTLE_MAX_HOLD_MS,
  SETTLE_QUIET_MS,
  type FieldPoint,
} from '../change-coalescing.js'

const T0 = Date.UTC(2026, 10, 1, 12, 0, 0)
const NOW = T0 + 10 * 60_000

const pt = (
  at: number,
  field: string,
  value: FieldPoint['value'],
  capName = 'cover',
): FieldPoint => ({
  capName,
  field,
  at,
  value,
})

describe('coalesceChanges', () => {
  it('nets a cover opening to one change per field, stamped with the last point of the burst', () => {
    const before = new Map<string, TransitionValue>([
      [fieldKey('cover', 'state'), 'closed'],
      [fieldKey('cover', 'position'), 0],
    ])
    const changes = coalesceChanges({
      before,
      now: NOW,
      points: [
        pt(T0, 'state', 'open'),
        pt(T0 + 100, 'position', 6),
        pt(T0 + 200, 'state', 'opening'),
        pt(T0 + 3_000, 'state', 'open'),
        pt(T0 + 3_100, 'position', 100),
      ],
    })
    expect(changes).toEqual(
      expect.arrayContaining([
        { capName: 'cover', field: 'state', at: T0 + 3_100, from: 'closed', to: 'open' },
        { capName: 'cover', field: 'position', at: T0 + 3_100, from: 0, to: 100 },
      ]),
    )
    expect(changes).toHaveLength(2)
  })

  it('shows nothing for a field that ended where it began', () => {
    const changes = coalesceChanges({
      before: new Map([[fieldKey('cover', 'state'), 'closed']]),
      now: NOW,
      points: [pt(T0, 'state', 'opening'), pt(T0 + 1_000, 'state', 'closed')],
    })
    expect(changes).toEqual([])
  })

  it('splits two bursts a quiet gap apart', () => {
    const changes = coalesceChanges({
      before: new Map([[fieldKey('switch', 'on'), false]]),
      now: NOW,
      points: [pt(T0, 'on', true, 'switch'), pt(T0 + SETTLE_QUIET_MS + 1, 'on', false, 'switch')],
    })
    expect(changes.map((c) => [c.at, c.from, c.to])).toEqual([
      [T0 + SETTLE_QUIET_MS + 1, true, false],
      [T0, false, true],
    ])
  })

  it('closes a flapping burst at the hold limit', () => {
    const points: FieldPoint[] = []
    for (let i = 0; i <= 20; i += 1) points.push(pt(T0 + i * 4_000, 'on', i % 2 === 0, 'switch'))
    expect(points.at(-1)?.at).toBeGreaterThan(T0 + SETTLE_MAX_HOLD_MS)
    const changes = coalesceChanges({
      before: new Map([[fieldKey('switch', 'on'), false]]),
      now: NOW,
      points,
    })
    expect(changes.length).toBeGreaterThanOrEqual(1)
    expect(changes.every((c) => c.at < T0 + 21 * 4_000)).toBe(true)
  })

  it('does not return a burst that has not been quiet yet, and returns it once it has', () => {
    const input = {
      before: new Map([[fieldKey('switch', 'on'), false]]),
      points: [pt(T0, 'on', true, 'switch')],
    }
    expect(coalesceChanges({ ...input, now: T0 + SETTLE_QUIET_MS - 1 })).toEqual([])
    expect(coalesceChanges({ ...input, now: T0 + SETTLE_QUIET_MS })).toHaveLength(1)
  })

  it('treats a field never seen before as being learned, not as a change', () => {
    expect(
      coalesceChanges({ before: new Map(), now: NOW, points: [pt(T0, 'on', true, 'switch')] }),
    ).toEqual([])
  })

  it('keeps two capabilities apart', () => {
    const changes = coalesceChanges({
      before: new Map<string, TransitionValue>([
        [fieldKey('switch', 'on'), false],
        [fieldKey('lock', 'state'), 'locked'],
      ]),
      now: NOW,
      points: [pt(T0, 'on', true, 'switch'), pt(T0 + 10, 'state', 'unlocked', 'lock')],
    })
    expect(changes.map((c) => c.capName).toSorted()).toEqual(['lock', 'switch'])
  })
})
