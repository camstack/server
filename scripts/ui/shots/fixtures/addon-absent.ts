/**
 * A page whose providing addon is NOT installed (`/system/pipeline`): the
 * registry answers for every capability, and for the ones the sidebar gates on
 * the answer is "no such capability" — the page and its nav entry must read as
 * disabled, never as a spinner.
 */
import { defineFixtures } from './_define'

export default defineFixtures({
  area: 'addon-absent',
  description: 'Registry answers "no such capability": gated pages and nav entries are disabled.',
  handlers: {
    'capabilities.getCapability': null,
  },
})
