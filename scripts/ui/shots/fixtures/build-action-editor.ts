/**
 * Build → Actions editor of an action that uses the full step vocabulary: an
 * http request, a notify, a wait entered in milliseconds, a choose and a
 * repeat (#640). Open with `--route "/build?tab=actions&action=internal:garden-watering"`.
 */
import { defineFixtures } from './_define'
import { NOW } from './_time'
import { ACTIONS } from './build'
import quickEdit from './build-quick-edit'

const WIDE_ACTION = {
  id: 'internal:garden-watering',
  name: 'Garden watering',
  addonId: 'core-blocks',
  source: 'internal',
  readOnly: false,
  variables: [{ name: 'zone', label: 'Zone', type: 'string', default: 'lawn' }],
  steps: [
    { kind: 'wait', seconds: 0.5 },
    { kind: 'wait', seconds: 90 },
    {
      kind: 'http-request',
      method: 'POST',
      url: 'https://example.com/valves/{{vars.zone}}/open',
      timeoutSeconds: 5,
    },
    { kind: 'notify', targetId: 'target-1', body: 'Watering {{vars.zone}}' },
    {
      kind: 'choose',
      branches: [
        {
          if: { kind: 'all', children: [] },
          steps: [{ kind: 'wait', seconds: 1 }],
        },
      ],
    },
  ],
  status: { isRunning: false, lastRunAt: NOW - 3_600_000, lastError: null },
}

export default defineFixtures({
  area: 'build-action-editor',
  description: 'Build page: an action editor with the full step vocabulary',
  handlers: {
    ...quickEdit.handlers,
    'actions.list': [WIDE_ACTION, ...ACTIONS],
    // the notify step's target picker reads the notifier instances
    'integrationInstances.describe': {
      role: 'services',
      instanceMode: 'multiple',
      kind: 'notifier',
      canTest: false,
      kinds: [],
    },
    'integrationInstances.listInstances': [],
  },
})
