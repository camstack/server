import type { ReolinkBaichuanApi } from '@apocaliss92/nodelink-js'
import type { ConfigUISchema, IScopedLogger } from '@camstack/types'

/**
 * Shared "Sessions" diagnostic helper used by both `ReolinkCamera` and
 * `ReolinkHubSession`. The snapshot shape + the form-builder block are
 * identical — only the api source differs (camera owns its own api;
 * hub-children borrow the parent's api). Centralising here keeps
 * future tweaks (extra columns, new lib-exposed fields) consistent
 * across all device types without duplication.
 */

export interface SessionsSnapshotUser {
  /** Firmware-reported username. */
  readonly userName: string
  /** Source IP. */
  readonly ip: string
  /** Firmware sessionId (number from cmd_id 145). `null` on legacy
   *  payloads that don't expose it. */
  readonly sessionId: number | null
  /** Permission level — 'admin' / 'user' / numeric fallback. */
  readonly level: string
  /** Online flag from the firmware payload. Defaults to true when
   *  the firmware doesn't include the field. */
  readonly online: boolean
}

export interface SessionsSnapshotPoolEntry {
  /** Pool tag — `general`, `streaming:ch3`, `talk:ch0`, etc. */
  readonly tag: string
  /** Connection state — only `open` is currently exposed by the lib;
   *  reserved for future extension. */
  readonly state: string
}

export interface SessionsSnapshotDedicated {
  /** Lib-side identifier for the dedicated session. */
  readonly key: string
}

export interface SessionsSnapshot {
  /** Wall-clock ms when this snapshot was captured. */
  readonly ts: number
  /**
   * Active firmware-reported user sessions. `null` when the lib call
   * threw — keeps the rest of the snapshot usable so the cooldown /
   * socket-pool blocks render even if the camera rejected the
   * user-list query.
   */
  readonly onlineUsers: readonly SessionsSnapshotUser[] | null
  /** Snapshot of OUR Baichuan socket pool (one row per tag). */
  readonly socketPool: readonly SessionsSnapshotPoolEntry[]
  /** Lib-internal dedicated streaming/talk sessions. */
  readonly dedicatedSessions: readonly SessionsSnapshotDedicated[]
  /**
   * Socket-pool cooldown diagnostic. `null` when lib hasn't tracked
   * any cooldowns for this host.
   */
  readonly cooldown: {
    readonly host: string
    readonly inCooldown: boolean
    readonly failureCount: number
    readonly cooldownRemainingMs: number
    readonly cooldownUntilIso: string | null
  } | null
  /** Top-level error message when refresh failed before any field could be read. */
  readonly error?: string
}

export const SESSIONS_SNAPSHOT_MAX_AGE_MS = 60_000

function formatUserLevel(level: unknown): string {
  if (level === undefined || level === null) return 'user'
  if (typeof level === 'string' && level.length > 0) return level
  if (typeof level === 'number') {
    if (level === 0) return 'admin'
    if (level === 1) return 'user'
    return String(level)
  }
  return 'user'
}

/**
 * Pull a fresh sessions snapshot from a live Baichuan api. Best-effort
 * across the board: any individual lib call that throws leaves the
 * corresponding snapshot field at its empty default — the rest of the
 * snapshot is still populated so the UI never goes blank on a single
 * firmware quirk.
 */
