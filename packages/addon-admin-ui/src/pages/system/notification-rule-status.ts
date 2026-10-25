import i18n from '../../i18n/index'
/**
 * The client half of `nc.getRuleStatus` — the LIVE line under a rule's title.
 *
 * WHY THE SHAPES ARE HAND-WRITTEN
 * ──────────────────────────────
 * Same reason as `notification-simulate.helpers.ts`: the authority is
 * `rule-status.ts` in `addon-post-analysis`, an addon-internal Zod schema
 * reached through the generic `addons.custom` bridge whose input and output are
 * both `z.unknown()`. There is no generated client type to infer from and the
 * admin UI may not import an addon's source, so the shapes are mirrored here
 * ONCE, next to the parser that checks them at runtime. A drift then shows up as
 * "the hub answered something this build cannot read" — never as a silently
 * wrong render.
 *
 * Everything here is pure: the parser, and the two sentence builders the card
 * renders. The sentences are the whole feature (an operator reads "occupied for
 * 14 min", not a JSON blob) and they are unit-tested for that reason.
 */

/** The addon hosting the notification centre. */
export const NC_ADDON_ID = 'pipeline-analytics'
export const NC_RULE_STATUS_ACTION = 'nc.getRuleStatus'
export const NC_TEST_RULE_ACTION = 'nc.testRule'

export type NcOccupancyUnavailable = 'no-snapshot' | 'zone-absent'

export interface NcOccupancyStatus {
  readonly kind: 'occupancy'
  readonly deviceId: number
  readonly scope?: string
  readonly className?: string
  readonly threshold: number
  readonly sustainSeconds: number
  readonly count?: number
  readonly occupied?: boolean
  readonly observedAt?: number
  readonly since?: number
  readonly unavailable?: NcOccupancyUnavailable
  readonly warning?: string
}

export interface NcTimelapseArtifactSummary {
  readonly id: string
  readonly mediaType: string
  readonly sizeBytes: number
  readonly capturedAt: number
  readonly downloadPath: string
}

export interface NcTimelapseDeviceStatus {
  readonly deviceId: number
  readonly lastGeneratedAt?: number
  readonly lastArtifact?: NcTimelapseArtifactSummary
  readonly rendering?: {
    readonly startedAt: number
    readonly windowStartMs: number
    readonly windowEndMs: number
  }
}

export interface NcTimelapseStatus {
  readonly kind: 'timelapse'
  readonly devices: readonly NcTimelapseDeviceStatus[]
  readonly lastWindow?: { readonly startMs: number; readonly endMs: number }
  readonly nextWindow?: { readonly startMs: number; readonly endMs: number | null }
  readonly settleMs: number
}

/** One open window of a grouped rule (D692 §7). */
export interface NcGroupedWindowStatus {
  readonly deviceId: number
  readonly windowKey: string
  readonly openedAt: number
  /** The latest the window closes (`openedAt + groupingSec`); it may close earlier. */
  readonly closesAt: number
  readonly members: number
  /** Members whose recognition outlook is not final yet. */
  readonly pending: number
}

export interface NcGroupedStatus {
  readonly kind: 'grouped'
  readonly groupingSec: number
  /** `null` = UNKNOWN (D315): the node could not say, which is not "no window open". */
  readonly openWindows: readonly NcGroupedWindowStatus[] | null
  /** Why the windows are unknown, when they are. */
  readonly reason?: string
}

export interface NcNoStatus {
  readonly kind: 'none'
  readonly reason: string
}

