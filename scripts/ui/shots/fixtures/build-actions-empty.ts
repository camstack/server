/**
 * Build page, Actions tab with no actions at all: the answered-empty state
 * (`/build?tab=actions`). Same shell as `build`, `actions.list` answers [].
 */
import { defineFixtures } from './_define'
import build from './build'

export default defineFixtures({
  area: 'build-actions-empty',
  description: 'Build page: Actions tab when the installation has no actions',
  handlers: { ...build.handlers, 'actions.list': [] },
})
