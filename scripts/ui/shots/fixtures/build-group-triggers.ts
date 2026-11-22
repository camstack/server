/**
 * Build → a light group with two triggers (a button press that toggles, a
 * doorbell event that turns on), one of them off. Open with
 * `--route "/build/compositions/blk-lamp-group"`. Reuses the `build-fountain`
 * fleet; the block is the group's own helper composition.
 */
import { compileHelper } from '../../../../packages/types/src/composition/helpers/compile.ts'
import type { GroupHelperSpec } from '../../../../packages/types/src/composition/helpers/spec.ts'
import { EventCategory } from '../../../../packages/types/src/enums/event-category.ts'
import { defineFixtures } from './_define'
import fountain from './build-fountain'
import { NOW } from './_time'

const spec: GroupHelperSpec = {
  kind: 'group',
  templateId: 'light',
  aggregate: 'any',
  active: 'at-least-one',
  members: [
    { source: { addonId: 'provider-demo', stableId: 'lamp-1' }, cap: 'switch', fieldPath: 'on' },
    { source: { addonId: 'provider-demo', stableId: 'lamp-2' }, cap: 'switch', fieldPath: 'on' },
  ],
  triggers: [
    {
      id: 't1',
      source: {
        kind: 'fired',
        device: { addonId: 'provider-demo', stableId: 'button-1' },
        eventIds: ['PRESS_SHORT'],
      },
      action: { kind: 'switch' },
    },
    {
      id: 't2',
      enabled: false,
      source: { kind: 'event', category: EventCategory.DoorbellOnPressed },
      action: { kind: 'on' },
    },
  ],
}

const compiled = compileHelper(spec)
if (!compiled.ok) throw new Error('the fixture group does not compile')

const base = fountain.handlers['coreBlocks.getComposition'] as (input: { blockId?: string }) => {
  view: { block: Record<string, unknown>; state: unknown } | null
} & Record<string, unknown>

function lampGroup(input: { blockId?: string }) {
  if (input.blockId !== 'blk-lamp-group') return base(input)
  return {
    state: 'loaded',
    view: {
      block: {
        id: 'blk-lamp-group',
        name: 'Lamp group',
        code: '',
        enabled: true,
        placement: 'hub',
        createdAt: 1,
        updatedAt: NOW,
        createdBy: 'admin',
        status: 'running',
        lastChangedAt: 1,
        source: { kind: 'composition', composition: compiled.composition },
      },
      state: { kind: 'answered', state: null },
    },
  }
}

export default defineFixtures({
  area: 'build-group-triggers',
  description: 'A light group with its Triggers section',
  handlers: {
    ...fountain.handlers,
    'coreBlocks.getComposition': lampGroup,
    'schedulers.list': [],
    'template.list': [],
  },
})
