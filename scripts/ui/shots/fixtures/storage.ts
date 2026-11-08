/**
 * System → Data → Storage (`/system/data?tab=storage`): the storage locations as instances of the
 * function cap `storage` (D1013), one kind per declaration, with the capacity and state columns.
 * Invented data.
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

const CREATE_FORM = {
  sections: [
    {
      id: 'provider',
      title: 'Provider',
      columns: 2,
      fields: [
        {
          type: 'select',
          key: 'providerId',
          label: 'Provider',
          default: 'filesystem',
          options: [
            { value: 'filesystem', label: 'Filesystem' },
            { value: 's3', label: 'S3-compatible' },
          ],
        },
        {
          type: 'select',
          key: 'mode',
          label: 'State',
          default: 'active',
          options: [
            { value: 'active', label: 'Active' },
            { value: 'readonly', label: 'Read-only' },
          ],
        },
      ],
    },
    {
      id: 'connection',
      title: 'Filesystem',
      columns: 2,
      fields: [
        {
          type: 'text',
          key: 'filesystem.basePath',
          label: 'Base path',
          default: '',
          showWhen: { field: 'providerId', equals: 'filesystem' },
        },
        {
          type: 'text',
          key: 'nodeId',
          label: 'Node',
          default: 'hub',
          showWhen: { field: 'providerId', in: ['filesystem'] },
        },
      ],
    },
    {
      id: 's3:connection',
      title: 'S3-compatible',
      columns: 2,
      fields: [
        {
          type: 'text',
          key: 's3.bucket',
          label: 'Bucket',
          default: '',
          showWhen: { field: 'providerId', equals: 's3' },
        },
      ],
    },
  ],
}

const FORM = {
  sections: [
    {
      id: 'connection',
      title: 'Filesystem',
      columns: 2,
      fields: [{ type: 'text', key: 'basePath', label: 'Base path', default: '' }],
    },
    {
      id: 'state',
      title: 'Node',
      columns: 2,
      fields: [{ type: 'text', key: 'nodeId', label: 'Node', default: 'hub' }],
    },
  ],
}

const LOCATIONS = [
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
  {
    ...loc('backups:default', 'backups', 'Backups', '/backups/backups', 1860, 1620),
    mode: 'readonly',
  },
]

export default defineFixtures({
  area: 'storage',
  description: 'Storage page: one default location per kind on a hub, filesystem provider.',
  handlers: {
    'storage.listLocations': LOCATIONS,
    'storage.listLocationDeclarations': DECLARATIONS,
    'storage.listDrainProgress': [],
    'capabilities.getCapability': (i: { name: string }) => ({
      name: i.name,
      mode: i.name === 'storage' ? 'collection' : 'singleton',
      providers: i.name === 'storage' ? ['storage-orchestrator'] : [i.name],
      activeProvider: i.name === 'storage' ? null : i.name,
      disabledProviders: [],
    }),
    'integrationInstances.describe': () => ({
      role: 'services',
      instanceMode: 'multiple',
      kind: 'location',
      canTest: true,
      mintsId: true,
      kinds: DECLARATIONS.map((d) => ({
        id: d.id,
        label: d.displayName,
        functionCap: 'storage',
        widgets: [{ id: 'storage/path-browser', placement: 'connection' }],
      })),
    }),
    'integrationInstances.instanceFormSchema': (i: { id?: string | null }) =>
      i.id === undefined || i.id === null || i.id === '' ? CREATE_FORM : FORM,
    'integrationInstances.listInstances': (i: { addonId: string }) =>
      i.addonId === 'storage-orchestrator'
        ? LOCATIONS.map((l) => ({
            id: l.id,
            name: l.displayName,
            kind: l.type,
            configured: true,
            enabled: l.mode === 'active',
            formValues: {
              providerId: 'fs',
              mode: l.mode,
              nodeId: 'hub',
              basePath: l.config.basePath,
            },
            status: { state: l.mode === 'active' ? 'ok' : 'off', label: l.mode },
          }))
        : [],
    'mut:integrationInstances.createInstance': { id: 'recordings:new' },
    'mut:integrationInstances.updateInstance': { ok: true },
    'mut:integrationInstances.setInstanceEnabled': { ok: true },
    'mut:integrationInstances.deleteInstance': { ok: true },
    'mut:integrationInstances.testInstance': { success: true, status: 'validated' },
    'alerts.list': [],
    'alerts.getUnreadCount': 0,
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
