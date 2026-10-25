/**
 * The log viewer (`/system/logs`, a device's Logs panel, the node Logs tabs):
 * one page of invented history and the source list (`logs.query` is paged and
 * newest-first, D898). A request with a `before` cursor answers the end of the
 * logs so the "Beginning of logs" row renders after a scroll to the top.
 */
import { defineFixtures } from './_define'
import { iso, NOW, MINUTE } from './_time'

interface Row {
  readonly id: string
  readonly ageMin: number
  readonly level: 'debug' | 'info' | 'warn' | 'error'
  readonly scope: string
  readonly message: string
  readonly tags?: Record<string, string>
}

// Newest first, like the server.
const ROWS: readonly Row[] = [
  {
    id: 'l-08',
    ageMin: 1,
    level: 'warn',
    scope: 'addon:provider-onvif',
    message: 'Camera 192.0.2.41 answered slowly (2.4 s); retrying the snapshot request',
    tags: { deviceId: '101', addonId: 'provider-onvif' },
  },
  {
    id: 'l-07',
    ageMin: 3,
    level: 'info',
    scope: 'addon:recorder',
    message: 'Segment closed for Driveway (12.0 s, 1.8 MB)',
    tags: { deviceId: '101', addonId: 'recorder' },
  },
  {
    id: 'l-06',
    ageMin: 6,
    level: 'info',
    scope: 'hub',
    message: 'Agent garage-nuc (192.0.2.21) reported healthy',
    tags: { nodeId: 'garage-nuc' },
  },
  {
    id: 'l-05',
    ageMin: 9,
    level: 'error',
    scope: 'addon:notifier-mail',
    message: 'Could not deliver to alerts@example.com: connection refused by mail.example.com',
    tags: { addonId: 'notifier-mail' },
  },
  {
    id: 'l-04',
    ageMin: 14,
    level: 'debug',
    scope: 'addon:pipeline-orchestrator',
    message: 'Pipeline tick: 2 cameras, 0 dropped frames',
    tags: { addonId: 'pipeline-orchestrator' },
  },
  {
    id: 'l-03',
    ageMin: 22,
    level: 'info',
    scope: 'addon:provider-onvif',
    message: 'Discovered 1 device on 198.51.100.0/24',
    tags: { addonId: 'provider-onvif' },
  },
  {
    id: 'l-02',
    ageMin: 31,
    level: 'warn',
    scope: 'hub',
    message: 'Disk usage at 82% on the recordings location',
  },
  {
    id: 'l-01',
    ageMin: 44,
    level: 'info',
    scope: 'hub',
    message: 'Hub started',
  },
]

function page(): unknown {
  return {
    entries: ROWS.map((row) => ({
      id: row.id,
      timestamp: iso(NOW - row.ageMin * MINUTE),
      level: row.level,
      scope: row.scope,
      message: row.message,
      ...(row.tags ? { tags: row.tags } : {}),
    })),
    nextBefore: 'cursor-older',
    nextAfter: null,
    scannedBytes: 262_144,
    done: false,
    source: 'winston-logging',
  }
}

const END = {
  entries: [],
  nextBefore: null,
  nextAfter: null,
  scannedBytes: 0,
  done: true,
  source: 'winston-logging',
}

export default defineFixtures({
  area: 'logs',
  description: 'Log viewer: a paged history answer and the log sources',
  handlers: {
    'logs.query': (input: unknown) =>
      typeof input === 'object' && input !== null && 'before' in input ? END : page(),
    'logs.sources': [
      {
        addonId: 'winston-logging',
        readable: true,
        reason: null,
        isDefault: true,
        retentionDays: 14,
        filters: {
          deviceId: true,
          addonId: true,
          nodeId: true,
          tags: true,
          level: true,
          text: true,
          timeRange: true,
        },
      },
    ],
  },
})
