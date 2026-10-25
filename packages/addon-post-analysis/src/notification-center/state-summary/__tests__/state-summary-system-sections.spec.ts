/**
 * D708 — the SYSTEM sections of a scheduled state summary, split per section.
 *
 * - Four groups: nodes with problems, addons stopped (crash-loop), addon
 *   updates, server updates (server + container). `addons` and
 *   `addon-updates` are two sections, so a crash and an update are two pushes.
 * - An update section's body is ONE HEADING PER NODE: the hub first, then by
 *   name; the lines under a heading do not repeat the node.
 * - A per-section row carries the rule's first selected kind OF THAT SECTION,
 *   and taps through to the section's own admin page.
 * - A rule saved with the pre-D708 kinds keeps working: sections are derived
 *   from the kinds, nothing is stored about them.
 */
import { NcRuleInputSchema, type NcRule, type NcSystemEventKind } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { systemEventTapPath } from '../../system-event-tap-url.js'
import { NcTextCatalog } from '../../text-catalog.js'
import type { NcLivenessRow } from '../../liveness-ledger.js'
import { type NcNodeView, type NcStateSourcePorts, stateSources } from '../state-sources.js'
import { sectionsOfRule } from '../state-model.js'
import { collectStateSummary, stateSummaryText } from '../state-summary.js'
import {
  NC_STATE_SUMMARY_SECTION_TITLE_KEY,
  sectionKindOf,
  stateSummarySectionOf,
  stateSummarySubjects,
} from '../state-summary-delivery.js'
import type { NcSystemStateRow } from '../system-state-ledger.js'

const NOW = Date.UTC(2026, 9, 6, 8, 0)
const WINDOW = { startMs: NOW - 60_000, endMs: NOW }

function addonUpdate(nodeId: string, packageName: string): NcSystemStateRow {
  return {
    key: `update:addon:${nodeId}:${packageName}`,
    kind: 'addon-update-available',
    since: NOW - 60_000,
    nodeId,
    packageName,
    params: { packageName, currentVersion: '1.0.0', latestVersion: '1.0.1', nodeId },
  }
}

const SERVER_UPDATE: NcSystemStateRow = {
  key: 'update:server:hub:@camstack/server',
  kind: 'server-update-available',
  since: NOW - 120_000,
  nodeId: 'hub',
  packageName: '@camstack/server',
  params: {
    packageName: '@camstack/server',
    currentVersion: '1.2.377',
    latestVersion: '1.2.378',
    nodeId: 'hub',
  },
}

const WRAPPER_UPDATE: NcSystemStateRow = {
  key: 'update:wrapper:agent-mac:shell',
  kind: 'wrapper-update-available',
  since: NOW - 120_000,
  nodeId: 'agent-mac',
  packageName: 'shell',
  params: { currentVersion: '1.0', latestVersion: '1.1', nodeId: 'agent-mac' },
}

const CRASH_LOOP: NcSystemStateRow = {
  key: 'crash-loop:agent-mac',
  kind: 'addon-crash-loop',
  since: NOW - 600_000,
  nodeId: 'agent-mac',
  params: { nodeId: 'agent-mac', addons: 'recorder' },
}

const NODE_OFFLINE: NcLivenessRow = {
  subject: 'node:agent-unraid',
  state: 'offline',
  kind: 'node-offline',
  updatedAt: NOW - 3_600_000,
}

/** Known nodes: the hub is NOT first by name ("zz-hub"), so the order is proved by `isHub`. */
const NODES: Readonly<Record<string, { name: string; isHub: boolean; online: boolean }>> = {
  hub: { name: 'zz-hub', isHub: true, online: true },
  'agent-mac': { name: 'Mac mini', isHub: false, online: true },
  'agent-unraid': { name: 'agent-a', isHub: false, online: false },
}

const VIEW: NcNodeView = {
  complete: true,
  online: (id) => NODES[id]?.online,
  describe: (id) => NODES[id],
}

