#!/usr/bin/env tsx
/**
 * A notification's tap URL lands on a page that PARSES it.
 *
 * A system-event notification carries an admin-UI link
 * (`packages/addon-post-analysis/src/notification-center/system-event-tap-url.ts`,
 * 2026-08-30): an available addon update opens `/system/addons?node=…`, a
 * node's own update opens `/system/nodes?node=…`, a camera that stopped
 * streaming opens `/devices/<id>?tab=stream-broker`.
 *
 * Every part of those strings is owned by a DIFFERENT package from the one
 * that mints them, and none of the couplings is visible to the compiler:
 *
 * | part | owner |
 * | --- | --- |
 * | the routes | `packages/addon-admin-ui/src/App.tsx` |
 * | `?node=` | `packages/addon-admin-ui/src/lib/node-url-selection.ts` |
 * | `stream-broker` | `WELL_KNOWN_TABS` in `@camstack/types` |
 * | `camera` | `DeviceType.Camera` in `@camstack/types` |
 *
 * Rename a route, rename the query param, retire a tab id — and the link keeps
 * being minted, keeps looking right in a test that only checks it is a string,
 * and silently opens an unscoped page. That is the failure this guard exists
 * for: an operator taps "update available on agent-a", reads the hub's
 * list, and nothing anywhere says he is on the wrong node.
 *
 * The check calls the REAL function rather than scraping it, so it also fails
 * when the mapping grows a destination nobody wired.
 *
 * Usage: tsx scripts/check-notification-tap-targets.ts
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

import { DeviceType, WELL_KNOWN_TABS } from '@camstack/types'
import type { NcSystemEventTapSubject } from '../packages/addon-post-analysis/src/notification-center/system-event-tap-url.js'
import { systemEventTapPath } from '../packages/addon-post-analysis/src/notification-center/system-event-tap-url.js'
import { NODE_PARAM } from '../packages/addon-admin-ui/src/lib/node-url-selection.js'
import { DEFAULT_DEVICE_TAB } from '../packages/addon-admin-ui/src/components/device/tabs/active-device-tab.js'

const ROOT = path.resolve(import.meta.dirname, '..')
const APP_TSX = path.join(ROOT, 'packages/addon-admin-ui/src/App.tsx')

interface Problem {
  readonly what: string
  readonly fix: string
}

/**
 * One event that must produce a working link, and the id that must survive
 * into it. Every mapped kind appears here — a destination added to the module
 * and not to this table is itself a failure (see {@link unmappedKinds}).
 */
interface TapCase {
  readonly label: string
  readonly subject: NcSystemEventTapSubject
  /** The route the admin UI must declare, in `App.tsx` spelling. */
  readonly route: string
  /** Substrings that must appear in the minted path. */
  readonly carries: readonly string[]
  /**
   * Substrings that must NOT appear. The one that earns its keep is
   * `/system/addons` on a server update: that route EXISTS, so a mis-routed
   * link passes every positive check while opening a page that hides
   * `@camstack/server`.
   */
  readonly forbids?: readonly string[]
}

const CASES: readonly TapCase[] = [
  {
    label: 'addon-update-available → the Addons page, scoped to its node',
    subject: { kind: 'addon-update-available', nodeId: 'agent-a' },
    route: '/system/addons',
    carries: [`${NODE_PARAM}=agent-a`],
  },
  {
    label: 'server-update-available → the Cluster page (Addons hides @camstack/server)',
    subject: { kind: 'server-update-available', nodeId: 'agent-a' },
    route: '/system/nodes',
    carries: [`${NODE_PARAM}=agent-a`],
    forbids: ['/system/addons'],
  },
  {
    // The shell has no apply action anywhere — but the node card is the page
    // that ANSWERS it (seed, image-contract verdict and boot mode side by
    // side). The Addons page hides framework packages entirely.
    label: 'wrapper-update-available → the Cluster page node card',
    subject: { kind: 'wrapper-update-available', nodeId: 'agent-a' },
    route: '/system/nodes',
    carries: [`${NODE_PARAM}=agent-a`],
    forbids: ['/system/addons'],
  },
  {
    label: 'stream-offline → the device page, Stream Broker tab',
    subject: { kind: 'stream-offline', deviceId: 102 },
    route: '/devices/:deviceId',
    carries: ['/devices/102', 'tab=stream-broker'],
  },
  {
    label: 'device-offline on a camera → the same',
    subject: { kind: 'device-offline', deviceId: 101, deviceType: DeviceType.Camera },
    route: '/devices/:deviceId',
    carries: ['/devices/101', 'tab=stream-broker'],
  },
  {
    label: 'device-offline on a non-camera → the device page, no stream tab',
    subject: { kind: 'device-offline', deviceId: 2018, deviceType: DeviceType.Switch },
    route: '/devices/:deviceId',
    carries: ['/devices/2018'],
  },
  // A RECOVERY lands where its failure lands. `device-online` had no entry
  // until 2026-08-30 and reached the operator's phone with no tap at all.
  {
    label: 'device-online on a camera → the same page as device-offline',
    subject: { kind: 'device-online', deviceId: 107, deviceType: DeviceType.Camera },
    route: '/devices/:deviceId',
    carries: ['/devices/107', 'tab=stream-broker'],
  },
  {
    label: 'stream-online → the device page, Stream Broker tab',
    subject: { kind: 'stream-online', deviceId: 102 },
    route: '/devices/:deviceId',
    carries: ['/devices/102', 'tab=stream-broker'],
  }, // A per-section STATE SUMMARY row (D708) lands by its section, unscoped:
  // the row is about every node at once.
  {
    label: 'summary section nodes → the Cluster page (node-offline has no instant tap)',
    subject: { kind: 'node-offline', summarySection: 'nodes' },
    route: '/system/nodes',
    carries: ['/system/nodes'],
  },
  {
    label: 'summary section addon-updates → the Addons page',
    subject: { kind: 'addon-updated', summarySection: 'addon-updates' },
    route: '/system/addons',
    carries: ['/system/addons'],
  },
  {
    label: 'summary section updates → the Cluster page (Addons hides @camstack/server)',
    subject: { kind: 'server-updated', summarySection: 'updates' },
    route: '/system/nodes',
    carries: ['/system/nodes'],
    forbids: ['/system/addons'],
  },
]

