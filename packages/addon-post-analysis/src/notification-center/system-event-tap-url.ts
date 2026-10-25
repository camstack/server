/**
 * system-event-tap-url — where a SYSTEM event's tap lands.
 *
 * A detection notification taps into the VIEWER (`default-tap-url.ts`): the
 * camera at that instant is what an operator wants to see. A system event has
 * no such picture. What it has is a thing an operator has to go and DO — apply
 * an addon update, restart a node, look at why a camera stopped streaming (or
 * whether it really came back) — and every one of those is an ADMIN UI page.
 * So this module maps a kind onto an admin route, and the notification carries
 * it as its `clickUrl`.
 *
 * Three properties are the whole design, and each one is a link that would
 * otherwise be worse than none:
 *
 *  - **The page must be able to ACT on the thing the event reports.** That is
 *    why `server-update-available` does not go to `/system/addons`: that page
 *    deliberately hides `@camstack/server` and every framework package
 *    (`Addons.tsx`, `FRAMEWORK_PACKAGE_NAMES`), so an operator sent there for a
 *    node's own update would find a list that does not contain it. The node's
 *    update/restart lives in the Cluster page's node card
 *    (`cluster/tabs/NodeServerManagementSection.tsx`), so that is where the
 *    link goes.
 *  - **The parameter must be one the TARGET PARSES.** `?node=` is read by
 *    `lib/node-url-selection.ts` on both `/system/nodes` and
 *    `/system/addons`; `?tab=` is read by `DeviceDetail`. A parameter nobody
 *    parses opens an unscoped page and the operator never notices they are
 *    looking at the wrong node.
 *  - **A stale event still lands somewhere honest.** These rows sit in the
 *    outbox and in history for days: the device may be deleted, the node may
 *    have left the cluster, the update may already be applied. None of those
 *    is a 404 — the admin UI is a SPA, so every path below renders. A deleted
 *    device renders "Device not found"; a node id that names nothing renders
 *    the default node AND says the link named a node that is no longer here
 *    (`NodeSelectionOutcome`); an applied update renders "up to date".
 *
 * Pure. The base URL comes from the notification endpoint ladder, the same
 * answer `defaultTapUrl` already uses, and no reachable base still means no
 * URL.
 */

import type { NcSystemEventKind } from '@camstack/types'

/**
 * The facts a system-event tap reads, and nothing else.
 *
 * All four already ride on the outbox row's `subject.systemEvent` — the intake
 * freezes `deviceId`, `deviceType` and `nodeId` at the moment the event
 * happened. Nothing here is joined at render time (CLAUDE.md: a cap mount
 * never composes addon output with backend state), which is also what makes
 * the link survive the event being old: the ids are the event's own.
 */
export interface NcSystemEventTapSubject {
  readonly kind: NcSystemEventKind
  /** Present on device-scoped kinds. `0` is the system placeholder, not a device. */
  readonly deviceId?: number
  /** `DeviceType`, as the intake stamped it. Absent on a row written before it. */
  readonly deviceType?: string
  /** The ONE node the event is about. Absent when it spans several, or none. */
  readonly nodeId?: string
  /**
   * The state-summary SECTION a per-section summary row is about (D698/D708,
   * `data.section`). Absent on every other row.
   */
  readonly summarySection?: string
}

/** The admin UI's own routes, as `packages/addon-admin-ui/src/App.tsx` declares them. */
const ADMIN_ADDONS_PATH = '/system/addons'
const ADMIN_NODES_PATH = '/system/nodes'
const ADMIN_DEVICES_PATH = '/devices'

/**
 * The query parameter naming a node.
 *
 * One spelling for both admin pages, mirrored by `NODE_PARAM` in
 * `packages/addon-admin-ui/src/lib/node-url-selection.ts` and pinned across
 * the two packages by `scripts/check-notification-tap-targets.ts`.
 */
const NODE_PARAM = 'node'

/** The device page's top-level tab parameter, read by `DeviceDetail`. */
const TAB_PARAM = 'tab'

/** The Stream Broker tab id — a `WELL_KNOWN_TABS` member, hoisted `top-tab`. */
const STREAM_BROKER_TAB = 'stream-broker'

/** `DeviceType.Camera`. Spelled here rather than imported so this stays a pure
 *  string map with no device-model dependency; the guard pins it. */
const CAMERA_DEVICE_TYPE = 'camera'

/** Kinds whose action is "go and apply an ADDON update". */
const ADDON_UPDATE_KINDS: ReadonlySet<NcSystemEventKind> = new Set<NcSystemEventKind>([
  'addon-update-available',
])

/** Kinds whose action is "go and apply a NODE's own (`@camstack/server`) update". */
const NODE_UPDATE_KINDS: ReadonlySet<NcSystemEventKind> = new Set<NcSystemEventKind>([
  'server-update-available',
  // The SHELL has no apply action anywhere — but the node card is still the
  // page that ANSWERS it: it shows the seed, the image-contract verdict and
  // the boot mode side by side, which is what "is my container old?" means.
  'wrapper-update-available',
])