export type NcRuleStatus = NcOccupancyStatus | NcTimelapseStatus | NcGroupedStatus | NcNoStatus

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function num(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function str(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function parseArtifact(value: unknown): NcTimelapseArtifactSummary | undefined {
  if (!isRecord(value)) return undefined
  const id = str(value, 'id')
  const downloadPath = str(value, 'downloadPath')
  const capturedAt = num(value, 'capturedAt')
  if (id === undefined || downloadPath === undefined || capturedAt === undefined) return undefined
  return {
    id,
    mediaType: str(value, 'mediaType') ?? 'video',
    sizeBytes: num(value, 'sizeBytes') ?? 0,
    capturedAt,
    downloadPath,
  }
}

function parseWindow(value: unknown): { startMs: number; endMs: number } | undefined {
  if (!isRecord(value)) return undefined
  const startMs = num(value, 'startMs')
  const endMs = num(value, 'endMs')
  if (startMs === undefined || endMs === undefined) return undefined
  return { startMs, endMs }
}

function parseDevice(value: unknown): NcTimelapseDeviceStatus | null {
  if (!isRecord(value)) return null
  const deviceId = num(value, 'deviceId')
  if (deviceId === undefined) return null
  const lastGeneratedAt = num(value, 'lastGeneratedAt')
  const artifact = parseArtifact(value['lastArtifact'])
  const renderingRaw = value['rendering']
  const rendering = isRecord(renderingRaw)
    ? {
        startedAt: num(renderingRaw, 'startedAt') ?? 0,
        windowStartMs: num(renderingRaw, 'windowStartMs') ?? 0,
        windowEndMs: num(renderingRaw, 'windowEndMs') ?? 0,
      }
    : undefined
  return {
    deviceId,
    ...(lastGeneratedAt !== undefined ? { lastGeneratedAt } : {}),
    ...(artifact !== undefined ? { lastArtifact: artifact } : {}),
    ...(rendering !== undefined ? { rendering } : {}),
  }
}

function parseGroupedWindow(value: unknown): NcGroupedWindowStatus | null {
  if (!isRecord(value)) return null
  const deviceId = num(value, 'deviceId')
  const windowKey = str(value, 'windowKey')
  const openedAt = num(value, 'openedAt')
  const closesAt = num(value, 'closesAt')
  const members = num(value, 'members')
  const pending = num(value, 'pending')
  if (
    deviceId === undefined ||
    windowKey === undefined ||
    openedAt === undefined ||
    closesAt === undefined ||
    members === undefined ||
    pending === undefined
  ) {
    return null
  }
  return { deviceId, windowKey, openedAt, closesAt, members, pending }
}

/**
 * Narrow the bridge's `unknown` answer, or return `null`.
 *
 * `null` renders as "this build could not read the hub's answer", which is the
 * honest reading of a hub that predates the action. Rendering an empty card
 * instead would look like "nothing is happening", a completely different fact.
 */
export function parseRuleStatus(value: unknown): NcRuleStatus | null {
  if (!isRecord(value)) return null
  const kind = str(value, 'kind')
  if (kind === 'none') return { kind: 'none', reason: str(value, 'reason') ?? '' }
  if (kind === 'occupancy') {
    const deviceId = num(value, 'deviceId')
    const threshold = num(value, 'threshold')
    const sustainSeconds = num(value, 'sustainSeconds')
    if (deviceId === undefined || threshold === undefined || sustainSeconds === undefined) {
      return null
    }
    const unavailableRaw = str(value, 'unavailable')
    const unavailable: NcOccupancyUnavailable | undefined =
      unavailableRaw === 'no-snapshot' || unavailableRaw === 'zone-absent'
        ? unavailableRaw
        : undefined
    const count = num(value, 'count')
    const observedAt = num(value, 'observedAt')
    const since = num(value, 'since')
    const scope = str(value, 'scope')
    const className = str(value, 'className')
    const warning = str(value, 'warning')
    return {
      kind: 'occupancy',
      deviceId,
      threshold,
      sustainSeconds,
      ...(scope !== undefined ? { scope } : {}),
      ...(className !== undefined ? { className } : {}),
      ...(count !== undefined ? { count } : {}),
      ...(typeof value['occupied'] === 'boolean' ? { occupied: value['occupied'] } : {}),
      ...(observedAt !== undefined ? { observedAt } : {}),
      ...(since !== undefined ? { since } : {}),
      ...(unavailable !== undefined ? { unavailable } : {}),
      ...(warning !== undefined ? { warning } : {}),
    }
  }
  if (kind === 'grouped') {
    const groupingSec = num(value, 'groupingSec')
    // A list this build cannot read is NOT "no window open" (D315): the whole answer is
    // unreadable, and the card renders nothing rather than a confident zero.
    if (groupingSec === undefined) return null
    // An EXPLICIT null is the node saying "I do not know" (it does not evaluate rules): that
    // is an answer, and it renders as unknown, never as an empty list.
    if (value['openWindows'] === null) {
      const reason = str(value, 'reason')
      return {
        kind: 'grouped',
        groupingSec,
        openWindows: null,
        ...(reason !== undefined ? { reason } : {}),
      }
    }
    if (!Array.isArray(value['openWindows'])) return null
    const openWindows: NcGroupedWindowStatus[] = []
    for (const entry of value['openWindows']) {
      const parsed = parseGroupedWindow(entry)
      if (parsed === null) return null
      openWindows.push(parsed)
    }
    return { kind: 'grouped', groupingSec, openWindows }
  }
  if (kind === 'timelapse') {
    const rawDevices = Array.isArray(value['devices']) ? value['devices'] : []
    const devices: NcTimelapseDeviceStatus[] = []
    for (const entry of rawDevices) {
      const parsed = parseDevice(entry)
      if (parsed !== null) devices.push(parsed)
    }
    const lastWindow = parseWindow(value['lastWindow'])
    const nextRaw = value['nextWindow']
    const nextWindow = isRecord(nextRaw)
      ? {
          startMs: num(nextRaw, 'startMs') ?? 0,
          endMs: num(nextRaw, 'endMs') ?? null,
        }
      : undefined
    return {
      kind: 'timelapse',
      devices,
      ...(lastWindow !== undefined ? { lastWindow } : {}),
      ...(nextWindow !== undefined ? { nextWindow } : {}),
      settleMs: num(value, 'settleMs') ?? 0,
    }
  }
  return null
}

/** `14 min` / `2 h 5 min` / `3 d` — a duration nobody has to do arithmetic on. */
export function humanDuration(ms: number): string {
  const totalMinutes = Math.max(0, Math.floor(ms / 60_000))
  if (totalMinutes < 1) return i18n.t('helpers.notificationRuleStatus.lessThanMinute')
  if (totalMinutes < 60)
    return i18n.t('helpers.notificationRuleStatus.durMin', { count: totalMinutes })
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  if (hours < 24)
    return minutes === 0
      ? i18n.t('helpers.notificationRuleStatus.durH', { count: hours })
      : i18n.t('helpers.notificationRuleStatus.durHMin', { hours, minutes })
  const days = Math.floor(hours / 24)
  const restHours = hours % 24
  return restHours === 0
    ? i18n.t('helpers.notificationRuleStatus.durD', { count: days })
    : i18n.t('helpers.notificationRuleStatus.durDH', { days, hours: restHours })
}

/** Bytes in the unit an operator reads — a timelapse is megabytes, not bytes. */
export function humanBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`
  const kb = bytes / 1024
  if (kb < 1024) return i18n.t('helpers.notificationRuleStatus.sizeKb', { value: kb.toFixed(0) })
  const mb = kb / 1024
  return mb < 1024
    ? i18n.t('helpers.notificationRuleStatus.sizeMb', { value: mb.toFixed(1) })
    : i18n.t('helpers.notificationRuleStatus.sizeGb', { value: (mb / 1024).toFixed(2) })
}

/**
 * THE OCCUPANCY SENTENCE — what the operator asked for, verbatim: "Occupancy
 * NOW: 2 vehicle in the car park — condition TRUE for 14 min".
 *
 * Three facts and a caveat, in this order because that is the order they are
 * read: the count, where, and for how long the confirmed level has held. The
 * caveat comes FIRST when there is one — a reading of 0 is not the headline
 * when the reason for the 0 is that the question is unanswerable.
 */
export function occupancyStatusLine(status: NcOccupancyStatus, now: number): string {
  const where = status.scope ?? 'the whole frame'
  const what = status.className ?? 'objects'
  if (status.unavailable !== undefined) {
    const reason =
      status.unavailable === 'no-snapshot'
        ? 'no live count for this camera yet — the condition fails closed until one arrives'
        : `“${where}” is not in this camera’s current snapshot — the condition fails closed (deleted zone?)`
    return status.warning !== undefined ? `${status.warning} · ${reason}` : reason
  }
  const parts = [
    `Now: ${String(status.count ?? 0)}/${String(status.threshold)} ${what} in ${where}`,
    status.occupied === true ? 'condition TRUE' : 'condition false',
  ]
  if (status.since !== undefined) {
    parts.push(`for ${humanDuration(Math.max(0, now - status.since))}`)
  }
  parts.push(`holds ${String(status.sustainSeconds)} s before firing`)
  const line = parts.join(' · ')
  return status.warning !== undefined ? `${status.warning} · ${line}` : line
}

/** One camera's timelapse line: what it produced, or what it is producing. */
export function timelapseDeviceLine(
  device: NcTimelapseDeviceStatus,
  cameraName: string,
  now: number,
): string {
  if (device.rendering !== undefined) {
    return i18n.t('helpers.notificationRuleStatus.tlRendering', {
      camera: cameraName,
      duration: humanDuration(Math.max(0, now - device.rendering.startedAt)),
      from: new Date(device.rendering.windowStartMs).toLocaleString(),
      to: new Date(device.rendering.windowEndMs).toLocaleString(),
    })
  }
  if (device.lastGeneratedAt === undefined) {
    return i18n.t('helpers.notificationRuleStatus.tlNever', { camera: cameraName })
  }
  const when = new Date(device.lastGeneratedAt).toLocaleString()
  const artifact = device.lastArtifact
  return artifact === undefined
    ? i18n.t('helpers.notificationRuleStatus.tlGone', { camera: cameraName, when })
    : i18n.t('helpers.notificationRuleStatus.tlLast', {
        camera: cameraName,
        when,
        size: humanBytes(artifact.sizeBytes),
      })
}

/** The two numbers of the grouped card's headline. */
export interface NcGroupedStatusCounts {
  readonly windows: number
  readonly waiting: number
}

/** The two numbers of the grouped card's headline: windows open, members still waiting. */
export function groupedStatusCounts(
  windows: readonly NcGroupedWindowStatus[],
): NcGroupedStatusCounts {
  return {
    windows: windows.length,
    waiting: windows.reduce((sum, w) => sum + w.pending, 0),
  }
}