export async function captureSessionsSnapshot(
  api: ReolinkBaichuanApi,
  opts: { readonly logger: IScopedLogger; readonly deviceId: number },
): Promise<SessionsSnapshot> {
  const ts = Date.now()

  // Firmware sessions (cmd_id 145). Pull the structured shape, not the
  // formatted-string variant — we render rows with dedicated columns.
  // Both legacy `item[]` and current `OnlineUser[]` payload shapes are
  // mapped to the same row schema.
  let onlineUsers: SessionsSnapshotUser[] | null
  try {
    const raw = await api.getOnlineUserList({ timeoutMs: 5_000 })
    const list = raw?.body?.OnlineUserList
    const rows: SessionsSnapshotUser[] = []
    for (const u of list?.OnlineUser ?? []) {
      rows.push({
        userName: typeof u.userName === 'string' ? u.userName : 'unknown',
        ip: typeof u.ipAddress === 'string' ? u.ipAddress : '',
        sessionId: typeof u.sessionId === 'number' ? u.sessionId : null,
        level: formatUserLevel(u.userLevel),
        online: u.isOnline === undefined ? true : u.isOnline === 1,
      })
    }
    for (const u of list?.item ?? []) {
      rows.push({
        userName: typeof u.userName === 'string' ? u.userName : 'unknown',
        ip: typeof u.ip === 'string' ? u.ip : '',
        sessionId: null,
        level: formatUserLevel(u.level),
        online: true,
      })
    }
    onlineUsers = rows
  } catch (err) {
    opts.logger.debug('captureSessionsSnapshot: getOnlineUserList failed', {
      tags: { deviceId: opts.deviceId },
      meta: { error: err instanceof Error ? err.message : String(err) },
    })
    onlineUsers = null
  }

  const poolRaw = api.getSocketPoolSummary()
  const socketPool: SessionsSnapshotPoolEntry[] = poolRaw.tags.map((tag) => ({
    tag,
    state: 'open',
  }))

  let dedicatedSessions: SessionsSnapshotDedicated[] = []
  try {
    const dedRaw = (
      api as { getDedicatedSessionsSummary?: () => { keys: string[] } }
    ).getDedicatedSessionsSummary?.()
    if (dedRaw && Array.isArray(dedRaw.keys)) {
      dedicatedSessions = dedRaw.keys.map((key) => ({ key }))
    }
  } catch {
    /* lib version doesn't expose it — leave empty */
  }

  const cooldownRaw = api.getSocketPoolCooldownStatus()
  const cooldown = cooldownRaw
    ? {
        host: cooldownRaw.host,
        inCooldown: cooldownRaw.inCooldown,
        failureCount: cooldownRaw.failureCount,
        cooldownRemainingMs: cooldownRaw.cooldownRemainingMs,
        cooldownUntilIso: cooldownRaw.cooldownUntil
          ? cooldownRaw.cooldownUntil.toISOString()
          : null,
      }
    : null

  return {
    ts,
    onlineUsers,
    socketPool,
    dedicatedSessions,
    cooldown,
  }
}

/**
 * Build the form-builder sections for a Sessions tab from a snapshot.
 * `tabId` is the layout tab the section attaches to (drivers can put
 * Sessions on any tab they want — most use the literal `'sessions'`
 * tab id but the helper stays decoupled).
 */
