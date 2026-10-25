import { z } from 'zod'
import {
  BaseDevice,
  DeviceType,
  DeviceFeature,
  classifyStreams,
  hydrateSchema,
  snapshotCapability,
  maskUrlCredentials,
  streamCatalogCapability,
  CamProfileSchema,
  startReachabilityPoll,
} from '@camstack/types'
import type {
  CamStreamDescriptor,
  ConfigUISchema,
  ConfigUISchemaWithValues,
  DeviceContext,
  ICameraDevice,
  InferNativeProvider,
  ReachabilityPollHandle,
  StreamMetadata,
  StreamQuality,
  StreamSourceEntry,
} from '@camstack/types'
import { probeRtspReachable } from './rtsp-reachability.js'

/**
 * Stable, provider-assigned ids within a (deviceId) scope.
 *
 * `stream-1/2/3` map 1:1 with the operator-visible input slots in the
 * creation form. Once assigned at create time (or via legacy migration)
 * the id is permanent — editing a URL keeps its slot. Separating the id
 * from the quality lets the stream-broker decide the (high/mid/low)
 * mapping from probed metadata without the driver having to re-label.
 */
const streamEntrySchema = z.object({
  id: z
    .string()
    .regex(/^stream-\d+$/)
    .describe('Stable slot id (stream-1/2/3)'),
  url: z.string().describe('RTSP stream URL'),
  profileHint: CamProfileSchema.optional().describe('Provider-suggested profile — advisory only'),
  resolution: z
    .object({ width: z.number().int().positive(), height: z.number().int().positive() })
    .optional()
    .describe('Probed resolution, if known'),
})

export type RtspStreamEntry = z.infer<typeof streamEntrySchema>

/**
 * Accepts both the new `{id, url, profileHint?, resolution?}` shape AND
 * the legacy `{label, url}` shape. Legacy entries get rewritten to the
 * new shape at parse time so the rest of the driver can treat storage
 * uniformly. The constructor then persists the new shape back to disk
 * in `migrateLegacyStreamsIfNeeded` so subsequent parses are already
 * on the new shape.
 */
const streamsField = z.preprocess((raw: unknown): unknown => {
  if (!Array.isArray(raw)) return raw
  return (raw as readonly unknown[]).map((entry, i): unknown => {
    if (!entry || typeof entry !== 'object') return entry
    const o = entry as Record<string, unknown>
    if (typeof o['id'] === 'string') return entry
    if (typeof o['label'] === 'string' && typeof o['url'] === 'string') {
      return {
        id: `stream-${i + 1}`,
        url: o['url'],
        profileHint: o['label'],
      }
    }
    return entry
  })
}, z.array(streamEntrySchema).min(1))

export const rtspCameraSchema = z.object({
  // `name` is now base meta (DB column on `device-meta`, not in this
  // hardware-config schema). Read via `this.name` (resolved by
  // `BaseDevice` from `ctx.deviceMeta.name`); mutated via
  // `kernel.devices.setName(id, name)`.
  streams: streamsField.describe('Published RTSP streams'),
  snapshotUrl: z.string().default('').describe('Snapshot URL (optional)'),
  username: z.string().default('').describe('Username'),
  password: z.string().default('').describe('Password').meta({ secret: true }),
})

/**
 * Legacy storage shape: `[{ label: 'high'|'mid'|'low', url }]`.
 * Migrated to the new `[{id, url, profileHint}]` shape on construct
 * via `config.setAll`. The conversion is permanent — after one boot
 * every camera row is on the new shape.
 */
const legacyStreamSchema = z.object({
  label: CamProfileSchema,
  url: z.string(),
})

export class RtspCamera extends BaseDevice<typeof rtspCameraSchema> implements ICameraDevice {
  readonly type = DeviceType.Camera as const
  features = [] as const satisfies readonly DeviceFeature[]

