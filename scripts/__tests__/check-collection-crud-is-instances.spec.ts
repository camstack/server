import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  BASELINE_PATH,
  crudMethodsOf,
  findViolations,
} from '../check-collection-crud-is-instances.js'
import { isProductSource, loadBaseline, ROOT, readSources, walk } from '../lib/family-baseline.js'
import { itRealTree } from './lib/real-tree.js'

const NOTIFY_CAP = `
  methods: {
    listTargets: method(z.object({}), z.array(TargetSchema), { auth: 'admin' }),
    upsertTarget: method(z.object({}), z.void()),
    send: method(z.object({}), z.void()),
    discoverTargets: method(z.object({}), z.array(z.string())),
  },
`
const WASTE_ACTIONS = `
export const wasteActions = defineCustomActions({
  fetchNow: customAction(z.object({}), z.object({})),
  deleteSource: customAction(z.object({}), z.object({})),
})
`
const cap = (name: string, text: string) => ({
  path: `packages/types/src/capabilities/${name}`,
  text,
})

const BASELINE = {
  families: {
    notifiers: {
      'notification-output.cap.ts:listTargets': 'moves in P6a',
      'notification-output.cap.ts:upsertTarget': 'moves in P6a',
      'notification-output.cap.ts:discoverTargets': 'form helper',
    },
    waste: {
      'packages/addon-waste-collections/src/custom-actions.ts:deleteSource': 'moves in P6e',
    },
  },
}
const FILES = [
  cap('notification-output.cap.ts', NOTIFY_CAP),
  { path: 'packages/addon-waste-collections/src/custom-actions.ts', text: WASTE_ACTIONS },
]

describe('check-collection-crud-is-instances', () => {
  it('reads the CRUD-named methods and ignores the others', () => {
    expect(crudMethodsOf(NOTIFY_CAP)).toEqual(['listTargets', 'upsertTarget', 'discoverTargets'])
    expect(crudMethodsOf(WASTE_ACTIONS)).toEqual(['deleteSource'])
  })

  it('is green on a baseline that lists every match', () => {
    expect(findViolations(FILES, BASELINE)).toEqual([])
  })

  it('is red when a baseline line is removed', () => {
    const smaller = {
      families: {
        ...BASELINE.families,
        notifiers: { 'notification-output.cap.ts:listTargets': 'moves in P6a' },
      },
    }
    const found = findViolations(FILES, smaller)
    expect(found.map((v) => v.message).join('\n')).toContain('upsertTarget')
    expect(found.map((v) => v.message).join('\n')).toContain('discoverTargets')
  })

  it('is red on a stale baseline entry', () => {
    const found = findViolations(FILES, {
      families: { ...BASELINE.families, llm: { 'llm.cap.ts:listProfiles': 'gone' } },
    })
    expect(found).toHaveLength(1)
    expect(found[0]?.message).toContain('remove the line')
  })

  it('is red on a new CRUD method of a cap, and of a custom action', () => {
    const found = findViolations(
      [
        ...FILES,
        cap('acme.cap.ts', '  listProfiles: method(z.object({}), z.array(z.string())),\n'),
        {
          path: 'packages/addon-acme/src/actions.ts',
          text: 'defineCustomActions({\n  createSource: customAction(a, b),\n})',
        },
      ],
      BASELINE,
    )
    expect(found).toHaveLength(2)
    expect(found[0]?.message).toContain('integration-instances')
  })

  it('reads a QUOTED, namespaced custom action: the five nc.*MyTarget* actions are a second CRUD', () => {
    const planted = `defineCustomActions({
  'nc.listMyTargets': customAction(z.object({}), z.object({})),
  "nc.upsertMyTarget": customAction(a, b, { kind: 'mutation' }),
  'nc.deleteMyTarget': customAction(a, b),
  'nc.setMyTargetEnabled': customAction(a, b),
  'nc.testMyTarget': customAction(a, b),
  'nc.listRules': customAction(a, b),
})`
    expect(crudMethodsOf(planted)).toEqual(['nc.listMyTargets', 'nc.upsertMyTarget', 'nc.deleteMyTarget'])
    const found = findViolations(
      [{ path: 'packages/addon-acme/src/nc-actions.ts', text: planted }],
      { families: {} },
    )
    expect(found.map((v) => v.message).join('\n')).toContain('nc.listMyTargets')
    expect(found).toHaveLength(3)
  })

  it('does not look at integration-instances itself, nor at a file with no cap or custom actions', () => {
    const found = findViolations(
      [
        cap(
          'integration-instances.cap.ts',
          '  upsertInstance: method(a, b),\n  instanceFormSchema: method(a, b),\n',
        ),
        { path: 'packages/x/src/plain.ts', text: '  listTargets: method(a, b),\n' },
      ],
      { families: {} },
    )
    expect(found).toEqual([])
  })

  it('is red when a baseline entry has no reason', () => {
    const found = findViolations(FILES, {
      families: {
        ...BASELINE.families,
        notifiers: {
          ...BASELINE.families.notifiers,
          'notification-output.cap.ts:listTargets': ' ',
        },
      },
    })
    expect(found[0]?.message).toContain('no reason')
  })

  itRealTree('holds on the committed tree and baseline', { timeout: 120_000 }, () => {
    const files = walk(path.join(ROOT, 'packages'), isProductSource)
    expect(findViolations(readSources(files), loadBaseline(BASELINE_PATH))).toEqual([])
  })
})
