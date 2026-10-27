/**
 * System-scoped caps. None is part of a DEVICE's vocabulary: they are the
 * cluster's own machinery, administered from their own pages. Each still has
 * an entry, so a new cap is a decision rather than an omission.
 */
import type { CapVocabularySlice, SystemCapVocabulary, SystemVocabCapName } from '../types.js'

function system(reason: string): SystemCapVocabulary {
  return { scope: 'system', notOperatorFacing: reason }
}

const UI_PLUMBING = 'admin UI plumbing — pages, widgets and routes, not something a device does'
const ADDON_ADMIN = 'addon administration — installed and configured from the Addons page'
const PIPELINE =
  'detection pipeline machinery — tuned on the pipeline pages, never actuated per device'
const STORAGE = 'storage administration — locations, retention and migrations, not a device action'
const IDENTITY = 'identity and access administration — users, sign-in and secrets'
const NETWORK = 'network administration of the cluster — addresses, mesh, tunnels'
const CLUSTER = 'cluster administration — nodes, server package, metrics'
const ML = 'model and training machinery — no device action'
const INTERNAL = 'internal plumbing between addons — never operator-facing'

/** Every system-scoped cap, with why it is not a device's vocabulary. */
export const SYSTEM_CAP_VOCABULARY: CapVocabularySlice<SystemVocabCapName> = {
  'action-source': system(INTERNAL),
  actions: system(
    'declared actions — run from the Actions page and from the cameras that link them',
  ),
  'addon-pages': system(UI_PLUMBING),
  'addon-pages-source': system(UI_PLUMBING),
  'addon-routes': system(UI_PLUMBING),
  'addon-settings': system(ADDON_ADMIN),
  'addon-widgets': system(UI_PLUMBING),
  'addon-widgets-source': system(UI_PLUMBING),
  addons: system(ADDON_ADMIN),
  'admin-ui': system(UI_PLUMBING),
  alerts: system('the alert centre — read and acknowledged on its own page'),
  'audio-analyzer': system(PIPELINE),
  'audio-codec': system(INTERNAL),
  'auth-provider': system(IDENTITY),
  backup: system('system backups — run and restored from the Backups page'),
  broker: system('message-broker connections — configured, not actuated'),
  'calendar-source': system(INTERNAL),
  calendars: system('calendars feed schedules and conditions, not device actions'),
  composer: system('device composition — an authoring tool, not an action'),
  'connection-test': system(INTERNAL),
  'core-blocks': system(INTERNAL),
  'custom-model-registry': system(ML),
  'data-store-provider': system(INTERNAL),
  'database-snapshot': system(INTERNAL),
  decoder: system(PIPELINE),
  'device-adoption': system('device adoption — an onboarding flow, not an action'),
  'device-credentials': system(IDENTITY),
  'device-export': system('exports to other ecosystems — configured on the export pages'),
  'device-history': system('recorded history of device state — read by charts, not actuated'),
  'device-manager': system(
    'the device registry itself — rename, move and remove are administration',
  ),
  'device-provider': system(INTERNAL),
  'device-removal-hook': system(INTERNAL),
  'device-state': system('the runtime-state mirror every trigger already reads through'),
  'display-palette': system(
    'the cluster display palette — one colour table for every client, not a device action',
  ),
  'embedding-encoder': system(ML),
  'face-gallery': system('the face gallery — curated on its own page'),
  'failure-contribution': system(INTERNAL),
  'filesystem-browse': system(INTERNAL),
  integrations: system(ADDON_ADMIN),
  keychain: system(IDENTITY),
  'keychain-admin': system(IDENTITY),
  llm: system(ML),
  'llm-runtime': system(ML),
  'load-contribution': system(INTERNAL),
  'local-network': system(NETWORK),
  'log-channels': system(INTERNAL),
  'log-destination': system(INTERNAL),
  'login-method': system(IDENTITY),
  'mesh-network': system(NETWORK),
  'metrics-provider': system(CLUSTER),
  'model-convert': system(ML),
  'model-distributor': system(ML),
  'mqtt-broker': system(NETWORK),
  'network-access': system(NETWORK),
  'network-quality': system(NETWORK),
  'node-certificates': system(IDENTITY),
  nodes: system(CLUSTER),
  'notification-output': system(
    'notification delivery — reached through notifier devices and rules',
  ),
  'notification-rules': system('notification rules — authored on their own page'),
  'oauth-integration': system(IDENTITY),
  'oidc-connections': system(IDENTITY),
  'osd-manager': system(PIPELINE),
  'pipeline-executor': system(PIPELINE),
  'pipeline-orchestrator': system(PIPELINE),
  'pipeline-runner': system(PIPELINE),
  'plate-gallery': system('the plate gallery — curated on its own page'),
  'platform-probe': system(CLUSTER),
  'record-entries': system(INTERNAL),
  'recording-archive': system(STORAGE),
  'recording-export': system(
    'recording exports — requested from the timeline, not an automation step',
  ),
  records: system(INTERNAL),
  'server-management': system(CLUSTER),
  'settings-store': system(INTERNAL),
  'smtp-provider': system(INTERNAL),
  'sso-bridge': system(IDENTITY),
  storage: system(STORAGE),
  'storage-admin': system(STORAGE),
  'storage-evictable': system(STORAGE),
  'storage-migration': system(STORAGE),
  'storage-occupancy': system(STORAGE),
  'storage-provider': system(STORAGE),
  'stream-broker': system(PIPELINE),
  system: system(CLUSTER),
  'terminal-session': system(CLUSTER),
  toast: system(UI_PLUMBING),
  training: system(ML),
  'training-provider': system(ML),
  'turn-provider': system(NETWORK),
  'user-management': system(IDENTITY),
  'user-passkeys': system(IDENTITY),
  'vector-store': system(INTERNAL),
  'viewer-ui': system(UI_PLUMBING),
}