  /** Control-plane reachability poll — an RTSP `OPTIONS`/TCP-connect probe to
   *  the camera's RTSP port every 30s drives `device.online`, decoupled from
   *  stream-broker video health. Started in `onActivate`, stopped in
   *  `removeDevice`. */
  private reachabilityPoll: ReachabilityPollHandle | null = null

  constructor(ctx: DeviceContext) {
    super(ctx, rtspCameraSchema, { type: DeviceType.Camera })
    // `online` reflects CONTROL-PLANE reachability, driven by the RTSP
    // reachability poll started in `onActivate` (see `startReachabilityPolling`).
    // It is NO LONGER mirrored from stream-broker video health — a reachable
    // on-demand camera with no consumer must still report ONLINE. The
    // stream-health signal remains available as the `camera-streams` slice.
    this.migrateLegacyStreamsIfNeeded(ctx.persistedConfig ?? {})
    this.registerSnapshotProvider()
    this.registerStreamCatalogProvider()
  }

  /** Phase 5 — device is live: begin the control-plane reachability poll. */
  override async onActivate(): Promise<void> {
    this.startReachabilityPolling()
  }

  /** Start the RTSP reachability poll: a lightweight `OPTIONS`/TCP-connect
   *  probe to the first configured stream's `host:port` every 30s drives
   *  `device.online`, with hysteresis. Idempotent. */
  private startReachabilityPolling(): void {
    if (this.reachabilityPoll) return
    this.reachabilityPoll = startReachabilityPoll({
      probe: async () => {
        const streams = this.config.get('streams')
        const url = streams[0]?.url
        if (!url) return false
        return probeRtspReachable(url, RtspCamera.RTSP_PROBE_TIMEOUT_MS)
      },
      setOnline: (online) => {
        this.markOnline(online)
      },
      isEnabled: () => !this.disabled,
      logger: this.ctx.logger,
    })
  }

  /** Per-probe TCP/RTSP round-trip budget — a dead host resolves as a miss. */
  private static readonly RTSP_PROBE_TIMEOUT_MS = 5_000

  /**
   * Build this camera's pull-able stream catalog — the descriptors the
   * stream-broker needs to dial. Single source of truth feeding the
   * `stream-catalog` cap, which the broker PULLS (on start / poll /
   * device + stream-params events) to (re)build its cam-stream registry.
   */
  private buildStreamCatalog(): CamStreamDescriptor[] {
    const streams = this.config.get('streams')
    return streams.map((s, i) => ({
      camStreamId: s.id,
      kind: 'pull-rtsp' as const,
      url: s.url,
      ...(s.resolution ? { resolution: s.resolution } : {}),
      label: `Stream ${i + 1}`,
    }))
  }

  /**
   * Register the device-scoped `stream-catalog` cap — the broker pulls this
   * (on start / poll / device + stream-params events) to (re)build its
   * cam-stream registry, instead of relying on a push.
   */
  private registerStreamCatalogProvider(): void {
    const provider: InferNativeProvider<typeof streamCatalogCapability> = {
      getCatalog: async ({ deviceId }) => {
        if (deviceId !== this.id) return []
        return this.buildStreamCatalog()
      },
    }
    this.ctx.registerNativeCap(streamCatalogCapability, provider)
  }

