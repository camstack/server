/**
 * The admin global search, open on a query that matches Build elements by name
 * and by tag: an automation, a script, a scheduler, an action, a template and
 * a custom device, each carrying the tag `Garden`. Invented data.
 */
import { defineFixtures } from './_define'
import build, { ACTIONS } from './build'
import { NOW } from './_time'
import { tagHandlers } from './_tags'

const BASE = (build.handlers['coreBlocks.list'] as { blocks: readonly object[] }).blocks[0]
const TAGS = ['Garden']

const SCRIPT = {
  id: 'blk-garden-script',
  name: 'Garden watering helper',
  code: 'export const litres = 12\n',
  enabled: true,
  placement: 'hub',
  createdAt: NOW - 86_400_000,
  updatedAt: NOW - 3_600_000,
  createdBy: 'admin',
  status: 'running',
  lastChangedAt: NOW - 3_600_000,
  tags: TAGS,
}
const COMPOSED = { ...SCRIPT, id: 'blk-garden-device', name: 'Garden fountain', tags: TAGS }

export default defineFixtures({
  area: 'search-build',
  description: 'Global search results over Build elements (name and tag)',
  handlers: {
    ...build.handlers,
    ...tagHandlers,
    'coreBlocks.list': {
      blocks: [
        { ...BASE, id: 'blk-garden-lights', name: 'Garden lights at dusk', tags: TAGS },
        SCRIPT,
      ],
    },
    'coreBlocks.listCompositions': {
      state: 'loaded',
      views: [
        {
          block: COMPOSED,
          state: { kind: 'answered', state: { blockId: COMPOSED.id, deviceId: 900 } },
        },
      ],
    },
    'actions.list': ACTIONS.map((a, i) =>
      i === 0 ? { ...a, name: 'Garden gate', tags: TAGS } : a,
    ),
    'schedulers.list': [
      {
        id: 'sch-garden',
        name: 'Garden sprinklers',
        enabled: true,
        priority: 10,
        maxLateMs: 600_000,
        createdAt: NOW,
        updatedAt: NOW,
        profiles: [],
        tags: TAGS,
      },
    ],
    'template.list': [
      {
        id: 'tpl-garden',
        kind: 'automation',
        name: 'Garden presence',
        payload: {},
        createdAt: 0,
        updatedAt: 0,
        tags: TAGS,
      },
    ],
  },
})
