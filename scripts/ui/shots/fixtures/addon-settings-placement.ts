/**
 * Where each addon's cluster settings are drawn (#578): System → Settings, the
 * Pipeline → Cluster → Settings cards, History, Notifications → Settings and
 * Nodes. The hub carries the addons whose schemas used to fill the System
 * page's per-addon tab strip, plus the four remote-storage addons that answer
 * `null` (not running on the hub). Each answer is a cut-down copy of the
 * addon's real cluster (or node) schema.
 *
 * List this area FIRST (`--fixtures addon-settings-placement,pipeline-cluster`):
 * the first area that has a handler answers.
 */
import { defineFixtures } from './_define'
import pipelineCluster from './pipeline-cluster'
import shell from './shell'

type Scope = 'cluster' | 'node' | 'device-defaults'

interface Declaration {
  readonly cap: string
  readonly scope: Scope
  readonly sectionIds: readonly string[]
}

interface Field {
  readonly key: string
  readonly type: 'number' | 'text' | 'boolean'
  readonly label: string
  readonly value: unknown
  readonly unit?: string
  readonly description?: string
}

interface Section {
  readonly id: string
  readonly title: string
  readonly fields: readonly Field[]
}

interface AddonForms {
  readonly name: string
  readonly forms: readonly (Declaration & { readonly sections: readonly Section[] })[]
}

const num = (key: string, label: string, value: number, unit?: string): Field => ({
  key,
  type: 'number',
  label,
  value,
  ...(unit !== undefined ? { unit } : {}),
})
const text = (key: string, label: string, value: string, description?: string): Field => ({
  key,
  type: 'text',
  label,
  value,
  ...(description !== undefined ? { description } : {}),
})

const cluster = (cap: string, sections: readonly Section[]) => ({
  cap,
  scope: 'cluster' as const,
  sectionIds: sections.map((s) => s.id),
  sections,
})
const node = (cap: string, sections: readonly Section[]) => ({
  cap,
  scope: 'node' as const,
  sectionIds: sections.map((s) => s.id),
  sections,
})

const ADDONS: Readonly<Record<string, AddonForms>> = {
  'alert-center': {
    name: 'Alert Center',
    forms: [
      cluster('alerts', [
        {
          id: 'alerts',
          title: 'Alert Center',
          fields: [
            num('maxAlerts', 'Maximum stored alerts', 500),
            num('retentionDays', 'Alert retention (days)', 30),
          ],
        },
      ]),
    ],
  },
  'device-history': {
    name: 'Device History',
    forms: [
      cluster('device-history', [
        {
          id: 'retention',
          title: 'Retention',
          fields: [
            num('rawDays', 'Raw points (days)', 7),
            num('fiveMinuteDays', '5-minute rollup (days)', 30),
            num('hourDays', '1-hour rollup (days)', 180),
            num('dayDays', '1-day rollup (days, 0 = forever)', 0),
            num('transitionDays', 'Device transitions (days)', 90),
          ],
        },
      ]),
    ],
  },
  'metrics-native': {
    name: 'Native Metrics',
    forms: [
      cluster('metrics-provider', [
        {
          id: 'native-metrics-settings',
          title: 'System Metrics',
          fields: [num('samplingIntervalMs', 'Sampling Interval', 5000, 'ms')],
        },
        {
          id: 'native-metrics-load-series',
          title: 'Load history',
          fields: [
            num('loadSeriesCadenceSec', 'Sampling cadence', 60, 's'),
            num('loadSeriesRetentionHours', 'Retention', 168, 'h'),
          ],
        },
      ]),
    ],
  },
  'stream-broker': {
    name: 'Stream Broker',
    forms: [
      node('stream-broker', [
        {
          id: 'stream-broker-node',
          title: 'Stream Broker',
          fields: [num('rtspPort', 'RTSP port', 8554)],
        },
      ]),
      cluster('stream-broker', [
        {
          id: 'stream-broker-settings',
          title: 'Stream Broker',
          fields: [
            num('defaultPreBufferSec', 'Pre-buffer Duration', 10, 's'),
            num('joinBurstMaxSpanMs', 'Join-burst bound', 2000, 'ms'),
            num('catalogReconcileIntervalSec', 'Catalog Reconcile Interval', 30, 's'),
          ],
        },
      ]),
    ],
  },
  snapshot: {
    name: 'Snapshot',
    forms: [
      cluster('snapshot', [
        {
          id: 'snapshot-cache',
          title: 'Snapshot Cache',
          fields: [num('staleTtlMs', 'Stale fallback TTL (ms)', 60_000)],
        },
      ]),
    ],
  },
  recorder: {
    name: 'Recorder',
    forms: [
      cluster('recording', [
        {
          id: 'cluster-recording',
          title: 'Cluster recording',
          fields: [
            text('recordingNodeId', 'Recording node', 'hub'),
            text(
              'recordingHubHostname',
              'Hub host (cross-node)',
              '',
              'The address a recording node uses to reach the hub.',
            ),
          ],
        },
      ]),
    ],
  },
  'embedding-encoder': {
    name: 'Embedding Encoder',
    forms: [
      cluster('embedding-encoder', [
        {
          id: 'embedding-encoder-settings',
          title: 'Embedding Encoder',
          fields: [text('modelId', 'Fallback model ID', 'clip-vit-b32')],
        },
      ]),
    ],
  },
  'osd-manager': {
    name: 'OSD Manager',
    forms: [
      cluster('osd-manager', [
        { id: 'osd-manager', title: 'OSD Manager', fields: [num('tickSeconds', 'Tick', 5, 's')] },
      ]),
    ],
  },
  'model-studio': {
    name: 'Model Studio',
    forms: [
      cluster('custom-model-registry', [
        {
          id: 'frigate-plus',
          title: 'Model catalog',
          fields: [text('plusCatalogPlusApiKey', 'Catalog API key', '')],
        },
      ]),
    ],
  },
  'pipeline-analytics': {
    name: 'Pipeline Analytics',
    forms: [
      cluster('pipeline-analytics', [
        {
          id: 'prune-windows',
          title: 'Prune windows',
          fields: [num('eventPruneDays', 'Event prune (days)', 30)],
        },
      ]),
      cluster('face-gallery', [
        {
          id: 'face-recognition',
          title: 'Face recognition',
          fields: [num('similarityThreshold', 'Similarity threshold', 0.6)],
        },
      ]),
    ],
  },
  'audio-analyzer': {
    name: 'Audio Analyzer',
    forms: [
      node('audio-analyzer', [
        {
          id: 'audio-backend',
          title: 'Audio backend',
          fields: [text('backend', 'Backend', 'auto')],
        },
      ]),
    ],
  },
  'pipeline-runner': {
    name: 'Pipeline Runner',
    forms: [
      node('pipeline-runner', [
        { id: 'runner', title: 'Runner', fields: [num('maxDecoders', 'Max decoders', 4)] },
      ]),
    ],
  },
}