  /**
   * Detect legacy `{label, url}` stream shapes and reshape to
   * `{id, url, profileHint}`. Persists via `config.setAll` once, so
   * subsequent boots find the new shape and this branch is inert.
   *
   * Runs fire-and-forget — the constructor can't await. The reshape is
   * additive (ids are newly minted) so a failed persist is recoverable
   * on next boot.
   */
  private migrateLegacyStreamsIfNeeded(initialData: Record<string, unknown>): void {
    const raw = initialData['streams']
    if (!Array.isArray(raw)) return
    // All entries already have `id` → new shape; nothing to do.
    if (
      raw.every(
        (s) =>
          s && typeof s === 'object' && typeof (s as Record<string, unknown>)['id'] === 'string',
      )
    ) {
      return
    }
    const migrated: RtspStreamEntry[] = []
    let nextIdx = 1
    for (const entry of raw) {
      const parsed = legacyStreamSchema.safeParse(entry)
      if (!parsed.success) continue
      migrated.push({
        id: `stream-${nextIdx++}`,
        url: parsed.data.url,
        profileHint: parsed.data.label,
      })
    }
    if (migrated.length === 0) return
    const snapshotUrl = this.config.get('snapshotUrl') ?? ''
    const username = this.config.get('username') ?? ''
    const password = this.config.get('password') ?? ''
    this.ctx.logger.info('Migrating legacy {label,url} streams to {id,url,profileHint}', {
      tags: { stableId: this.stableId },
      meta: { streamCount: migrated.length },
    })
    void this.config
      .setAll({ streams: migrated, snapshotUrl, username, password })
      .catch((err: unknown) => {
        this.ctx.logger.warn('Legacy stream migration failed', {
          tags: { stableId: this.stableId },
          meta: { error: err instanceof Error ? err.message : String(err) },
        })
      })
  }

  /**
   * Thin compat shim: reflects the stored `{id, url, profileHint?}`
   * streams into the legacy `StreamSourceEntry` shape so
   * `ICameraDevice`-aware consumers (device-manager legacy paths,
   * device-cap-proxy fallback) still find data. The broker itself does
   * NOT read this anymore — it consumes `publishCameraStream`. This
   * shim goes away when every consumer migrates (C5/C7).
   */
  async getStreamSources(): Promise<readonly StreamSourceEntry[]> {
    const streams = this.config.get('streams')
    return streams.map(
      (s): StreamSourceEntry => ({
        id: s.id,
        label: s.profileHint ?? s.id,
        protocol: 'rtsp' as const,
        url: s.url,
        ...(s.profileHint ? { profileHint: s.profileHint } : {}),
        ...(s.resolution ? { resolution: s.resolution } : {}),
      }),
    )
  }

  /**
   * Release THIS instance's resources. Never the camera's broker streams
   * (D689, as D685 for Hikvision): the hook also runs when the runner stops
   * (`BaseDeviceProvider.onShutdown` decommissions every device) and on every
   * rebuild (`reloadDevice`, `applyDerivedSpec`), and none of those is a camera
   * leaving. The broker dials the camera's own url (`pull-rtsp`) — this runner
   * is not on the byte path, so a retract here only tore down every recording
   * writer and viewer for the length of a restart.
   *
   * Where each real change reaches the broker instead:
   * - the camera is DELETED → `DeviceUnregistered` → the broker's
   *   `handleDeviceRemoved`, backed by the departed-device sweep (D685);
   * - a stream is dropped or its url changed → the next catalog pulls: a url
   *   change is upserted, a dropped stream is retracted once two pulls a
   *   reconcile interval apart agree (D689). This catalog never answers empty
   *   (`streams` is `min(1)`, and a cleared form keeps the current streams).
   */
  override async removeDevice(): Promise<void> {
    this.reachabilityPoll?.stop()
    this.reachabilityPoll = null
    this.ctx.logger.info('RTSP camera instance released — its broker streams stay published', {
      tags: { deviceId: this.id },
      meta: { stableId: this.stableId, streams: this.config.get('streams').length },
    })
  }

  // ── Driver-authored settings UI ────────────────────────────────────────
  //
  // Streams are stored as `Array<{id, url, profileHint?, resolution?}>`
  // but the settings UI exposes them as a `multiple` probe field of raw
  // URLs — the form only cares about the ordered list of URLs, the ids
  // and classification live in storage. Values are projected from
  // storage into the flat form keys referenced by the schema.

