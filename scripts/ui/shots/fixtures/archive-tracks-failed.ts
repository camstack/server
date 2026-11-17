/**
 * Archive → Cameras → Review while the window's track read fails: the event
 * list still loads, the zone / face / plate facts do not. Same invented data as
 * `archive.ts`, with `pipelineAnalytics.listTracks` refused.
 */
import { defineFixtures } from './_define'
import archiveArea from './archive'

export default defineFixtures({
  area: 'archive-tracks-failed',
  description: 'Archive Review with the track query failing',
  handlers: {
    ...archiveArea.handlers,
    'pipelineAnalytics.listTracks': { __error: 'analytics store offline' },
  },
})
