import type { IScopedLogger } from '@camstack/types'
import { parseProfileBrokerId } from '@camstack/types'
import { deviceIdFromBrokerId } from './broker-device-id.js'
import type { RtspListenServer } from './rtsp-listen-server.js'

export type EnabledPersister = (states: ReadonlyMap<string, boolean>) => void
export type TokenPersister = (tokens: ReadonlyMap<string, string>) => void

/**
 * Per-broker RTSP restream entry.
 *
 * Kept local to `addon-stream-broker` after the `rtsp-restream` capability
 * was absorbed into `stream-broker`. The shape is still validated at the
 * `stream-broker.cap.ts` boundary via `RtspRestreamEntrySchema`.
 */
export interface RtspRestreamEntry {
  readonly brokerId: string
  readonly url: string
  readonly mutedUrl: string
  readonly enabled: boolean
}

/**
 * Internal sub-object of `StreamBrokerManager` that implements the RTSP
 * restream bookkeeping. No longer registered as a separate capability —
 * accessed via passthrough methods on `StreamBrokerManager`.
 */
export class RtspRestreamProviderImpl {
  private tokenPersister: TokenPersister | null = null
  private enabledPersister: EnabledPersister | null = null

  constructor(
    private readonly server: RtspListenServer,
    private readonly logger: IScopedLogger,
  ) {}

  // ── Persistence ────────────────────────────────────────────────────────

  setTokenPersister(persister: TokenPersister): void {
    this.tokenPersister = persister
  }

  setEnabledPersister(persister: EnabledPersister): void {
    this.enabledPersister = persister
  }

  loadPersistedEnabled(states: ReadonlyMap<string, boolean>): void {
    this.server.loadEnabled(states)
  }

  // ── IRtspRestreamProvider ──────────────────────────────────────────────

  getRtspPort(): number {
    return this.server.getPort()
  }

  getAllEntries(hostname?: string): readonly RtspRestreamEntry[] {
    const port = this.server.getPort()
    if (port === 0) return []
    const host = hostname ?? '127.0.0.1'
    const result: RtspRestreamEntry[] = []
    for (const [brokerId, token] of this.server.getAllTokens()) {
      // Skip profile-keyed alias tokens (see getEntriesForDevice).
      if (parseProfileBrokerId(brokerId)) continue
      result.push({
        brokerId,
        url: `rtsp://${host}:${port}/${token}`,
        mutedUrl: `rtsp://${host}:${port}/${token}/muted`,
        enabled: this.server.isEnabled(brokerId),
      })
    }
    return result
  }

  /**
   * Server-side filter by device — returns only entries whose
   * `brokerId` is keyed `${deviceId}/${camStreamId}`. Mirrors
   * `getAllEntries` but lets device-scoped consumers skip the
   * cluster-wide scan + client-side filter that was the cost of
   * routing through `getAllEntries`.
   */
  getEntriesForDevice(deviceId: number, hostname?: string): readonly RtspRestreamEntry[] {
    const port = this.server.getPort()
    if (port === 0) return []
    const host = hostname ?? '127.0.0.1'
    const prefix = `${deviceId}/`
    const result: RtspRestreamEntry[] = []
    for (const [brokerId, token] of this.server.getAllTokens()) {
      if (!brokerId.startsWith(prefix)) continue
      // Skip profile-keyed alias tokens (`${deviceId}/high|mid|low`) — they
      // are an internal exporter convergence mechanism, NOT raw camStream
      // restreams. The raw/live-view path must surface source camStreams only;
      // profile entries are served via getProfileRtspEntries / getEntry.
      if (parseProfileBrokerId(brokerId)) continue
      result.push({
        brokerId,
        url: `rtsp://${host}:${port}/${token}`,
        mutedUrl: `rtsp://${host}:${port}/${token}/muted`,
        enabled: this.server.isEnabled(brokerId),
      })
    }
    return result
  }

  getEntry(brokerId: string, hostname?: string): RtspRestreamEntry | null {
    const token = this.server.getToken(brokerId)
    if (!token) return null
    const port = this.server.getPort()
    const host = hostname ?? '127.0.0.1'
    return {
      brokerId,
      url: `rtsp://${host}:${port}/${token}`,
      mutedUrl: `rtsp://${host}:${port}/${token}/muted`,
      enabled: this.server.isEnabled(brokerId),
    }
  }

  /**
   * The entry an IN-PROCESS consumer dials (recording, decode, snapshots, grid,
   * egress): the loopback-only internal alias when the camera's external token
   * is held back (D870), else the external entry. NEVER hand this out through a
   * consumer URL API - use {@link getEntry} for that.
   */
  getInternalEntry(brokerId: string, hostname?: string): RtspRestreamEntry | null {
    const token = this.server.getInternalToken(brokerId)
    if (!token) return null
    const port = this.server.getPort()
    const host = hostname ?? '127.0.0.1'
    return {
      brokerId,
      url: `rtsp://${host}:${port}/${token}`,
      mutedUrl: `rtsp://${host}:${port}/${token}/muted`,
      enabled: this.server.isEnabled(brokerId),
    }
  }

  regenerateToken(brokerId: string): string | null {
    const token = this.server.regenerateToken(brokerId)
    if (token) {
      this.persistTokens()
      this.logger.info('RTSP token regenerated', {
        tags: { deviceId: deviceIdFromBrokerId(brokerId) },
        meta: { brokerId, tokenPrefix: token.slice(0, 8) },
      })
    }
    return token
  }

  setEnabled(brokerId: string, enabled: boolean): void {
    this.server.setEnabled(brokerId, enabled)
    this.persistEnabled()
    this.logger.info('RTSP restream state changed', {
      tags: { deviceId: deviceIdFromBrokerId(brokerId) },
      meta: { brokerId, enabled },
    })
  }

  isEnabled(brokerId: string): boolean {
    return this.server.isEnabled(brokerId)
  }

  // ── Internal (called by StreamBrokerManager) ──────────────────────────

  /** Persist tokens after registration/regeneration triggered by broker manager */
  persistTokens(): void {
    if (this.tokenPersister) {
      this.tokenPersister(this.server.getAllTokens())
    }
  }

  private persistEnabled(): void {
    if (this.enabledPersister) {
      this.enabledPersister(this.server.getAllEnabled())
    }
  }
}