  override getSettingsUISchema(): ConfigUISchemaWithValues {
    const schema: ConfigUISchema = {
      sections: [
        // The `name` field is now base meta — rendered by the
        // device-manager's own settings contribution (with the
        // location field), NOT by the driver's hardware-config
        // schema. Driver UIs only carry technical knobs.
        {
          id: 'streams',
          title: 'RTSP Streams',
          titleKey: 'provider-rtsp:schema.s_streams.title',
          description:
            '1–3 RTSP URLs; the broker assigns the high / mid / low profiles by resolution.',
          descriptionKey: 'provider-rtsp:schema.s_streams.description',
          columns: 1,
          fields: [
            {
              type: 'probe',
              key: 'streams',
              label: 'RTSP stream URL',
              labelKey: 'provider-rtsp:schema.s_streams.streams.label',
              required: true,
              placeholder: 'rtsp://user:pass@host:554/Streaming/Channels/101',
              inputType: 'url',
              multiple: {
                min: 1,
                max: 3,
                addLabel: 'Add stream',
                itemLabel: 'Stream ${n}',
                itemDefault: '',
              },
            },
          ],
        },
        {
          id: 'snapshot',
          title: 'Snapshot',
          titleKey: 'provider-rtsp:schema.s_snapshot.title',
          columns: 1,
          fields: [
            {
              type: 'probe',
              key: 'snapshotUrl',
              label: 'Snapshot URL',
              labelKey: 'provider-rtsp:schema.s_snapshot.snapshotUrl.label',
              placeholder: 'http://host/ISAPI/Streaming/channels/101/picture',
              inputType: 'url',
            },
          ],
        },
        {
          id: 'credentials',
          title: 'Credentials',
          titleKey: 'provider-rtsp:schema.s_credentials.title',
          description:
            'Optional. If the RTSP URL already contains user:pass@ you can leave these empty.',
          descriptionKey: 'provider-rtsp:schema.s_credentials.description',
          columns: 2,
          fields: [
            {
              type: 'text',
              key: 'username',
              label: 'Username',
              labelKey: 'provider-rtsp:schema.s_credentials.username.label',
            },
            {
              type: 'password',
              key: 'password',
              label: 'Password',
              labelKey: 'provider-rtsp:schema.s_credentials.password.label',
              showToggle: true,
            },
          ],
        },
      ],
    }
    return hydrateSchema(schema, this.collectFormValues())
  }

