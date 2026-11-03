/**
 * Build page, creation dialog (`/build?tab=custom-device&new=helper`, and
 * `new=blank` for the Device form): the Build fixtures plus the queries the
 * dialog and the page frame ask that they leave unanswered. A smart plug and a
 * media player are in the fleet so the heater and media-player source pickers
 * have something to list.
 */
import { defineFixtures } from './_define'
import build from './build'

const PLUG = {
  id: 301,
  stableId: 'switch.stove_plug',
  addonId: 'provider-homeassistant',
  type: 'switch',
  name: 'Stove plug',
  location: 'Living room',
  disabled: false,
  parentDeviceId: null,
  role: null,
  online: true,
  probed: true,
  features: [],
  isCamera: false,
  config: {},
  secretConfigPaths: [],
  metadata: {},
}

const PLAYER = { ...PLUG, id: 302, stableId: 'media_player.tv', type: 'media-player', name: 'TV' }

export default defineFixtures({
  area: 'build-create',
  description: 'Build page: the creation dialog (Device and Aggregate sections)',
  handlers: {
    ...build.handlers,
    'deviceManager.listAll': [
      ...(Array.isArray(build.handlers['deviceManager.listAll'])
        ? build.handlers['deviceManager.listAll']
        : []),
      PLUG,
      PLAYER,
    ],
    'deviceManager.listPersistedByAddon': [],
    'schedulers.list': [],
    'preferences.get': { rows: [] },
    'auth.listLoginMethods': [],
  },
})
