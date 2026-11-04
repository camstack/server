/**
 * System → Data → Storage (`/system/data?tab=storage`): the locations of one
 * hub, one card per location, grouped by kind, with the Add and Edit forms
 * (`?new=1&type=recordings`, `?edit=<id>`).
 */
import { defineFixtures } from './_define'

const GB = 1024 ** 3

const loc = (
  id: string,
  type: string,
  displayName: string,
  root: string,
  total: number,
  available: number,
) => ({
  id,
  type,
  displayName,
  providerId: 'fs',
  config: { basePath: root },
  nodeId: 'hub',
  isSystem: false,
  enabled: true,
  mode: 'active',
  capacity: { totalBytes: total * GB, availableBytes: available * GB },
})

const DECLARATIONS = [
  { id: 'recordings', displayName: 'Recordings', cardinality: 'multi', defaultRoot: 'media' },
  {
    id: 'recordingsLow',
    displayName: 'Recordings (Low)',
    cardinality: 'multi',
    defaultsTo: 'recordings',
  },
  { id: 'eventMedia', displayName: 'Event Media', cardinality: 'multi', defaultsTo: 'recordings' },
  { id: 'artifacts', displayName: 'Artifacts', cardinality: 'single', defaultRoot: 'media' },
  {
    id: 'homekitClips',
    displayName: 'HomeKit Clips',
    cardinality: 'single',
    defaultsTo: 'recordings',
  },
  { id: 'backups', displayName: 'Backups', cardinality: 'multi', defaultRoot: 'backup' },
]

export default defineFixtures({
  area: 'storage',
  description: 'Storage page: one default location per kind on a hub, filesystem provider.',
  handlers: {
    'storage.listLocations': [
      loc('recordings:default', 'recordings', 'Recordings', '/recordings/recordings', 3720, 2480),
      loc(
        'recordingsLow:default',
        'recordingsLow',
        'Recordings (Low)',
        '/recordings/recordingsLow',
        3720,
        2480,
      ),
      loc('eventMedia:default', 'eventMedia', 'Event Media', '/recordings/eventMedia', 3720, 2480),
      loc('artifacts:default', 'artifacts', 'Artifacts', '/recordings/artifacts', 3720, 2480),
      loc(
        'homekitClips:default',
        'homekitClips',
        'HomeKit Clips',
        '/recordings/homekitClips',
        3720,
        2480,
      ),
      loc('backups:default', 'backups', 'Backups', '/backups/backups', 1860, 1620),
    ],
    'storage.listLocationDeclarations': DECLARATIONS,
    'storage.listDrainProgress': [],
    'alerts.list': [],
    'alerts.getUnreadCount': 0,
    'storage.listProviders': [
      {
        providerId: 'fs',
        displayName: 'Filesystem',
        configSchema: { sections: [] },
        nodeLocal: true,
        shouldSaveDiskSpace: true,
        minFreePercent: 10,
      },
    ],
    'filesystemBrowse.listAllowedRoots': ['/recordings', '/backups'],
    'filesystemBrowse.browse': (i: { path: string }) => ({
      path: i.path,
      entries: [],
      freeBytes: 2480 * GB,
      totalBytes: 3720 * GB,
    }),
    'pipelineOrchestrator.listAgentSettings': [],
    'recordingArchive.getStorageUsage': { nodeId: 'hub', totalUsedBytes: 0, devices: [] },
  },
})
