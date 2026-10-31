/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- React Query inferred types collapse to `error` under the new bundle's parserService context (was lint-clean in addon-stream-broker's own tsconfig context). Phase E builder migration will revisit. */
/**
 * Per-device stream-broker panel.
 *
 * Rendered by DeviceDetail/Overview and the Pipeline page's per-camera
 * expansion row. Since the profile-slot refactor the panel enumerates
 * broker profile slots (high/mid/low) instead of cam-stream-keyed
 * brokers:
 *   - `streamBroker.listAllProfileSlots` drives the slot layout
 *     (filtered by deviceId, skipping unassigned slots).
 *   - Each assigned slot gets its own `BrokerRow` which queries
 *     `streamBroker.getBrokerStats` + `streamBroker.listClients` on a
 *     3s cadence.
 *   - `cameraStreams.getCameraStreams` powers the per-slot resolution
 *     label ("high (1920×1080)") without needing a separate
 *     stream-sources query.
 *
 * `variant` controls visual density:
 *   - `'full'`: card with header + streaming counter + per-slot grid.
 *   - `'compact'`: slim inline row for tables.
 */

import type {
  BrokerClients,
  BrokerStats,
  CameraStream,
  CamProfile,
  ProfileSlot,
} from '@camstack/types'
import { makeSourceBrokerId } from '@camstack/types'
import {
  useDeviceProxy,
  useEventInvalidation,
  useEventStreamLatest,
  usePipelineOrchestratorGetCameraStatus,
  useStreamBrokerApplyDeviceSettingsPatch,
  useStreamBrokerGetDeviceAudioMute,
  useStreamBrokerGetDeviceSettingsContribution,
  useStreamBrokerKillClient,
  useStreamBrokerListAllProfileSlots,
  useStreamBrokerListClients,
  useStreamBrokerSetDeviceAudioMute,
  useSystem,
  type WidgetProps,
  Button,
} from '@camstack/ui-library'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronDown, ChevronRight, Radio, Volume2, VolumeX, X } from 'lucide-react'
import { type ReactNode, useCallback, useRef, useState } from 'react'
import { brokerAudioWrite, resolveBrokerAudio } from './broker-audio-switch.js'
import { useT } from '../../i18n/index.js'
import { formatUa } from './format-ua.js'

/**
 * Narrow one `streamBroker.getDeviceAudioMute` answer to the fact read here.
 *
 * A guard rather than a cast, and anything unrecognised is `null` — UNKNOWN,
 * never `muted: false`. A camera the operator silenced must not read as one
 * whose audio is flowing.
 */
