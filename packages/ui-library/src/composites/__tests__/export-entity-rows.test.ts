/**
 * The action and notifier rows of the device export table (D968). They are
 * built ONLY for the kinds the exporter answered: an unanswered kinds list is
 * unknown, which means devices only, never "supports nothing".
 */
import { describe, expect, it } from 'vitest'

import {
  buildEntityRows,
  ENTITY_FILTER_IDS,
  entityFilterOptionIds,
  supportedEntityKinds,
} from '../export-entity-rows'

const ACTIONS = [
  { id: 'internal:a', name: 'Open gate' },
  { id: 'internal:b', name: 'Arm night mode' },
]
const TARGETS = [{ id: 'tg:1', name: 'Phone' }]
const EXPOSED = [{ entity: { kind: 'action', actionId: 'internal:a' }, exposedAs: 'Open gate' }]

describe('supportedEntityKinds', () => {
  it('keeps the non-device kinds the exporter answered', () => {
    expect(supportedEntityKinds(['device', 'action'])).toEqual(new Set(['action']))
    expect(supportedEntityKinds(['device', 'action', 'notifier'])).toEqual(
      new Set(['action', 'notifier']),
    )
    expect(supportedEntityKinds(['device'])).toEqual(new Set())
  })

  it('is null (unknown) when the exporter did not answer', () => {
    expect(supportedEntityKinds(undefined)).toBeNull()
    expect(supportedEntityKinds(null)).toBeNull()
    expect(supportedEntityKinds('nope')).toBeNull()
  })
})

describe('buildEntityRows', () => {
  it('lists actions with their exposed state, only when actions are supported', () => {
    const rows = buildEntityRows({
      kinds: new Set(['action']),
      actions: ACTIONS,
      targets: TARGETS,
      exposed: EXPOSED,
    })
    expect(rows.map((r) => [r.kind, r.name, r.exposed])).toEqual([
      ['action', 'Open gate', true],
      ['action', 'Arm night mode', false],
    ])
    expect(rows[0]?.ref).toEqual({ kind: 'action', actionId: 'internal:a' })
  })

  it('lists notification targets only when notifiers are supported', () => {
    const rows = buildEntityRows({
      kinds: new Set(['notifier']),
      actions: ACTIONS,
      targets: TARGETS,
      exposed: [],
    })
    expect(rows.map((r) => [r.kind, r.name])).toEqual([['notifier', 'Phone']])
    expect(rows[0]?.ref).toEqual({ kind: 'notifier', targetId: 'tg:1' })
  })

  it('builds no row at all while the kinds are unanswered', () => {
    expect(
      buildEntityRows({ kinds: null, actions: ACTIONS, targets: TARGETS, exposed: EXPOSED }),
    ).toEqual([])
  })

  it('gives every row a key that cannot collide with a device id', () => {
    const rows = buildEntityRows({
      kinds: new Set(['action', 'notifier']),
      actions: ACTIONS,
      targets: TARGETS,
      exposed: [],
    })
    expect(new Set(rows.map((r) => r.key)).size).toBe(rows.length)
    for (const row of rows) expect(Number.isNaN(Number(row.key))).toBe(true)
  })

  it('an unanswered list yields no rows rather than throwing', () => {
    expect(
      buildEntityRows({
        kinds: new Set(['action', 'notifier']),
        actions: undefined,
        targets: undefined,
        exposed: undefined,
      }),
    ).toEqual([])
  })
})

describe('entityFilterOptionIds', () => {
  it('offers a filter only for a supported kind', () => {
    expect(entityFilterOptionIds(new Set(['action']))).toEqual([ENTITY_FILTER_IDS.action])
    expect(entityFilterOptionIds(new Set(['action', 'notifier']))).toEqual([
      ENTITY_FILTER_IDS.action,
      ENTITY_FILTER_IDS.notifier,
    ])
    expect(entityFilterOptionIds(null)).toEqual([])
  })
})
