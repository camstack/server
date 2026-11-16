/**
 * Build page, every section at once: automations, actions, schedulers, a script,
 * a composed device and templates (a remote layout and an automation template),
 * all carrying tags. Used to shoot each section's list and its editor for the
 * shared Quick edit modal and the shared editor frame.
 */
import { defineFixtures } from './_define'
import { tagHandlers } from './_tags'
import { NOW } from './_time'
import build, { ACTIONS } from './build'
import schedulers from './build-schedulers'
import fountain from './build-fountain'
import templates from './templates'

const AUTOMATION_BLOCKS = (templates.handlers['coreBlocks.list'] as { blocks: readonly object[] })
  .blocks

const SCRIPT = {
  id: 'blk-garage-watch',
  name: 'Garage door watcher',
  code: 'export default (ctx) => () => {}\n',
  enabled: true,
  placement: 'hub',
  createdAt: NOW - 86_400_000,
  updatedAt: NOW - 7_200_000,
  createdBy: 'admin',
  status: 'running',
  lastChangedAt: NOW - 7_200_000,
  tags: ['Night'],
}

const TAGGED_ACTIONS = ACTIONS.map((action, index) =>
  index === 0 ? { ...action, tags: ['Garden'] } : action,
)

export default defineFixtures({
  area: 'build-quick-edit',
  description: 'Build page, all sections: editors in-page, Quick edit modal, tags',
  handlers: {
    ...templates.handlers,
    ...build.handlers,
    ...tagHandlers,
    'coreBlocks.list': {
      blocks: [
        ...AUTOMATION_BLOCKS.map((block, index) =>
          index === 0 ? { ...block, tags: ['Garden', 'Energy'] } : block,
        ),
        SCRIPT,
      ],
    },
    'coreBlocks.listCompositions': fountain.handlers['coreBlocks.listCompositions'],
    'coreBlocks.getComposition': fountain.handlers['coreBlocks.getComposition'],
    'coreBlocks.getTypeDefs': { libs: [] },
    'coreBlocks.getTraces': build.handlers['coreBlocks.getTraces'],
    'template.list': templates.handlers['template.list'],
    'actions.list': TAGGED_ACTIONS,
    'schedulers.list': schedulers.handlers['schedulers.list'],
    'schedulers.getStatus': schedulers.handlers['schedulers.getStatus'],
    'schedulers.getTraces': { traces: [], lastError: null },
  },
})