  /**
   * Project stored config into the flat UI keys referenced by the schema.
   * Form only sees URLs — the internal id/profileHint/resolution stay
   * invisible to the operator (the broker decides profiles from probed
   * metadata at save time).
   */
  private collectFormValues(): Record<string, unknown> {
    const stored = this.config.get('streams')
    // Preserve the slot order from storage (`stream-1`, `stream-2`, …).
    const sorted = [...stored].toSorted((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }))
    const urls = sorted.map((s) => s.url).filter((u) => u.length > 0)
    return {
      streams: urls,
      snapshotUrl: this.config.get('snapshotUrl'),
      username: this.config.get('username'),
      password: this.config.get('password'),
    }
  }

  override async applySettingsPatch(patch: Record<string, unknown>): Promise<void> {
    const current = this.collectFormValues()
    const merged: Record<string, unknown> = { ...current, ...patch }
    const pickStr = (k: string): string =>
      typeof merged[k] === 'string' ? (merged[k] as string).trim() : ''

    const next: Record<string, unknown> = {}

    const rawStreams = merged['streams']
    const incomingUrls: string[] = Array.isArray(rawStreams)
      ? rawStreams
          .filter((s): s is string => typeof s === 'string')
          .map((s) => s.trim())
          .filter((s) => s.length > 0)
      : []

    if (incomingUrls.length === 0) {
      // UI cleared every slot — keep current streams so zod's min(1)
      // invariant holds and the camera keeps streaming until the next
      // save with real URLs.
      next.streams = this.config.get('streams')
    } else {
      const probed = await this.probeAndClassify(incomingUrls.slice(0, 3))
      next.streams = probed
    }

    next.snapshotUrl = pickStr('snapshotUrl')
    next.username = pickStr('username')
    next.password =
      typeof merged['password'] === 'string' ? merged['password'] : this.config.get('password')

    await this.config.setAll(next)

    // Storage now has the new stream list. The broker's periodic catalog
    // reconcile re-pulls the `stream-catalog` cap: a changed url is upserted,
    // a dropped slot is retracted once two pulls agree (D689). No push, and
    // no retract from here.
  }

  /**
   * Probe a list of RTSP URLs through the kernel stream-probe and return
   * the new `{id, url, profileHint?, resolution?}` entries. Ids are
   * assigned `stream-1/2/3` in input order so the UI's slot ordering is
   * preserved across edits. The broker is in charge of the actual
   * (high/mid/low) profile assignment via `computeInitialAssignment`.
   */
  private async probeAndClassify(urls: readonly string[]): Promise<RtspStreamEntry[]> {
    const streamProbe = this.ctx.streamProbe
    if (!streamProbe) {
      this.ctx.logger.warn(
        '[rtsp-edit] ctx.streamProbe unavailable — falling back to input-order profile assignment',
        { meta: { streamCount: urls.length } },
      )
      const sequence: ReadonlyArray<StreamQuality> =
        urls.length === 1 ? ['high'] : urls.length === 2 ? ['high', 'low'] : ['high', 'mid', 'low']
      return urls.map(
        (url, i): RtspStreamEntry => ({
          id: `stream-${i + 1}`,
          url,
          profileHint: sequence[i]!,
        }),
      )
    }

    const probed = await Promise.all(
      urls.map(async (url) => {
        try {
          const metadata = await streamProbe.probe(url, { force: false })
          return { url, metadata }
        } catch (err) {
          this.ctx.logger.warn(
            '[rtsp-edit] probe failed — landing in the lowest tier via classifyStreams',
            {
              meta: {
                url: maskUrlCredentials(url),
                error: err instanceof Error ? err.message : String(err),
              },
            },
          )
          const emptyMetadata: StreamMetadata = {}
          return { url, metadata: emptyMetadata }
        }
      }),
    )
    const classified = classifyStreams(probed)
    // Each classified entry carries a quality tag. We preserve the
    // input order for the slot id and use the tag as `profileHint`;
    // resolution comes from the probed metadata (matched by url).
    const metadataByUrl = new Map(probed.map((p) => [p.url, p.metadata]))
    const classifiedByUrl = new Map(classified.map((c) => [c.url, c]))
    return urls.map((url, i): RtspStreamEntry => {
      const tag = classifiedByUrl.get(url)
      const meta = metadataByUrl.get(url)
      const entry: RtspStreamEntry = { id: `stream-${i + 1}`, url }
      if (tag) entry.profileHint = tag.quality
      if (meta?.width && meta?.height) entry.resolution = { width: meta.width, height: meta.height }
      return entry
    })
  }

  // ── Native capabilities ────────────────────────────────────────────────

  private registerSnapshotProvider(): void {
    const snapshotUrl = (this.config.get('snapshotUrl') ?? '').trim()
    if (!snapshotUrl) return

    const provider: InferNativeProvider<typeof snapshotCapability> = {
      getSnapshot: async ({ deviceId }) => {
        if (deviceId !== this.id) {
          throw new Error(`RtspCamera: deviceId mismatch, expected ${this.id}, got ${deviceId}`)
        }
        const buf = await this.fetchHttpSnapshot(snapshotUrl)
        if (buf.length === 0) return null
        return { base64: buf.toString('base64'), contentType: 'image/jpeg' }
      },
      invalidateCache: async () => {
        /* no-op — caching is the snapshot orchestrator's concern */
      },
    }
    this.ctx.registerNativeCap(snapshotCapability, provider)
  }

  private async fetchHttpSnapshot(url: string): Promise<Buffer> {
    const username = (this.config.get('username') ?? '').trim()
    const password = (this.config.get('password') ?? '').trim()
    const headers: Record<string, string> = {}
    if (username || password) {
      const creds = Buffer.from(`${username}:${password}`).toString('base64')
      headers['authorization'] = `Basic ${creds}`
    }
    const res = await fetch(url, { headers })
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`)
    const ab = await res.arrayBuffer()
    return Buffer.from(ab)
  }
}
