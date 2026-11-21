/**
 * System → API explorer (`/system/settings?tab=api-explorer`, planning#595):
 * a short invented catalogue — queries, mutations, a subscription, a public
 * method, capability and core routes — and one input schema with an enum, a
 * required id and a defaulted field.
 */
import { defineFixtures } from './_define'

interface ShotMethod {
  readonly path: string
  readonly kind: 'query' | 'mutation' | 'subscription'
  readonly tier: 'public' | 'protected' | 'admin'
  readonly cap: { readonly name: string; readonly access: 'read' | 'write' } | null
  readonly hasInput: boolean
}

const RAW: readonly ShotMethod[] = [
  { path: 'addons.list', kind: 'query', tier: 'protected', cap: null, hasInput: false },
  { path: 'addons.restart', kind: 'mutation', tier: 'admin', cap: null, hasInput: true },
  { path: 'apiCatalog.inputSchema', kind: 'query', tier: 'admin', cap: null, hasInput: true },
  { path: 'apiCatalog.list', kind: 'query', tier: 'admin', cap: null, hasInput: false },
  { path: 'auth.status', kind: 'query', tier: 'public', cap: null, hasInput: false },
  {
    path: 'deviceManager.getDevice',
    kind: 'query',
    tier: 'protected',
    cap: { name: 'device-manager', access: 'read' },
    hasInput: true,
  },
  {
    path: 'deviceManager.setDisabled',
    kind: 'mutation',
    tier: 'admin',
    cap: { name: 'device-manager', access: 'write' },
    hasInput: true,
  },
  { path: 'events.onEvent', kind: 'subscription', tier: 'protected', cap: null, hasInput: true },
  {
    path: 'recording.getConfig',
    kind: 'query',
    tier: 'protected',
    cap: { name: 'recording', access: 'read' },
    hasInput: true,
  },
  {
    path: 'recording.setConfig',
    kind: 'mutation',
    tier: 'admin',
    cap: { name: 'recording', access: 'write' },
    hasInput: true,
  },
  { path: 'system.info', kind: 'query', tier: 'protected', cap: null, hasInput: false },
  { path: 'ptz.moveTo', kind: 'mutation', tier: 'protected', cap: null, hasInput: true },
  { path: 'snapshot.capture', kind: 'mutation', tier: 'protected', cap: null, hasInput: true },
  {
    path: 'pipelineOrchestrator.getConfig',
    kind: 'query',
    tier: 'admin',
    cap: null,
    hasInput: false,
  },
  { path: 'storage.getUsage', kind: 'query', tier: 'protected', cap: null, hasInput: false },
  { path: 'notificationRules.list', kind: 'query', tier: 'admin', cap: null, hasInput: false },
  { path: 'integrations.list', kind: 'query', tier: 'admin', cap: null, hasInput: false },
  { path: 'userManagement.listUsers', kind: 'query', tier: 'admin', cap: null, hasInput: false },
  { path: 'newFeature.status', kind: 'query', tier: 'protected', cap: null, hasInput: false },
]

const SHOT_DESCRIPTIONS: Readonly<Record<string, string>> = {
  'deviceManager.getDevice': 'One device by id, with its kind, name, owning integration and state.',
  'deviceManager.setDisabled':
    'Disable or re-enable a device. A disabled device is reported off, never broken, and keeps its history.',
  'recording.getConfig': 'The recording bands and retention one camera is configured with.',
  'recording.setConfig':
    'Replace one camera recording configuration; the recorder re-reads it at once.',
}

const METHODS = RAW.map((m) => {
  const dot = m.path.lastIndexOf('.')
  return {
    path: m.path,
    router: m.path.slice(0, dot),
    method: m.path.slice(dot + 1),
    kind: m.kind,
    tier: m.tier,
    source: m.cap === null ? 'core' : 'capability',
    scope:
      m.cap === null
        ? null
        : { capName: m.cap.name, capScope: 'device', access: m.cap.access, role: 'viewer' },
    hasInput: m.hasInput,
    // Only capability routes carry a description (from the cap's own JSDoc).
    description: SHOT_DESCRIPTIONS[m.path] ?? null,
    // A device grant alone reaches getDevice: the explorer says it depends on the device.
    callable: m.path === 'deviceManager.getDevice' ? 'per-device' : 'yes',
  }
})

const SET_DISABLED_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    deviceId: { type: 'integer', minimum: 1 },
    disabled: { type: 'boolean' },
    reason: { type: 'string', enum: ['operator', 'maintenance'], default: 'operator' },
    durationMinutes: { type: 'integer', minimum: 1, maximum: 1440, default: 30 },
    keepRecording: { type: 'boolean', default: true },
  },
  required: ['deviceId', 'disabled'],
  additionalProperties: false,
}

export default defineFixtures({
  area: 'api-explorer',
  description: 'API explorer: an invented method catalogue and one input schema',
  handlers: {
    'apiCatalog.list': { methods: METHODS },
    'apiCatalog.inputSchema': (input: { readonly path?: string } | undefined) => ({
      path: input?.path ?? '',
      hasInput: true,
      schema: SET_DISABLED_SCHEMA,
      error: null,
    }),
  },
})