/** Every kind the mapping answers for, discovered by asking it. */
function mappedKinds(): readonly string[] {
  const probes: readonly NcSystemEventTapSubject[] = [
    { kind: 'addon-update-available', nodeId: 'n' },
    { kind: 'server-update-available', nodeId: 'n' },
    { kind: 'wrapper-update-available', nodeId: 'n' },
    { kind: 'device-offline', deviceId: 1 },
    { kind: 'device-online', deviceId: 1 },
    { kind: 'stream-offline', deviceId: 1 },
    { kind: 'stream-online', deviceId: 1 },
    { kind: 'camera-offline', deviceId: 1 },
    { kind: 'camera-online', deviceId: 1 },
  ]
  return probes.filter((p) => systemEventTapPath(p) !== null).map((p) => p.kind)
}

/** Routes the admin UI declares, as literal `path="…"` values in `App.tsx`. */
function declaredRoutes(): ReadonlySet<string> {
  const source = fs.readFileSync(APP_TSX, 'utf8')
  const routes = new Set<string>()
  for (const match of source.matchAll(/path=\{?["'`]([^"'`]+)["'`]/g)) {
    routes.add(match[1]!)
  }
  return routes
}

function main(): void {
  const problems: Problem[] = []
  const routes = declaredRoutes()

  if (routes.size === 0) {
    problems.push({
      what: `no <Route path="…"> found in ${path.relative(ROOT, APP_TSX)}`,
      fix: 'the route scrape broke — fix this guard before trusting it',
    })
  }

  for (const testCase of CASES) {
    const minted = systemEventTapPath(testCase.subject)
    if (minted === null) {
      problems.push({
        what: `${testCase.label}: the mapping now returns no link`,
        fix: 'a kind that had an action must not silently lose it',
      })
      continue
    }
    if (!routes.has(testCase.route)) {
      problems.push({
        what: `${testCase.label}: minted "${minted}" but the admin UI declares no route "${testCase.route}"`,
        fix: 'the route was renamed — update system-event-tap-url.ts and this table together',
      })
    }
    for (const fragment of testCase.carries) {
      if (!minted.includes(fragment)) {
        problems.push({
          what: `${testCase.label}: minted "${minted}", which does not carry "${fragment}"`,
          fix: 'a link that loses its id opens an unscoped page and nobody notices',
        })
      }
    }
    for (const fragment of testCase.forbids ?? []) {
      if (minted.includes(fragment)) {
        problems.push({
          what: `${testCase.label}: minted "${minted}", which must never name "${fragment}"`,
          fix: 'that page cannot act on this event — see D305',
        })
      }
    }
  }

  // `stream-broker` must still be a tab id the device page can resolve.
  const tabIds = new Set(WELL_KNOWN_TABS.map((tab) => tab.id))
  if (!tabIds.has('stream-broker')) {
    problems.push({
      what: '`stream-broker` is no longer a WELL_KNOWN_TABS id',
      fix: 'the device tap URL names it; retire the link in the same commit as the tab',
    })
  }
  if (!tabIds.has(DEFAULT_DEVICE_TAB)) {
    problems.push({
      what: `the device page's fallback tab \`${DEFAULT_DEVICE_TAB}\` is not a WELL_KNOWN_TABS id`,
      fix: 'a stale ?tab= falls through to it — it has to exist',
    })
  }

  // The kind list is asserted so a destination added without a route check
  // cannot ride in unnoticed.
  const expected = [
    'addon-update-available',
    'server-update-available',
    'wrapper-update-available',
    'device-offline',
    'device-online',
    'stream-offline',
    'stream-online',
    'camera-offline',
    'camera-online',
  ]
  const unmapped = mappedKinds()
  const missing = expected.filter((kind) => !unmapped.includes(kind))
  if (missing.length > 0) {
    problems.push({
      what: `these kinds lost their tap action: ${missing.join(', ')}`,
      fix: 'an action removed on purpose is removed from this list in the same commit',
    })
  }

  if (problems.length > 0) {
    console.error(`\x1b[31m✘ ${problems.length} notification tap-target problem(s)\x1b[0m:`)
    for (const problem of problems) {
      console.error(`    ${problem.what}`)
      console.error(`      → ${problem.fix}`)
    }
    console.error(
      '    Why this matters: a link that lands on a page which cannot honour its parameter is worse than no link.',
    )
    process.exit(1)
  }
  console.log('  ✔ every system-event tap URL names a route the admin UI declares')
}

main()