function ports(over: Partial<NcStateSourcePorts> = {}): NcStateSourcePorts {
  return {
    alerts: () => [],
    liveness: () => [NODE_OFFLINE],
    state: () => [
      addonUpdate('agent-unraid', '@camstack/addon-recorder'),
      addonUpdate('hub', '@camstack/addon-onvif'),
      addonUpdate('agent-mac', '@camstack/addon-recorder'),
      SERVER_UPDATE,
      WRAPPER_UPDATE,
      CRASH_LOOP,
    ],
    lookup: () => undefined,
    devicesAnswered: () => true,
    nodes: VIEW,
    livenessHoldoffMs: 5 * 60_000,
    ...over,
  }
}

function ruleOf(kinds: readonly NcSystemEventKind[]): NcRule {
  return {
    ...NcRuleInputSchema.parse({
      name: 'Sistema',
      delivery: 'system-event',
      conditions: { systemEvent: { kinds } },
      targets: [{ targetId: 't' }],
    }),
    id: 'rule-sys',
    createdBy: 'admin',
    createdAt: 0,
    updatedAt: 0,
    enabled: true,
    disabledTargetIds: [],
  }
}

/** The operator's live rule's shape (2026-10-06) plus `addon-crash-loop`. */
const RULE = ruleOf([
  'addon-update-available',
  'addon-updated',
  'server-update-available',
  'server-updated',
  'wrapper-update-available',
  'node-offline',
  'node-online',
  'node-inference-unavailable',
  'addon-crash-loop',
])

function rows(language: 'en' | 'it', over: Partial<NcStateSourcePorts> = {}, rule = RULE) {
  const texts = new NcTextCatalog({ language })
  const summary = collectStateSummary({
    rule,
    sources: stateSources(ports(over)),
    nowMs: NOW,
    isMuted: () => false,
  })
  const text = stateSummaryText({ texts, summary, nowMs: NOW, timeZone: 'UTC' })
  const subjects = stateSummarySubjects({ rule, summary, text, window: WINDOW, split: 'section' })
  const title = (section: string): string | undefined => {
    const row = subjects.find((subject) => stateSummarySectionOf(subject) === section)
    const params = row?.systemEvent?.textParams
    return params === undefined
      ? undefined
      : texts.text({ key: NC_STATE_SUMMARY_SECTION_TITLE_KEY, vars: params })
  }
  return { subjects, text, title }
}

const bodyOf = (subjects: ReturnType<typeof rows>['subjects'], section: string) =>
  subjects.find((subject) => stateSummarySectionOf(subject) === section)?.systemEvent?.textParams?.[
    'summaryText'
  ]

