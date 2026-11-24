/**
 * Customize tab of a camera with a stored doorbell event: `/devices/101?tab=customize`.
 * The camera page asks for the stream, pipeline and recording facts of the
 * `camera` area; the Customize answers of `customize` win over them.
 * Load alone (`--fixtures customize-camera-events`).
 */
import cameraArea from './camera'
import customizeArea from './customize'
import { defineFixtures } from './_define'

export default defineFixtures({
  area: 'customize-camera-events',
  description: 'Customize tab of a camera with a doorbell event row',
  handlers: {
    ...cameraArea.handlers,
    ...customizeArea.handlers,
    // The camera page reads the zones slice; the Customize fallback answer has no `zones`.
    'deviceState.getCapSlice': (i: { deviceId: number; capName: string }) => {
      if (i.capName === 'zones') return { zones: [], lastFetchedAt: 1_700_000_000_000 }
      const own = customizeArea.handlers['deviceState.getCapSlice']
      return typeof own === 'function' ? Reflect.apply(own, undefined, [i]) : null
    },
    'deviceState.getSnapshot': (i: { deviceId: number }) => {
      const own = customizeArea.handlers['deviceState.getSnapshot']
      const base = typeof own === 'function' ? Reflect.apply(own, undefined, [i]) : {}
      return { ...base, zones: { zones: [], lastFetchedAt: 1_700_000_000_000 } }
    },
    'remote.listCommands': { commands: [] },
    'coreBlocks.listTemplateInstances': [],
    'deviceHistory.listSeries': [],
    'remote.getAssumedStatus': null,
    'tags.list': [],
  },
})