/** Installed on the hub but not running there: the listing answers `null`. */
const NOT_RUNNING = ['sftp-storage', 's3-storage', 'webdav-storage', 'smb-storage']

function hubTopology(): readonly Record<string, unknown>[] {
  const rows = shell.handlers['nodes.topology']
  if (!Array.isArray(rows)) return []
  return rows
    .filter((row): row is Record<string, unknown> => typeof row === 'object' && row !== null)
    .map((row) =>
      row['isHub'] === true
        ? {
            ...row,
            addons: [...Object.entries(ADDONS), ...NOT_RUNNING.map((id) => [id, { name: id }])].map(
              ([id, a]) => ({
                id,
                name: typeof a === 'object' && a !== null && 'name' in a ? a.name : id,
                capabilities: [],
                status: 'running',
              }),
            ),
          }
        : row,
    )
}

interface ScopedInput {
  readonly addonId?: string
  readonly cap?: string
  readonly scope?: Scope
}

export default defineFixtures({
  area: 'addon-settings-placement',
  description:
    'Hub addons with cluster/node schemas (alerts, history, metrics, broker, snapshot, recorder, encoder…) and four remote-storage addons that answer null',
  handlers: {
    'nodes.topology': hubTopology(),
    'addonSettings.listScopedSettings': (input: ScopedInput) => {
      // The orchestrator's own form is the pipeline-cluster fixture's (load + failover).
      if (input.addonId === 'pipeline-orchestrator')
        return [
          { cap: 'pipeline-orchestrator', scope: 'cluster', sectionIds: ['load', 'failover'] },
        ]
      const addon = input.addonId === undefined ? undefined : ADDONS[input.addonId]
      if (addon === undefined) return null
      return addon.forms.map(({ cap, scope, sectionIds }) => ({ cap, scope, sectionIds }))
    },
    'addonSettings.getScopedSettings': (input: ScopedInput) => {
      const addon = input.addonId === undefined ? undefined : ADDONS[input.addonId]
      const form = addon?.forms.find((f) => f.cap === input.cap && f.scope === input.scope)
      if (form !== undefined) return { tabs: null, sections: form.sections }
      const fallback = pipelineCluster.handlers['addonSettings.getScopedSettings']
      return typeof fallback === 'function' ? fallback(input) : null
    },
  },
})