describe('D708 — system sections of a split state summary', () => {
  it('fans out to nodes, addons stopped, addon updates and server updates — one row each', () => {
    const { subjects } = rows('en')
    expect(subjects.map((subject) => stateSummarySectionOf(subject))).toEqual([
      'nodes',
      'addons',
      'addon-updates',
      'updates',
    ])
  })

  it('titles each row by its group, in EN and IT', () => {
    const en = rows('en')
    expect(en.title('nodes')).toBe('Nodes with problems: 1')
    expect(en.title('addons')).toBe('Addons stopped: 1')
    expect(en.title('addon-updates')).toBe('Addon updates: 3')
    expect(en.title('updates')).toBe('Server updates: 2')
    const it_ = rows('it')
    expect(it_.title('nodes')).toBe('Nodi con problemi: 1')
    expect(it_.title('addons')).toBe('Addon fermati: 1')
    expect(it_.title('addon-updates')).toBe('Aggiornamenti addon: 3')
    expect(it_.title('updates')).toBe('Aggiornamenti server: 2')
  })

  it('an update body has one heading per node — the hub first, then by name', () => {
    const { subjects } = rows('en')
    expect(bodyOf(subjects, 'addon-updates')).toBe(
      [
        'zz-hub:',
        '• @camstack/addon-onvif 1.0.0 → 1.0.1',
        'agent-a:',
        '• @camstack/addon-recorder 1.0.0 → 1.0.1',
        'Mac mini:',
        '• @camstack/addon-recorder 1.0.0 → 1.0.1',
      ].join('\n'),
    )
    expect(bodyOf(subjects, 'updates')).toBe(
      [
        'zz-hub:',
        '• @camstack/server 1.2.377 → 1.2.378',
        'Mac mini:',
        '• Container 1.0 → 1.1',
      ].join('\n'),
    )
  })

  it('the combined (one-message) text carries the same per-node blocks under the section title', () => {
    const { text } = rows('en')
    expect(text.text).toContain('Addon updates:\nzz-hub:\n• @camstack/addon-onvif 1.0.0 → 1.0.1')
  })

  it('a node the directory does not name is headed by its id, and the hub id is first', () => {
    const view: NcNodeView = { complete: true, online: (id) => NODES[id]?.online }
    const { subjects } = rows('en', { nodes: view })
    expect(bodyOf(subjects, 'addon-updates')?.split('\n')[0]).toBe('hub:')
    expect(bodyOf(subjects, 'addon-updates')).toContain('agent-mac:')
  })

  it("each row carries the first selected kind OF ITS SECTION, never the rule's first kind", () => {
    const { subjects } = rows('en')
    const kindOf = (section: string) =>
      subjects.find((subject) => stateSummarySectionOf(subject) === section)?.systemEvent?.kind
    expect(kindOf('nodes')).toBe('node-offline')
    expect(kindOf('addons')).toBe('addon-crash-loop')
    expect(kindOf('addon-updates')).toBe('addon-update-available')
    expect(kindOf('updates')).toBe('server-update-available')
    // The rule's own order decides inside a section.
    expect(sectionKindOf(['addon-updated', 'addon-update-available'], 'addon-updates')).toBe(
      'addon-updated',
    )
  })

  it('each row taps through to its section page, unscoped', () => {
    const { subjects } = rows('en')
    const tap = (section: string): string | null => {
      const row = subjects.find((subject) => stateSummarySectionOf(subject) === section)
      const event = row?.systemEvent
      if (event === undefined) throw new Error(`no ${section} row`)
      return systemEventTapPath({ kind: event.kind, summarySection: section })
    }
    expect(tap('nodes')).toBe('/system/nodes')
    expect(tap('addon-updates')).toBe('/system/addons')
    expect(tap('updates')).toBe('/system/nodes')
    // A crash-looped addon has no instant action and gets none here either.
    expect(tap('addons')).toBeNull()
    // A rule that selected only `server-updated` still lands on the Cluster page.
    expect(systemEventTapPath({ kind: 'server-updated', summarySection: 'updates' })).toBe(
      '/system/nodes',
    )
  })

  it('a group with nothing open sends nothing', () => {
    const { subjects } = rows('en', { state: () => [CRASH_LOOP], liveness: () => [] })
    expect(subjects.map((subject) => stateSummarySectionOf(subject))).toEqual(['addons'])
  })

  it('an unreadable group sends its "unavailable" sentence (IT)', () => {
    const { subjects } = rows('it', { nodes: { complete: false, online: () => true } })
    expect(bodyOf(subjects, 'addon-updates')).toBe(
      'Aggiornamenti addon: non disponibile — lo stato non è leggibile',
    )
    expect(bodyOf(subjects, 'nodes')).toBe(
      'Nodi con problemi: non disponibile — lo stato non è leggibile',
    )
  })

  it('a rule saved with the pre-D708 addon kinds keeps working — sections come from its kinds', () => {
    const legacy = ruleOf(['addon-crash-loop', 'addon-update-available', 'addon-updated'])
    const condition = legacy.conditions.systemEvent
    if (condition === undefined) throw new Error('no condition')
    expect(sectionsOfRule(condition)).toEqual(['addons', 'addon-updates'])
    const updatesOnly = ruleOf(['addon-update-available'])
    const { subjects } = rows('en', {}, updatesOnly)
    expect(subjects.map((subject) => stateSummarySectionOf(subject))).toEqual(['addon-updates'])
  })
})