function readBrokerMuted(data: unknown): boolean | null {
  if (data === null || typeof data !== 'object') return null
  const rec: Record<string, unknown> = { ...data }
  const raw = rec['muted']
  return typeof raw === 'boolean' ? raw : null
}
function formatUptime(ms: number): string {
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m`
}

const PROFILE_ORDER: readonly CamProfile[] = ['high', 'mid', 'low']

/** Per-`BrokerConsumerKind` accent for the subscribers table chip. */
const ENCODED_KIND_CLASS: Readonly<Record<string, string>> = {
  alexa: 'bg-blue-500/15 text-blue-400',
  homekit: 'bg-purple-500/15 text-purple-400',
  'webrtc-browser': 'bg-emerald-500/15 text-emerald-400',
  'webrtc-mobile': 'bg-emerald-500/15 text-emerald-400',
  'webrtc-whep': 'bg-emerald-500/15 text-emerald-400',
  'rtsp-listen': 'bg-warning/15 text-warning',
  'derived-broker': 'bg-amber-500/15 text-amber-400',
  recording: 'bg-rose-500/15 text-rose-400',
  pipeline: 'bg-cyan-500/15 text-cyan-400',
  snapshot: 'bg-cyan-500/15 text-cyan-400',
  warmup: 'bg-foreground-subtle/10 text-foreground-subtle',
  unknown: 'bg-foreground-subtle/10 text-foreground-subtle',
}

/** Short uppercase chip label per kind — fits the fixed 14ch column. */
const ENCODED_KIND_BADGE: Readonly<Record<string, string>> = {
  alexa: 'ALEXA',
  homekit: 'HOMEKIT',
  'webrtc-browser': 'BROWSER',
  'webrtc-mobile': 'MOBILE',
  'webrtc-whep': 'WHEP',
  'rtsp-listen': 'RTSP',
  'derived-broker': 'DERIVED',
  recording: 'RECORD',
  pipeline: 'PIPELINE',
  snapshot: 'SNAP',
  warmup: 'WARMUP',
  unknown: '—',
}
function kindBadge(kind: string): string {
  return ENCODED_KIND_BADGE[kind] ?? kind.toUpperCase().slice(0, 8)
}
function kindLabel(kind: string): string {
  return ENCODED_KIND_BADGE[kind] ?? kind
}

export interface StreamBrokerPanelProps {
  readonly deviceId: number
  readonly title?: string
  readonly variant?: 'full' | 'compact'
  readonly hideEmpty?: boolean
}

/**
 * Widget entrypoint — maps the standard `WidgetProps` shape (the only
 * thing `<WidgetSlot>` knows how to pass) onto the inner panel's
 * legacy props (`deviceId` + per-host `variant`/`title`/`hideEmpty`).
 *
 * Config keys are read by name so this widget can be configured both
 * from form-builder fields (Phase B) and dashboard layout entries
 * (Phase D) without code changes.
 */
export function StreamBrokerPanel(props: WidgetProps) {
  const { t } = useT()
  const cfg = (props.config ?? {}) as Readonly<
    Partial<{
      title: string
      variant: 'full' | 'compact'
      hideEmpty: boolean
    }>
  >
  if (props.deviceId === undefined) {
    return (
      <div className="rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
        {t('panel.requiresDeviceId')}
      </div>
    )
  }
  return (
    <StreamBrokerPanelInner
      deviceId={props.deviceId}
      title={cfg.title}
      variant={cfg.variant}
      hideEmpty={cfg.hideEmpty}
    />
  )
}

/** Legacy shape — kept exported so admin-ui code that already passes
 *  the typed props can keep using it during the transition. New
 *  consumers should mount via `<WidgetSlot widgetId="stream-broker/stream-broker-panel" deviceId=…/>`. */
export function StreamBrokerPanelInner({
  deviceId,
  title,
  variant = 'full',
  hideEmpty = false,
}: StreamBrokerPanelProps) {
  const { t } = useT()
  // Profile-slot membership only changes on device register/unregister
  // and per-profile slot assignments. Subscribe instead of polling.
  useEventInvalidation(
    ['streamBroker', 'listAllProfileSlots'],
    [
      'device.streams-registered',
      'device.streams-unregistered',
      'device.registered',
      'device.unregistered',
    ],
  )
  // Assigned profile slots for this device, in canonical high→mid→low order.
  const { data: profileSlotsRaw } = useStreamBrokerListAllProfileSlots(undefined, {
    staleTime: 30_000,
  })
  const slots: readonly ProfileSlot[] = (profileSlotsRaw ?? [])
    .filter((s) => s.deviceId === deviceId && s.sourceCamStreamId !== null)
    .slice()
    .toSorted((a, b) => PROFILE_ORDER.indexOf(a.profile) - PROFILE_ORDER.indexOf(b.profile))

  // Published cam-stream registry — routed through DeviceProxy
  // (`cameraStreams` is a device-scoped cap). Used for resolution
  // lookup in the per-slot label ("high (1920×1080)") and for the
  // "Other streams" section listing every non-profile-bound stream.
  const system = useSystem()
  const dev = useDeviceProxy(system.trpcClient, deviceId)
  const { data: camStreams } = useQuery({
    queryKey: ['device', deviceId, 'cameraStreams.getCameraStreams'],
    queryFn: () => dev?.cameraStreams?.getCameraStreams({}) ?? [],
    enabled: !!dev,
    staleTime: 30_000,
  })
  const camStreamById = new Map<string, CameraStream>()
  for (const s of camStreams ?? []) camStreamById.set(s.camStreamId, s)

  // The cluster node that OWNS this camera's source pull (dials it + hosts the
  // broker/restream). Shown as a pill so the operator sees WHERE the source
  // runs — the hub singleton view alone can't tell you when ingest is off-hub.
  const { data: cameraStatus } = usePipelineOrchestratorGetCameraStatus(
    { deviceId },
    { staleTime: 30_000 },
  )
  const sourceNodeId = cameraStatus?.assignment.sourceNodeId ?? null

  // ── The per-device audio plane (D113 phase 3, `broker-audio`) ────────────
  // Read and written on the camera's SOURCE OWNER, never on whichever node the
  // call happens to reach: `stream-broker` is a per-node singleton, so an
  // unrouted answer describes the hub's brokers. `nodeId` is the cap router's
  // out-of-band routing key and is the browser's equivalent of `nodePin`.
  const queryClient = useQueryClient()
  const [pendingAudio, setPendingAudio] = useState<boolean | null>(null)
  const [audioFailure, setAudioFailure] = useState<string | null>(null)
  const audioMuteQuery = useStreamBrokerGetDeviceAudioMute(
    { deviceId, nodeId: sourceNodeId ?? undefined },
    { enabled: sourceNodeId !== null, staleTime: 30_000 },
  )
  const brokerAudio = resolveBrokerAudio({
    muted: readBrokerMuted(audioMuteQuery.data),
    sourceNodeId,
    pendingOn: pendingAudio,
  })
  const setDeviceAudioMute = useStreamBrokerSetDeviceAudioMute({
    onError: (err: unknown) => {
      // A silent revert reads as a write that worked. Tagged with the numeric
      // deviceId like every other per-device line.
      console.error('[StreamBrokerPanel] audio mute write failed — reverting', {
        tags: { deviceId },
        meta: {
          nodeId: sourceNodeId,
          error: err instanceof Error ? err.message : String(err),
        },
      })
      setPendingAudio(null)
      setAudioFailure(err instanceof Error ? err.message : String(err))
      void queryClient.invalidateQueries({ queryKey: [['streamBroker', 'getDeviceAudioMute']] })
    },
    onSuccess: () => {
      setAudioFailure(null)
      setPendingAudio(null)
      void queryClient.invalidateQueries({ queryKey: [['streamBroker']] })
      // The status badge composes `switchedOff` from this same authority.
      void queryClient.invalidateQueries({ queryKey: [['pipelineOrchestrator']] })
    },
  })
  const toggleBrokerAudio = useCallback((): void => {
    const write = brokerAudioWrite(brokerAudio, deviceId)
    if (write === null) return
    setPendingAudio(!write.muted)
    setAudioFailure(null)
    setDeviceAudioMute.mutate(write)
  }, [brokerAudio, deviceId, setDeviceAudioMute])

  // Every published cam stream owns a broker (1:1 with publish/retract).
  // Streams not currently bound to a profile slot land in the collapsed
  // "Other streams" section so the operator still sees their stats.
  const profileBoundIds = new Set(
    slots.map((s) => s.sourceCamStreamId).filter((id): id is string => id !== null),
  )
  const unassignedCamStreams = (camStreams ?? []).filter((c) => !profileBoundIds.has(c.camStreamId))

  const brokerNode = brokerAudio.nodeId ?? t('audio.thisNode')
  const hasSlots = slots.length > 0
  const hasUnassignedActive = unassignedCamStreams.length > 0

  if (hideEmpty && !hasSlots && !hasUnassignedActive) return null

  if (variant === 'compact') {
    if (!hasSlots) {
      return (
        <div className="text-[11px] text-foreground-subtle italic px-2 py-1">
          {t('panel.noActiveSlots')}
        </div>
      )
    }
    return (
      <div className="divide-y divide-border/30">
        {slots.map((slot) => (
          <BrokerRow key={slot.brokerId} slot={slot} camStreams={camStreamById} compact />
        ))}
      </div>
    )
  }

  return (
    <div className="rounded-lg border border-border bg-surface overflow-hidden">
      <div className="border-b border-border px-4 py-2 flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
        <h2 className="text-xs font-semibold text-foreground uppercase tracking-wider shrink-0">
          {title ?? t('panel.title')}
        </h2>
        <div className="flex items-center gap-1.5 min-w-0">
          {sourceNodeId !== null && (
            <span
              title={t('panel.sourceNodeTitle', { node: sourceNodeId })}
              className="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-medium bg-accent/10 text-accent border border-accent/30 min-w-0 max-w-full"
            >
              <Radio className="h-2.5 w-2.5 shrink-0" />
              <span className="truncate">{sourceNodeId}</span>
            </span>
          )}
          {hasSlots && (
            <span className="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-medium bg-foreground-subtle/10 text-foreground-subtle border border-border shrink-0 whitespace-nowrap">
              {t('panel.assigned', { count: slots.length })}
            </span>
          )}
        </div>
      </div>

      {/* ── Audio distribution for this camera, on the node that serves it
          (D113 phase 3). Writes `streamBroker.setDeviceAudioMute` — the
          broker's own DeviceOverride — and never the deprecated switch
          group. An unresolved source node is drawn as unknown rather than
          answered from the hub's brokers. ── */}
      <div className="border-b border-border px-4 py-2 flex items-center gap-3">
        <Button
          variant="unstyled"
          type="button"
          role="switch"
          aria-label={t('audio.label')}
          aria-checked={brokerAudio.on === true}
          disabled={!brokerAudio.available || setDeviceAudioMute.isPending}
          onClick={toggleBrokerAudio}
          title={
            brokerAudio.on === null
              ? t('audio.unknownTitle')
              : brokerAudio.on
                ? t('audio.onTitle', { node: brokerNode, cost: t('audio.costWhenOff') })
                : t('audio.mutedTitle', { node: brokerNode, cost: t('audio.costWhenOff') })
          }
          className={`inline-flex items-center gap-1.5 rounded-lg border px-2 py-1 text-[11px] font-medium transition-colors disabled:cursor-not-allowed shrink-0 ${
            audioFailure !== null
              ? 'border-danger/50 text-danger bg-danger/5'
              : brokerAudio.on === null
                ? 'border-dashed border-border text-foreground-subtle/50'
                : brokerAudio.on === false
                  ? 'border-warning/40 text-warning hover:bg-warning/10'
                  : 'border-success/30 text-success hover:bg-success/10'
          }`}
        >
          {brokerAudio.on === false ? (
            <VolumeX className="h-3.5 w-3.5" />
          ) : (
            <Volume2 className="h-3.5 w-3.5" />
          )}
          <span>
            {brokerAudio.on === null
              ? t('audio.stateUnknown')
              : brokerAudio.on
                ? t('audio.stateOn')
                : t('audio.stateMuted')}
          </span>
        </Button>
        <p className="min-w-0 flex-1 text-[10px] leading-relaxed text-foreground-subtle">
          {audioFailure !== null
            ? t('audio.writeFailed', { error: audioFailure })
            : brokerAudio.on === null
              ? t('audio.unknownHint')
              : t('audio.costWhenOff')}
        </p>
      </div>
      {hasSlots ? (
        <div className="divide-y divide-border/30">
          {slots.map((slot) => (
            <BrokerRow key={slot.brokerId} slot={slot} camStreams={camStreamById} compact={false} />
          ))}
        </div>
      ) : (
        <div className="px-4 py-6 flex flex-col items-center text-center text-foreground-subtle">
          <Radio className="h-5 w-5 mb-2 opacity-30" />
          <p className="text-xs">{t('panel.noSlotsAssigned')}</p>
        </div>
      )}
      {hasUnassignedActive && (
        <UnassignedStreamsSection
          deviceId={deviceId}
          camStreamIds={unassignedCamStreams.map((c) => c.camStreamId)}
          camStreams={camStreamById}
        />
      )}
    </div>
  )
}

// ── Unassigned streams (manually activated, not in any profile slot) ──

interface UnassignedStreamsSectionProps {
  readonly deviceId: number
  readonly camStreamIds: readonly string[]
  readonly camStreams: ReadonlyMap<string, CameraStream>
}

function UnassignedStreamsSection({
  deviceId,
  camStreamIds,
  camStreams,
}: UnassignedStreamsSectionProps) {
  const { t } = useT()
  const [open, setOpen] = useState(false)
  return (
    <div className="border-t border-border/50">
      <Button
        variant="unstyled"
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full px-4 py-1.5 flex items-center justify-between bg-surface-hover/30 hover:bg-surface-hover transition-colors"
      >
        <span className="inline-flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-foreground-subtle">
          {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          {t('unassigned.title')}
        </span>
        <span className="rounded-full px-2 py-0.5 text-[10px] font-medium bg-foreground-subtle/10 text-foreground-subtle border border-border">
          {camStreamIds.length}
        </span>
      </Button>
      {open && (
        <div className="divide-y divide-border/30">
          {camStreamIds.map((camStreamId) => (
            <UnassignedStreamRow
              key={camStreamId}
              deviceId={deviceId}
              camStreamId={camStreamId}
              camStreams={camStreams}
            />
          ))}
        </div>
      )}
    </div>
  )
}

interface UnassignedStreamRowProps {
  readonly deviceId: number
  readonly camStreamId: string
  readonly camStreams: ReadonlyMap<string, CameraStream>
}

function UnassignedStreamRow({ deviceId, camStreamId, camStreams }: UnassignedStreamRowProps) {
  const { t } = useT()
  const brokerId = makeSourceBrokerId(deviceId, camStreamId)

  const statsSnapshot = useEventStreamLatest<{
    brokerId: string
    deviceId: number
    profile: string
    nodeId: string
    stats: BrokerStats
    timestamp: number
  }>('stream-broker.metrics-snapshot', (data) => data.brokerId === brokerId)
  const stats: BrokerStats | undefined = statsSnapshot?.stats

  const cam = camStreams.get(camStreamId)
  const isStreaming = stats?.status === 'streaming'

  return (
    <div className="px-4 py-2">
      <div className="flex items-center justify-between mb-1">
        <div className="flex items-center gap-1.5">
          <span
            className={`h-1.5 w-1.5 rounded-full ${isStreaming ? 'bg-success' : 'bg-foreground-subtle/40'}`}
          />
          <span className="text-[11px] font-medium text-foreground">
            {cam?.label ?? camStreamId}
          </span>
          {cam?.resolution && (
            <span className="text-[10px] text-foreground-subtle">
              {cam.resolution.width}×{cam.resolution.height}
            </span>
          )}
          <span
            className={`text-[10px] ${isStreaming ? 'text-success' : 'text-foreground-subtle'}`}
          >
            {stats?.status ?? t('stats.idle')}
          </span>
        </div>
      </div>
      {stats && isStreaming && (
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-[10px]">
          <span className="inline-flex whitespace-nowrap gap-1">
            <span className="text-foreground-subtle">{t('stats.fps')}</span>
            <span className="text-foreground">{stats.inputFps.toFixed(1)}</span>
          </span>
          <span className="inline-flex whitespace-nowrap gap-1">
            <span className="text-foreground-subtle">{t('stats.bitrate')}</span>
            <span className="text-foreground">
              {stats.bitrateKbps >= 1000
                ? `${(stats.bitrateKbps / 1000).toFixed(1)} Mbps`
                : `${stats.bitrateKbps} kbps`}
            </span>
          </span>
          <span className="inline-flex whitespace-nowrap gap-1">
            <span className="text-foreground-subtle">{t('stats.codec')}</span>
            <span className="text-foreground">{stats.codec?.toUpperCase() ?? '—'}</span>
          </span>
          <span className="inline-flex whitespace-nowrap gap-1">
            <span className="text-foreground-subtle">{t('stats.pkts')}</span>
            <span className="text-foreground">
              {stats.packetCount > 1000
                ? `${(stats.packetCount / 1000).toFixed(1)}k`
                : stats.packetCount}
            </span>
          </span>
        </div>
      )}
    </div>
  )
}

// ── Single broker row ──────────────────────────────────────────────────

interface BrokerRowProps {
  readonly slot: ProfileSlot
  readonly camStreams: ReadonlyMap<string, CameraStream>
  readonly compact: boolean
}

/**
 * Walk the hydrated schema for a leaf field with the matching key.
 * Descends into `'group'` (carries `fields`) and `'sub-tabs'` (carries
 * `tabs[].fields`) so the per-stream pre-buffer values nested under a
 * sub-tabs container are reachable. Field shapes are loose-typed
 * because the schema is consumed verbatim from the wire.
 */
function findFieldValue(
  schema: { readonly sections?: readonly unknown[] } | null | undefined,
  key: string,
): unknown {
  const visit = (field: unknown): unknown => {
    if (!field || typeof field !== 'object') return undefined
    const f = field as {
      readonly key?: unknown
      readonly value?: unknown
      readonly type?: unknown
      readonly fields?: unknown
      readonly tabs?: unknown
    }
    if (typeof f.key === 'string' && f.key === key && 'value' in f) return f.value
    if (f.type === 'group' && Array.isArray(f.fields)) {
      for (const child of f.fields) {
        const found = visit(child)
        if (found !== undefined) return found
      }
    } else if (f.type === 'sub-tabs' && Array.isArray(f.tabs)) {
      for (const tab of f.tabs as ReadonlyArray<{ readonly fields?: unknown }>) {
        if (!Array.isArray(tab.fields)) continue
        for (const child of tab.fields) {
          const found = visit(child)
          if (found !== undefined) return found
        }
      }
    }
    return undefined
  }
  for (const section of (schema?.sections ?? []) as ReadonlyArray<{ readonly fields?: unknown }>) {
    if (!Array.isArray(section.fields)) continue
    for (const field of section.fields) {
      const found = visit(field)
      if (found !== undefined) return found
    }
  }
  return undefined
}

function BrokerRow({ slot, camStreams, compact }: BrokerRowProps) {
  const { t } = useT()
  const queryClient = useQueryClient()

  // Broker stats read DIRECTLY from the snapshot stream — full
  // BrokerStats payload, no tRPC roundtrip. Filter by brokerId so each
  // row only updates on its own broker's tick.
  const statsSnapshot = useEventStreamLatest<{
    brokerId: string
    deviceId: number
    profile: string
    nodeId: string
    stats: BrokerStats
    timestamp: number
  }>('stream-broker.metrics-snapshot', (data) => data.brokerId === slot.brokerId)
  const stats: BrokerStats | undefined = statsSnapshot?.stats

  // Client list isn't included in the snapshot — keep a query but
  // invalidate on the snapshot ticks so the list stays fresh while
  // streaming.
  useEventInvalidation(['streamBroker', 'listClients'], ['stream-broker.metrics-snapshot'])

  const { data: clients } = useStreamBrokerListClients(
    { brokerId: slot.brokerId },
    { enabled: stats?.status === 'streaming', staleTime: 2_000 },
  )

  // Device-level stream-broker settings — pre-buffer toggle + duration
  // live here. We hit `streamBroker.getDeviceSettingsContribution`
  // DIRECTLY rather than the `addonSettings.getDeviceSettings`
  // aggregator: the aggregator currently returns `{sections: []}` for
  // stream-broker (the broker addon doesn't register through the
  // addonSettings cap path), so falling back to it would always make
  // `findFieldValue` return undefined and the UI would render the
  // runtime `stats.preBufferSec` (which is 0 whenever pre-buffer is
  // disabled, since the manager forces duration=0 in that state).
  const { data: deviceSettings, isPending: prebufferPending } =
    useStreamBrokerGetDeviceSettingsContribution({ deviceId: slot.deviceId }, { staleTime: 15_000 })
  // Field keys are keyed by camStreamId (one settings sub-tab per stream
  // source). The value is the EFFECTIVE prebuffer, resolved server-side by the
  // same function that installs it on the broker (D381) — so this switch shows
  // what is running rather than a guess about it.
  //
  // It used to guess, twice over: `?? true` invented ON for any row the query
  // had not answered for, while the server answered the same question `?? false`
  // — an unconfigured warm stream therefore read ON here and OFF in settings,
  // and neither was the broker's state. Not-yet-known is now its own state
  // (D315): the control is disabled and says it is loading, because a switch
  // that shows a position it does not know is worse than one that shows none.
  const preBufferLookupKey = slot.sourceCamStreamId ?? slot.profile
  const preBufferRaw = findFieldValue(deviceSettings, `preBufferEnabled:${preBufferLookupKey}`)
  const preBufferKnown = typeof preBufferRaw === 'boolean'
  const preBufferEnabled = preBufferRaw === true
  const preBufferSecRaw = findFieldValue(deviceSettings, `preBufferSec:${preBufferLookupKey}`)
  const preBufferSecSetting = typeof preBufferSecRaw === 'number' ? preBufferSecRaw : undefined

  const updateSettingsMutation = useStreamBrokerApplyDeviceSettingsPatch({
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: [['streamBroker', 'getDeviceSettingsContribution']],
      })
    },
  })
  const setPreBufferEnabled = (enabled: boolean): void => {
    updateSettingsMutation.mutate({
      deviceId: slot.deviceId,
      patch: { [`preBufferEnabled:${preBufferLookupKey}`]: enabled },
    })
  }

  const killClient = useStreamBrokerKillClient({
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [['streamBroker', 'listClients']] })
    },
  })
  const onKill = useCallback(
    (input: { channel: 'rtsp' | 'audio'; handle: string }) => {
      killClient.mutate({ brokerId: slot.brokerId, ...input })
    },
    [killClient, slot.brokerId],
  )

  const sourceCam = slot.sourceCamStreamId ? camStreams.get(slot.sourceCamStreamId) : undefined
  const resolution = sourceCam?.resolution ?? slot.resolution
  const isStreaming = stats?.status === 'streaming'
  const profileLabel = t(`profile.${slot.profile}`)
  const label = resolution
    ? `${profileLabel} (${resolution.width}×${resolution.height})`
    : profileLabel
  const totalClients = stats
    ? stats.encodedSubscribers + (stats.rtspClients ?? 0) + (stats.pipeClients ?? 0)
    : 0

  return (
    <div
      className={`@container ${compact ? 'px-3 py-1.5' : 'px-4 py-2'}`}
      style={{ containerType: 'inline-size' }}
    >
      <div className="flex items-center justify-between gap-2 mb-1.5">
        <div className="flex items-center gap-1.5 min-w-0">
          <span
            className={`h-1.5 w-1.5 shrink-0 rounded-full ${
              isStreaming
                ? slot.profile === 'high'
                  ? 'bg-success'
                  : slot.profile === 'mid'
                    ? 'bg-warning'
                    : 'bg-foreground-subtle'
                : 'bg-foreground-subtle/40'
            }`}
          />
          <span className="text-[11px] font-medium text-foreground whitespace-nowrap shrink-0">
            {label}
          </span>
          <span
            className={`text-[10px] shrink-0 ${isStreaming ? 'text-success' : 'text-foreground-subtle'}`}
          >
            {stats?.status ?? t('stats.loading')}
          </span>
          {slot.sourceCamStreamId && (
            <span
              className="text-[10px] text-foreground-subtle truncate min-w-0"
              title={slot.sourceCamStreamId}
            >
              ← {slot.sourceCamStreamId}
            </span>
          )}
        </div>
        <span className="text-[10px] text-foreground-subtle shrink-0 whitespace-nowrap">
          {stats && stats.uptimeMs > 0 ? formatUptime(stats.uptimeMs) : '—'}
        </span>
      </div>
      {stats && isStreaming ? (
        compact ? (
          <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[10px]">
            <span className="inline-flex whitespace-nowrap gap-1">
              <span className="text-foreground-subtle">{t('stats.fps')}</span>
              <span className="text-foreground">{stats.inputFps.toFixed(1)} fps</span>
            </span>
            <span className="inline-flex whitespace-nowrap gap-1">
              <span className="text-foreground-subtle">{t('stats.bitrate')}</span>
              <span className="text-foreground">
                {stats.bitrateKbps >= 1000
                  ? `${(stats.bitrateKbps / 1000).toFixed(1)} Mbps`
                  : `${stats.bitrateKbps} kbps`}
              </span>
            </span>
            <span className="inline-flex whitespace-nowrap gap-1">
              <span className="text-foreground-subtle">{t('stats.codec')}</span>
              <span className="text-foreground">{stats.codec?.toUpperCase() ?? '—'}</span>
            </span>
            <span className="inline-flex items-center whitespace-nowrap gap-1">
              <span className="text-foreground-subtle">{t('stats.clients')}</span>
              <span className="text-foreground font-semibold">{totalClients}</span>
              <span className="text-foreground-subtle/70">(</span>
              <SubsBadge count={stats.encodedSubscribers} clients={clients} onKill={onKill} />
              <span className="text-foreground-subtle/70">·</span>
              <RtspBadge count={stats.rtspClients ?? 0} clients={clients} onKill={onKill} />
              <span className="text-foreground-subtle/70">
                {t('stats.pipeSuffix', { count: stats.pipeClients ?? 0 })}
              </span>
            </span>
          </div>
        ) : (
          <>
            {/* Container-query progressive disclosure: at narrow row
                widths the 9 pills wrap into 4+ lines. Always show the
                operator-critical ones (In, Bitrate, Codec); hide
                secondary pills (IDR) below ~480px and tertiary
                pills (Pipe, Packets, Data) below ~640px. The hidden
                metrics remain available in the metrics-snapshot stream
                for log/debugging — this only affects density on the
                stream-broker panel inside narrow column hosts. */}
            <div className="flex flex-wrap gap-x-3 gap-y-1 text-[10px]">
              <span className="inline-flex whitespace-nowrap gap-1">
                <span className="text-foreground-subtle">{t('stats.in')}</span>
                <span className="text-foreground">{stats.inputFps.toFixed(1)} fps</span>
              </span>
              <span className="inline-flex whitespace-nowrap gap-1">
                <span className="text-foreground-subtle">{t('stats.bitrate')}</span>
                <span className="text-foreground">
                  {stats.bitrateKbps >= 1000
                    ? `${(stats.bitrateKbps / 1000).toFixed(1)} Mbps`
                    : `${stats.bitrateKbps} kbps`}
                </span>
              </span>
              <span className="hidden @[480px]:inline-flex whitespace-nowrap gap-1">
                <span className="text-foreground-subtle">{t('stats.idr')}</span>
                <span className="text-foreground">
                  {stats.idrIntervalMs > 0 ? `${(stats.idrIntervalMs / 1000).toFixed(1)}s` : '—'}
                </span>
              </span>
              <span className="inline-flex whitespace-nowrap gap-1">
                <span className="text-foreground-subtle">{t('stats.codec')}</span>
                <span className="text-foreground">{stats.codec?.toUpperCase() ?? '—'}</span>
              </span>
              <span className="hidden @[640px]:inline-flex whitespace-nowrap gap-1">
                <span className="text-foreground-subtle">{t('stats.pipe')}</span>
                <span className="text-foreground">{stats.pipeClients ?? 0}</span>
              </span>
              <span className="hidden @[640px]:inline-flex whitespace-nowrap gap-1">
                <span className="text-foreground-subtle">{t('stats.packets')}</span>
                <span className="text-foreground">
                  {stats.packetCount > 1000
                    ? `${(stats.packetCount / 1000).toFixed(1)}k`
                    : stats.packetCount}
                </span>
              </span>
              <span className="hidden @[640px]:inline-flex whitespace-nowrap gap-1">
                <span className="text-foreground-subtle">{t('stats.data')}</span>
                <span className="text-foreground">
                  {stats.totalBytes > 1048576
                    ? `${(stats.totalBytes / 1048576).toFixed(1)} MB`
                    : `${(stats.totalBytes / 1024).toFixed(0)} KB`}
                </span>
              </span>
              {stats.audio && (
                <div className="basis-full flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
                  <span className="text-foreground-subtle whitespace-nowrap">
                    {t('stats.audio')}
                  </span>
                  <span className="inline-flex whitespace-nowrap items-center gap-1.5">
                    <span className="text-foreground">{stats.audio.codec.toUpperCase()}</span>
                    <span className="text-foreground-subtle">·</span>
                    <span className="text-foreground">
                      {stats.audio.sampleRate >= 1000
                        ? `${(stats.audio.sampleRate / 1000).toFixed(stats.audio.sampleRate % 1000 === 0 ? 0 : 1)}kHz`
                        : `${stats.audio.sampleRate}Hz`}
                    </span>
                    <span className="text-foreground-subtle">·</span>
                    <span className="text-foreground">
                      {stats.audio.channels === 1
                        ? t('stats.mono')
                        : stats.audio.channels === 2
                          ? t('stats.stereo')
                          : `${stats.audio.channels}ch`}
                    </span>
                  </span>
                  <span
                    className={`px-1 py-px rounded text-[8px] font-medium whitespace-nowrap ${stats.audio.supported ? 'bg-success/15 text-success' : 'bg-amber-500/15 text-amber-500'}`}
                  >
                    {stats.audio.supported ? t('stats.decoded') : t('stats.noDecoder')}
                  </span>
                </div>
              )}
            </div>
            <SubscribersSection
              clients={clients}
              encodedCount={stats.encodedSubscribers}
              onKill={onKill}
            />
          </>
        )
      ) : (
        <p className="text-[10px] text-foreground-subtle italic">{t('stats.noDemand')}</p>
      )}
      {/* Pre-buffer switch is rendered ALWAYS (even while suspended)
          so operators can flip it on for an idle stream — the next
          subscriber will then see the full prebuffer window from the
          moment the broker resumes. */}
      <div className="mt-1.5 flex items-center gap-1.5 text-[10px]">
        <span className="text-foreground-subtle">{t('stats.buffer')}</span>
        <PreBufferSwitch
          enabled={preBufferEnabled}
          known={preBufferKnown}
          onToggle={(v) => setPreBufferEnabled(v)}
          disabled={prebufferPending || !preBufferKnown || updateSettingsMutation.isPending}
        />
        <span className="text-foreground">
          {preBufferKnown ? `${preBufferSecSetting ?? stats?.preBufferSec ?? 0}s` : '…'}
          {preBufferKnown && stats && isStreaming ? ` (${stats.preBufferPackets}p)` : ''}
        </span>
      </div>
    </div>
  )
}

// ── Client-count badges with hover tooltip ────────────────────────────

const TOOLTIP_ESTIMATED_HEIGHT_PX = 280

interface HoverPopoverProps {
  readonly trigger: ReactNode
  readonly content: ReactNode
  readonly widthClass: string
}

const CLOSE_GRACE_MS = 120

function HoverPopover({ trigger, content, widthClass }: HoverPopoverProps) {
  const wrapRef = useRef<HTMLSpanElement | null>(null)
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [open, setOpen] = useState(false)
  const [above, setAbove] = useState(false)

  const cancelClose = useCallback(() => {
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current)
      closeTimerRef.current = null
    }
  }, [])

  const scheduleClose = useCallback(() => {
    cancelClose()
    closeTimerRef.current = setTimeout(() => setOpen(false), CLOSE_GRACE_MS)
  }, [cancelClose])

  const onTriggerEnter = useCallback(() => {
    cancelClose()
    const el = wrapRef.current
    if (el) {
      const rect = el.getBoundingClientRect()
      const spaceBelow = window.innerHeight - rect.bottom
      const spaceAbove = rect.top
      setAbove(spaceBelow < TOOLTIP_ESTIMATED_HEIGHT_PX && spaceAbove > spaceBelow)
    }
    setOpen(true)
  }, [cancelClose])

  const placement = above ? 'bottom-full mb-1' : 'top-full mt-1'

  return (
    <span
      ref={wrapRef}
      className="relative inline-block"
      onMouseEnter={onTriggerEnter}
      onMouseLeave={scheduleClose}
    >
      {trigger}
      {open && (
        <div
          className={`absolute left-0 ${placement} z-50 ${widthClass} rounded-md border border-border bg-surface shadow-xl p-2 text-[10px] normal-case`}
          onMouseEnter={cancelClose}
          onMouseLeave={scheduleClose}
        >
          {content}
        </div>
      )}
    </span>
  )
}

function formatAge(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m`
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(1)} MB`
  return `${(bytes / 1073741824).toFixed(2)} GB`
}

interface SubscribersSectionProps {
  readonly clients: BrokerClients | undefined
  readonly encodedCount: number
  readonly onKill?: (input: { channel: 'rtsp' | 'audio'; handle: string }) => void
}

function SubscribersSection({ clients, encodedCount, onKill }: SubscribersSectionProps) {
  const { t } = useT()
  const audio = clients?.audio ?? []
  const rtsp = clients?.rtsp ?? []
  const encoded = clients?.encoded ?? []
  const total = audio.length + rtsp.length + encoded.length
  const [open, setOpen] = useState(true)

  if (total === 0) {
    return (
      <div className="mt-1.5 text-[10px] text-foreground-subtle italic">
        {t('subscribers.none')}
      </div>
    )
  }

  return (
    <div className="mt-1.5 border-t border-border/30 pt-1.5">
      <Button
        variant="unstyled"
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 text-[10px] text-foreground-subtle hover:text-foreground transition-colors"
      >
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        <span className="uppercase tracking-wider">
          {t('subscribers.heading', { count: total })}
        </span>
      </Button>
      {open && (
        <div className="mt-1 divide-y divide-border/20">
          {audio.map((c, i) => (
            <SubscriberRow
              key={`a-${i}`}
              kind={t('subscribers.kindAudio')}
              kindClass="bg-info/10 text-info"
              tag={c.tag || t('subscribers.unknown')}
              metrics={[t('subscribers.chunks', { count: c.chunksDelivered })]}
              age={Date.now() - c.subscribedAt}
              onKill={
                onKill && c.tag ? () => onKill({ channel: 'audio', handle: c.tag }) : undefined
              }
            />
          ))}
          {rtsp.map((s) => {
            const staleMs = Date.now() - s.lastRtpAt
            const isStale = staleMs > 5000
            const stateLabel = s.playing
              ? isStale
                ? t('subscribers.stalled')
                : t('subscribers.playing')
              : t('subscribers.paused')
            const stateClass = s.playing
              ? isStale
                ? 'bg-amber-400/10 text-amber-400'
                : 'bg-success/10 text-success'
              : 'bg-foreground-subtle/10 text-foreground-subtle'
            return (
              <SubscriberRow
                key={`r-${s.sessionId}`}
                kind="RTSP"
                kindClass="bg-warning/10 text-warning"
                // Prefer the client's User-Agent (e.g. `recorder` for the
                // recorder's pull) so a consumer reads by purpose, not by a bare
                // localhost address; fall back to the address for anonymous pulls.
                tag={s.userAgent ? formatUa(s.userAgent) : s.remoteAddr}
                state={{
                  text: s.muted ? t('subscribers.stateMuted', { state: stateLabel }) : stateLabel,
                  className: stateClass,
                }}
                metrics={[
                  formatBytes(s.bytesSent),
                  t('subscribers.lastRtp', { age: formatAge(staleMs) }),
                ]}
                age={Date.now() - s.connectedAt}
                onKill={onKill ? () => onKill({ channel: 'rtsp', handle: s.sessionId }) : undefined}
              />
            )
          })}
          {encoded.map((c) => {
            const a = c.attribution
            const kindClass =
              ENCODED_KIND_CLASS[a.kind] ?? 'bg-foreground-subtle/10 text-foreground-subtle'
            // The tag is intentionally LEAN: parent broker row already
            // shows brokerId / cam name / cam-stream, so repeating them
            // here is pure noise. Surface only what disambiguates the
            // SUBSCRIBER from siblings of the same kind on the same
            // broker — short sessionId + optional human label + optional
            // remoteAddr/user.
            const sessShort = a.sessionId ? a.sessionId.slice(0, 8) : null
            const tagParts: string[] = []
            if (a.label) tagParts.push(a.label)
            if (sessShort) tagParts.push(t('subscribers.session', { id: sessShort }))
            if (a.userId) tagParts.push(t('subscribers.user', { id: a.userId.slice(0, 8) }))
            if (a.remoteAddr) tagParts.push(`@${a.remoteAddr}`)
            if (a.userAgent) tagParts.push(formatUa(a.userAgent))
            const tag = tagParts.length > 0 ? tagParts.join(' · ') : kindLabel(a.kind)
            const metrics: Array<string | { text: string }> = []
            // Media chip
            if (a.media) metrics.push({ text: a.media })
            // Target codec
            if (a.targetCodec) metrics.push(a.targetCodec)
            // Transport (passthrough/repacketize/transcode)
            if (a.transport) metrics.push(a.transport)
            metrics.push(t('subscribers.pkts', { count: c.packetsDelivered }))
            return (
              <SubscriberRow
                key={c.id}
                kind={kindBadge(a.kind)}
                kindClass={kindClass}
                tag={tag}
                metrics={metrics}
                age={Date.now() - c.subscribedAt}
              />
            )
          })}
          {encoded.length === 0 && encodedCount > 0 && (
            <div className="py-0.5 text-[10px] text-foreground-subtle">
              <span className="inline-block px-1 rounded text-[9px] font-bold bg-foreground-subtle/10 text-foreground-subtle mr-2">
                {t('subscribers.kindEncoded')}
              </span>
              {t('subscribers.callbackCount', { count: encodedCount })}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

interface SubscriberRowProps {
  readonly kind: string
  readonly kindClass: string
  readonly tag: string
  readonly state?: { readonly text: string; readonly className: string }
  readonly metrics: ReadonlyArray<string | { readonly text: string; readonly warn?: boolean }>
  readonly age: number
  readonly onKill?: () => void
}

function SubscriberRow({ kind, kindClass, tag, state, metrics, age, onKill }: SubscriberRowProps) {
  // Container-query responsive row (parent BrokerRow is the `@container`).
  // Below 420px the identity (badge + tag) and the metrics stack onto two
  // lines so a long tag or a long metric list never forces the row — and
  // therefore the whole panel — to overflow horizontally. At/above 420px
  // the row collapses back to the original single desktop line.
  return (
    <div className="flex flex-col gap-y-0.5 py-0.5 text-[10px] @[420px]:flex-row @[420px]:items-center @[420px]:gap-2">
      {/* Identity: kind chip + tag (+ kick on narrow, where the trailing
          kill cell is hidden). */}
      <div className="flex items-center gap-2 min-w-0 @[420px]:flex-1">
        <span
          className={`inline-block px-1 rounded text-[9px] font-bold shrink-0 w-14 text-center ${kindClass}`}
        >
          {kind}
        </span>
        <span className="text-foreground font-medium truncate min-w-0 flex-1" title={tag}>
          {tag}
        </span>
        {onKill && (
          <div className="shrink-0 flex items-center justify-end @[420px]:hidden">
            <KickButton onClick={onKill} />
          </div>
        )}
      </div>
      {/* Metrics: state chip + metric tokens + age. Wraps on narrow
          (indented to align under the tag), single nowrap run on desktop. */}
      <div className="flex items-center flex-wrap gap-1.5 text-foreground-subtle pl-16 @[420px]:pl-0 @[420px]:flex-nowrap @[420px]:shrink-0">
        {state && (
          <span className={`text-[9px] px-1 rounded shrink-0 ${state.className}`}>
            {state.text}
          </span>
        )}
        {metrics.map((m, i) => (
          <span key={i} className="whitespace-nowrap">
            {i > 0 && <span className="mr-1.5 text-foreground-subtle/50">·</span>}
            {typeof m === 'string' ? (
              m
            ) : (
              <span className={m.warn ? 'text-amber-400' : ''}>{m.text}</span>
            )}
          </span>
        ))}
        <span className="text-foreground-subtle/70 whitespace-nowrap">· {formatAge(age)}</span>
      </div>
      {/* Kill button lives in its own fixed-width cell so every row
          lines the button up at the same horizontal position, regardless
          of how many metric tokens precede it. Hidden on narrow (the kick
          moves next to the tag above). Placeholder keeps layout stable
          when a row has no onKill handler. */}
      <div className="hidden @[420px]:flex w-5 flex-shrink-0 items-center justify-end">
        {onKill ? <KickButton onClick={onKill} /> : null}
      </div>
    </div>
  )
}

interface BadgeProps {
  readonly count: number
  readonly clients: BrokerClients | undefined
  readonly onKill?: (input: { channel: 'rtsp' | 'audio'; handle: string }) => void
}

function SubsBadge({ count, clients, onKill }: BadgeProps) {
  const { t } = useT()
  const audio = clients?.audio ?? []
  const encodedCount = clients ? clients.encodedSubscribers : 0
  const hasAny = audio.length > 0 || encodedCount > 0

  const trigger = (
    <span
      className={`text-foreground ${hasAny ? 'underline decoration-dotted decoration-foreground-subtle/50 underline-offset-2 cursor-help' : ''}`}
    >
      {count}
    </span>
  )

  if (!hasAny) return trigger

  const content = (
    <>
      {audio.length > 0 && (
        <div className="mb-2">
          <div className="text-foreground-subtle uppercase text-[9px] tracking-wider mb-1">
            {t('subscribers.audioHeading')}
          </div>
          {audio.map((c, i) => (
            <div key={`a-${i}`} className="flex items-center justify-between gap-2 py-0.5">
              <span className="text-foreground font-medium truncate">
                {c.tag || t('subscribers.unknown')}
              </span>
              <span className="text-foreground-subtle text-[9px] flex items-center gap-1.5 shrink-0">
                <span>{t('subscribers.chunks', { count: c.chunksDelivered })}</span>
                <span>·</span>
                <span>{formatAge(Date.now() - c.subscribedAt)}</span>
                {onKill && c.tag && (
                  <KickButton onClick={() => onKill({ channel: 'audio', handle: c.tag })} />
                )}
              </span>
            </div>
          ))}
        </div>
      )}
      {encodedCount > 0 && (
        <div>
          <div className="text-foreground-subtle uppercase text-[9px] tracking-wider mb-1">
            {t('subscribers.encodedHeading')}
          </div>
          <div className="text-foreground">
            {t('subscribers.callbackCount', { count: encodedCount })}
          </div>
        </div>
      )}
    </>
  )

  return (
    <HoverPopover trigger={trigger} content={content} widthClass="min-w-[260px] max-w-[360px]" />
  )
}

function PreBufferSwitch({
  enabled,
  known,
  onToggle,
  disabled,
}: {
  readonly enabled: boolean
  /**
   * Whether the answer has ARRIVED. `false` is not "off" — it is "this switch
   * does not know yet", and it renders neither position (D315).
   */
  readonly known: boolean
  readonly onToggle: (next: boolean) => void
  readonly disabled: boolean
}) {
  const { t } = useT()
  return (
    <Button
      variant="unstyled"
      type="button"
      role="switch"
      aria-checked={known ? enabled : 'mixed'}
      disabled={disabled}
      onClick={() => onToggle(!enabled)}
      className={`relative inline-flex h-3 w-6 shrink-0 items-center rounded-full transition-colors ${
        !known ? 'bg-foreground-subtle/20' : enabled ? 'bg-success/60' : 'bg-foreground-subtle/30'
      } ${disabled ? 'opacity-50 cursor-wait' : 'cursor-pointer'}`}
      title={
        !known ? t('prebuffer.loading') : enabled ? t('prebuffer.enabled') : t('prebuffer.disabled')
      }
    >
      <span
        className={`inline-block h-2.5 w-2.5 rounded-full bg-white shadow transition-transform ${
          enabled ? 'translate-x-3' : 'translate-x-0.5'
        }`}
      />
    </Button>
  )
}

function KickButton({ onClick }: { onClick: () => void }) {
  const { t } = useT()
  return (
    <Button
      variant="unstyled"
      type="button"
      title={t('subscribers.kick')}
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
      className="inline-flex items-center justify-center h-4 w-4 rounded-sm border border-border/60 text-foreground-subtle hover:bg-red-500/10 hover:text-red-400 hover:border-red-500/40 transition-colors"
    >
      <X className="h-2.5 w-2.5" />
    </Button>
  )
}

function RtspBadge({ count, clients, onKill }: BadgeProps) {
  const { t } = useT()
  const sessions = clients?.rtsp ?? []
  const hasAny = sessions.length > 0

  const trigger = (
    <span
      className={`text-foreground ${hasAny ? 'underline decoration-dotted decoration-foreground-subtle/50 underline-offset-2 cursor-help' : ''}`}
    >
      {count}
    </span>
  )

  if (!hasAny) return trigger

  const content = (
    <>
      <div className="text-foreground-subtle uppercase text-[9px] tracking-wider mb-1">
        {t('subscribers.rtspHeading')}
      </div>
      {sessions.map((s) => {
        const staleMs = Date.now() - s.lastRtpAt
        const isStale = staleMs > 5000
        const stateLabel = s.playing
          ? isStale
            ? t('subscribers.stalled')
            : t('subscribers.playing')
          : t('subscribers.paused')
        return (
          <div key={s.sessionId} className="py-1 border-b border-border/40 last:border-b-0">
            <div className="flex items-center justify-between gap-2">
              <span className="text-foreground font-mono">
                {s.userAgent ? formatUa(s.userAgent) : s.remoteAddr}
              </span>
              <span className="flex items-center gap-1 shrink-0">
                <span
                  className={`text-[9px] px-1 rounded ${
                    s.playing
                      ? isStale
                        ? 'bg-amber-400/10 text-amber-400'
                        : 'bg-success/10 text-success'
                      : 'bg-foreground-subtle/10 text-foreground-subtle'
                  }`}
                >
                  {s.muted ? t('subscribers.stateMuted', { state: stateLabel }) : stateLabel}
                </span>
                {onKill && (
                  <KickButton onClick={() => onKill({ channel: 'rtsp', handle: s.sessionId })} />
                )}
              </span>
            </div>
            <div className="flex items-center justify-between gap-2 text-foreground-subtle text-[9px] mt-0.5">
              <span>{t('subscribers.sent', { bytes: formatBytes(s.bytesSent) })}</span>
              <span>
                {t('subscribers.connected', { age: formatAge(Date.now() - s.connectedAt) })}
              </span>
              <span>{t('subscribers.lastRtp', { age: formatAge(staleMs) })}</span>
            </div>
          </div>
        )
      })}
    </>
  )

  return (
    <HoverPopover trigger={trigger} content={content} widthClass="min-w-[300px] max-w-[420px]" />
  )
}
