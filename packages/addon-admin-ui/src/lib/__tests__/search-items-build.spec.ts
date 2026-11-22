import { describe, expect, it } from 'vitest'
import { generateAutomationBlock, LINKED_TRIGGER_TEMPLATE_ID } from '@camstack/types'
import type {
  ActionEntry,
  CompositionView,
  CoreBlock,
  Scheduler,
  TemplateRecord,
} from '@camstack/types'
import { filterSearchItems } from '../global-search'
import { buildBuildSearchItems, buildEditorPath } from '../search-items-build'

// Fixtures are cast at the boundary: the specs read only id, name, tags and code.
const automation = {
  id: 'blk-auto',
  name: 'Porch lights at dusk',
  tags: ['evening'],
  code: 'const AUTOMATION_RECIPE = {}',
} as unknown as CoreBlock
const script = {
  id: 'blk-script',
  name: 'Garage helper',
  tags: ['garage-tag'],
  code: 'export const answer = 42',
} as unknown as CoreBlock
const scheduler = { id: 'sch-1', name: 'Night heating', tags: ['winter'] } as unknown as Scheduler
const action = { id: 'act-1', name: 'Close shutters', tags: ['shade'] } as unknown as ActionEntry
const template = {
  id: 'tpl-1',
  kind: 'automation',
  name: 'Motion light',
  tags: ['reusable'],
} as unknown as TemplateRecord
const composition = {
  block: { id: 'cmp-1', name: 'Pool controller', tags: ['outdoor'] },
} as unknown as CompositionView

const ITEMS = buildBuildSearchItems({
  blocks: [automation, script],
  schedulers: [scheduler],
  actions: [action],
  templates: [template],
  compositions: [composition],
})

function firstPath(query: string, domain: string): string | undefined {
  const group = filterSearchItems(ITEMS, query).groups.find((g) => g.domain === domain)
  return group?.items[0]?.path
}

describe('Build elements in global search', () => {
  const cases = [
    ['automation', 'Porch lights', 'evening', '/build?tab=automations&block=blk-auto'],
    ['script', 'Garage helper', 'garage-tag', '/build?tab=scripts&block=blk-script'],
    ['scheduler', 'Night heating', 'winter', '/build?tab=schedulers&scheduler=sch-1'],
    ['action', 'Close shutters', 'shade', '/build?tab=actions&action=act-1'],
    ['template', 'Motion light', 'reusable', '/build?tab=templates&edit=tpl-1'],
    ['customDevice', 'Pool controller', 'outdoor', '/build/compositions/cmp-1'],
  ] as const

  it.each(cases)('%s is found by name and redirects to its editor', (domain, name, _tag, path) => {
    expect(firstPath(name, domain)).toBe(path)
  })

  it.each(cases)('%s is found by tag and redirects to its editor', (domain, _name, tag, path) => {
    expect(firstPath(tag, domain)).toBe(path)
  })

  it('keeps a plain script out of automations and the reverse', () => {
    const keys = ITEMS.map((i) => i.key)
    expect(keys).toContain('automation:blk-auto')
    expect(keys).toContain('script:blk-script')
    expect(keys).not.toContain('automation:blk-script')
  })

  it('builds nothing from lists that have not answered', () => {
    expect(buildBuildSearchItems({})).toEqual([])
  })

  it('encodes the id in an editor path', () => {
    expect(buildEditorPath('actions', 'action', 'a b')).toBe('/build?tab=actions&action=a%20b')
  })
})

describe('a linked trigger in global search', () => {
  it('is offered neither as an automation nor as a script: it is edited on its device', () => {
    const linkedTrigger: CoreBlock = {
      ...automation,
      id: 'blk-linked',
      name: 'Button to light',
      code: generateAutomationBlock({
        name: 'Button to light',
        recipe: {
          when: { kind: 'any', children: [{ kind: 'device-fired', deviceId: 12 }] },
          actions: [{ kind: 'wait', seconds: 5 }],
          template: { templateId: LINKED_TRIGGER_TEMPLATE_ID, values: { target: 5767 } },
        },
      }),
    }
    const items = buildBuildSearchItems({ blocks: [automation, linkedTrigger, script] })
    expect(items.map((i) => i.key)).toEqual(['automation:blk-auto', 'script:blk-script'])
  })
})