/**
 * Kinds whose action is "go and look at this device's stream".
 *
 * BOTH DIRECTIONS. A recovery lands on the same page as the failure it undoes,
 * because "did it really come back, and what did it do while it was gone" is
 * an action and the page that answers it is the one the down-notification
 * already opened. On 2026-08-30 the operator's phone showed "Il dispositivo
 * Camera sala feste è online" with `tapAction.value: null` — the same
 * camera's `device-offline` an hour earlier opened the Stream Broker tab, and
 * the recovery opened nothing, purely because `device-online` had no entry
 * here.
 *
 * The legacy `camera-*` pair is here for the same reason both are still in the
 * enum: outbox and history rows enqueued before the rename carry them, and an
 * old row is exactly the one whose action has to keep working.
 *
 * Kinds NOT here are kinds whose DOWN direction has no action either
 * (`node-online`/`node-offline`, `device-enabled`/`device-disabled`) — a
 * recovery does not earn a destination its failure was never given.
 */
const DEVICE_STREAM_KINDS: ReadonlySet<NcSystemEventKind> = new Set<NcSystemEventKind>([
  'device-offline',
  'device-online',
  'stream-offline',
  'stream-online',
  'camera-offline',
  'camera-online',
])

/**
 * Kinds whose subject is a camera BY CONSTRUCTION, whatever the row says.
 *
 * A stream belongs to a camera and nothing else. The legacy `camera-*` pair is
 * too — that name is precisely the claim it made, and it is why the kind was
 * split into `device-*` + a `deviceTypes` condition.
 */
const CAMERA_BY_CONSTRUCTION_KINDS: ReadonlySet<NcSystemEventKind> = new Set<NcSystemEventKind>([
  'stream-offline',
  'stream-online',
  'camera-offline',
  'camera-online',
])

/**
 * Where a per-section STATE SUMMARY row lands (D708). The row spans nodes, so
 * no `?node=`: the unscoped page is the honest one. A section absent here taps
 * through its kind, like any other row — a device section carries the system
 * placeholder device and gets no link, and the crash-looped addons have none
 * (their instant kind has none either).
 *
 * `nodes` is the one destination no kind gives: a node going offline has no
 * instant action, but "which nodes are in trouble" is answered by the
 * Cluster page, and the summary row is about all of them at once.
 */
const SUMMARY_SECTION_PATHS: Readonly<Record<string, string>> = {
  nodes: ADMIN_NODES_PATH,
  'addon-updates': ADMIN_ADDONS_PATH,
  // `@camstack/server` and the container are answered on the Cluster page —
  // the Addons page hides the framework packages (see the header).
  updates: ADMIN_NODES_PATH,
}

function withParam(path: string, key: string, value: string | undefined): string {
  if (value === undefined || value.length === 0) return path
  return `${path}?${key}=${encodeURIComponent(value)}`
}

/**
 * The admin path (with its query) a system event taps through to, or `null`
 * when the kind has no action.
 *
 * Exported for the cross-package guard and for tests that want the path
 * without a base; the dispatcher goes through {@link systemEventTapUrl}.
 */
export function systemEventTapPath(subject: NcSystemEventTapSubject): string | null {
  const sectionPath =
    subject.summarySection !== undefined ? SUMMARY_SECTION_PATHS[subject.summarySection] : undefined
  if (sectionPath !== undefined) return sectionPath
  if (ADDON_UPDATE_KINDS.has(subject.kind)) {
    // No `?node=` when the event spans several nodes: there is no single
    // answer, and the unscoped page is the honest one.
    return withParam(ADMIN_ADDONS_PATH, NODE_PARAM, subject.nodeId)
  }
  if (NODE_UPDATE_KINDS.has(subject.kind)) {
    return withParam(ADMIN_NODES_PATH, NODE_PARAM, subject.nodeId)
  }
  if (DEVICE_STREAM_KINDS.has(subject.kind)) {
    const deviceId = subject.deviceId
    if (deviceId === undefined || !Number.isInteger(deviceId) || deviceId <= 0) return null
    const devicePath = `${ADMIN_DEVICES_PATH}/${String(deviceId)}`
    // The Stream Broker tab exists on cameras. A stream event IS a camera
    // event; a device event says which type it was. An unknown type gets the
    // device page plain rather than a tab this device may not have — the page
    // would fall back to Overview anyway, but a link that asks for a tab it
    // cannot know exists is a claim nobody checked.
    const isCamera =
      CAMERA_BY_CONSTRUCTION_KINDS.has(subject.kind) || subject.deviceType === CAMERA_DEVICE_TYPE
    return isCamera ? withParam(devicePath, TAB_PARAM, STREAM_BROKER_TAB) : devicePath
  }
  return null
}

/** Full URL, or `null` when the kind has no action or no base is reachable. */
export function systemEventTapUrl(
  subject: NcSystemEventTapSubject,
  baseUrl: string | null,
): string | null {
  if (baseUrl === null || baseUrl.length === 0) return null
  const path = systemEventTapPath(subject)
  if (path === null) return null
  return `${baseUrl.replace(/\/+$/, '')}${path}`
}