export function buildSessionsTabSections(
  snap: SessionsSnapshot | null,
  opts: { readonly tabId: string; readonly title?: string; readonly autoRefreshes: boolean },
): readonly ConfigUISchema['sections'][number][] {
  const now = Date.now()
  // For surfaces that auto-refresh on open (mains cams, hub) a null
  // snapshot is genuinely transient → "Loading…". Battery cams are NOT
  // auto-refreshed (a fetch wakes the radio), so a null snapshot will
  // never populate on its own — "Click Refresh to load" is the honest
  // cold-state label.
  const coldText = opts.autoRefreshes ? 'Loading…' : 'Click Refresh to load'
  const ageInfo =
    snap === null
      ? coldText
      : `${Math.round((now - snap.ts) / 1000)}s ago (${new Date(snap.ts).toLocaleTimeString()})`

  const cooldownText =
    snap === null
      ? coldText
      : snap.cooldown === null
        ? 'idle (no recent failures)'
        : snap.cooldown.inCooldown
          ? `cooling down: ${snap.cooldown.failureCount} failures, ${Math.ceil(snap.cooldown.cooldownRemainingMs / 1000)}s remaining (until ${snap.cooldown.cooldownUntilIso ?? '?'})`
          : `tracked: ${snap.cooldown.failureCount} failures, last reset clean`

  const errorBanner: ConfigUISchema['sections'][number]['fields'][number][] = snap?.error
    ? [
        {
          type: 'info',
          key: 'sessionsError',
          label: 'Refresh error',
          labelKey: 'provider-reolink:errorBanner.sessionsError.label',
          content: snap.error,
          variant: 'danger',
        },
      ]
    : []

  const onlineRows = snap?.onlineUsers
    ? snap.onlineUsers.map((u) => ({
        userName: u.userName,
        ip: u.ip,
        sessionId: u.sessionId === null ? '' : String(u.sessionId),
        level: u.level,
        status: u.online ? 'ok' : 'idle',
      }))
    : []
  const onlineEmptyMsg =
    snap === null
      ? coldText
      : snap.onlineUsers === null
        ? 'unavailable (firmware rejected the user-list query)'
        : 'No active sessions'

  const poolRows = snap?.socketPool.map((p) => ({ tag: p.tag, state: p.state })) ?? []
  const poolEmptyMsg = snap === null ? coldText : 'No open sockets'
  const dedicatedRows = snap?.dedicatedSessions.map((d) => ({ key: d.key })) ?? []

  return [
    {
      id: 'sessions-status',
      title: opts.title ?? 'Sessions',
      tab: opts.tabId,
      order: 0,
      columns: 1,
      fields: [
        ...errorBanner,
        {
          type: 'info',
          key: 'sessionsLastRefreshed',
          label: 'Last refreshed',
          labelKey:
            'provider-reolink:sessionsTabSections.s_sessions-status.sessionsLastRefreshed.label',
          content: ageInfo,
        },
        {
          type: 'object-array',
          key: 'sessionsOnlineUsers',
          label: 'Online users (firmware)',
          labelKey:
            'provider-reolink:sessionsTabSections.s_sessions-status.sessionsOnlineUsers.label',
          columns: [
            {
              key: 'userName',
              label: 'User',
              labelKey:
                'provider-reolink:sessionsTabSections.s_sessions-status.sessionsOnlineUsers.userName.label',
            },
            {
              key: 'ip',
              label: 'IP',
              labelKey:
                'provider-reolink:sessionsTabSections.s_sessions-status.sessionsOnlineUsers.ip.label',
              kind: 'monospace',
              width: '160px',
            },
            {
              key: 'sessionId',
              label: 'Session',
              labelKey:
                'provider-reolink:sessionsTabSections.s_sessions-status.sessionsOnlineUsers.sessionId.label',
              kind: 'monospace',
              width: '90px',
            },
            {
              key: 'level',
              label: 'Level',
              labelKey:
                'provider-reolink:sessionsTabSections.s_sessions-status.sessionsOnlineUsers.level.label',
              width: '80px',
            },
            {
              key: 'status',
              label: 'State',
              labelKey:
                'provider-reolink:sessionsTabSections.s_sessions-status.sessionsOnlineUsers.status.label',
              kind: 'status',
              width: '100px',
            },
          ],
          value: onlineRows,
          emptyMessage: onlineEmptyMsg,
        },
        {
          type: 'object-array',
          key: 'sessionsSocketPool',
          label: 'Our socket pool',
          labelKey:
            'provider-reolink:sessionsTabSections.s_sessions-status.sessionsSocketPool.label',
          columns: [
            {
              key: 'tag',
              label: 'Tag',
              labelKey:
                'provider-reolink:sessionsTabSections.s_sessions-status.sessionsSocketPool.tag.label',
              kind: 'monospace',
            },
            {
              key: 'state',
              label: 'State',
              labelKey:
                'provider-reolink:sessionsTabSections.s_sessions-status.sessionsSocketPool.state.label',
              kind: 'status',
              width: '100px',
            },
          ],
          value: poolRows,
          emptyMessage: poolEmptyMsg,
        },
        {
          type: 'object-array',
          key: 'sessionsDedicated',
          label: 'Dedicated lib sessions',
          labelKey:
            'provider-reolink:sessionsTabSections.s_sessions-status.sessionsDedicated.label',
          columns: [
            {
              key: 'key',
              label: 'Session key',
              labelKey:
                'provider-reolink:sessionsTabSections.s_sessions-status.sessionsDedicated.key.label',
              kind: 'monospace',
            },
          ],
          value: dedicatedRows,
          emptyMessage: 'No dedicated sessions',
        },
        {
          type: 'info',
          key: 'sessionsCooldown',
          label: 'Reconnect cooldown',
          labelKey: 'provider-reolink:sessionsTabSections.s_sessions-status.sessionsCooldown.label',
          content: cooldownText,
        },
        {
          // Dispatches the `refresh-sessions` device custom action via
          // deviceManager.runDeviceAction (registered in the camera's
          // registerNativeCapabilities) — no legacy settings sentinel.
          type: 'device-action-button',
          key: '_refreshSessions',
          label: 'Refresh sessions',
          labelKey: 'provider-reolink:sessionsTabSections.s_sessions-status._refreshSessions.label',
          buttonLabel: 'Refresh now',
          action: 'refresh-sessions',
          variant: 'default',
        },
      ],
    },
  ]
}
