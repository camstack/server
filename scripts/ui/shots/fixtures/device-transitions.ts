/**
 * Invented actuations for the device card History view
 * (`/device-card-preview?type=climate&view=history`).
 * `--fixtures device-transitions`.
 */
import { actuationFixturePage } from '../../../../packages/ui-library/src/composites/device-card/__fixtures__/actuations'
import { defineFixtures } from './_define'

export default defineFixtures({
  area: 'device-transitions',
  description: 'Who changed a climate device, newest first, with a second page',
  handlers: {
    'deviceTransitions.listTransitions': (input: { readonly cursor?: string }) =>
      actuationFixturePage(input.cursor),
    'actions.list': [{ id: 'act-night', name: 'Buonanotte' }],
  },
})
