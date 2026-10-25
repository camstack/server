import { useState, useCallback } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Radio, Copy, Check, RefreshCw, RotateCcw, RefreshCcw } from 'lucide-react'
import {
  useDeviceManagerProbeStreams,
  useDeviceProxy,
  useStreamBrokerAssignProfile,
  useStreamBrokerGetAllRtspEntries,
  useStreamBrokerListAllProfileSlots,
  useStreamBrokerRegenerateRtspToken,
  useStreamBrokerSetRtspEnabled,
  useStreamBrokerUnassignProfile,
  useSystem,
  useSystemNetworkAddresses,
} from '@camstack/ui-library'

import { useConfirm } from '@camstack/ui-library'
import type { CamProfile } from '@camstack/types'

interface StreamsTabProps {
  /** Numeric device id — every cap (`cameraStreams`, `streamBroker`)
   *  accepts it directly. brokerId is `${deviceId}/${profile}`. */
  readonly deviceId: number
}

/**
 * UI-level stream row. Populated from the device-scoped `cameraStreams`
 * cap (`getCameraStreams`) — the broker's own registry is the single
 * source of truth for the "what streams can I assign to a profile?"
 * dropdown. Cam streams keep a stable `camStreamId` (e.g. `stream-1`)
 * that profile assignments reference.
 *
 * Legacy `deviceManager.getStreamSources` added cosmetic fields
 * (`label`, `protocol`, `profileHint`) that don't exist on
 * `CameraStream`; the tab derives a human label from the cam stream's
 * `label` (or falls back to `camStreamId`) and skips protocol since
 * every published cam stream's kind is already queryable via `kind`.
 */
interface AvailableStream {
  readonly id: string
  readonly label: string
  readonly url?: string
  readonly resolution?: { readonly width: number; readonly height: number }
  readonly fps?: number
  readonly codec?: string
  readonly kind: string
}

interface StreamProfileMap {
  high?: string | null
  mid?: string | null
  low?: string | null
  [key: string]: string | null | undefined
}

type ProfileKey = CamProfile

const PROFILES: { key: ProfileKey; label: string; color: string }[] = [
  { key: 'high', label: 'HIGH', color: 'bg-success/10 text-success border-success/30' },
  { key: 'mid', label: 'MID', color: 'bg-warning/10 text-warning border-warning/30' },
  {
    key: 'low',
    label: 'LOW',
    color: 'bg-foreground-subtle/10 text-foreground-subtle border-foreground-subtle/30',
  },
]

import { streamLabel } from '../../shared/stream-labels'
import { useTranslation } from 'react-i18next'

function formatCodec(codec: string): string {
  const display: Record<string, string> = { h264: 'H.264', h265: 'H.265', hevc: 'H.265' }
  return display[codec] ?? codec.toUpperCase()
}

export function StreamsTab({ deviceId }: StreamsTabProps) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const enabled = Number.isFinite(deviceId)
  const [copiedUrl, setCopiedUrl] = useState<string | null>(null)
  const [activeStreamTab, setActiveStreamTab] = useState<string | null>(null)

  // Published cam streams via the device-scoped `cameraStreams` cap —
  // routed through the DeviceProxy so the cap-method call goes through
  // the wrapper chain with deviceId/nodeId auto-injected.
  const system = useSystem()
  const dev = useDeviceProxy(system.trpcClient, enabled ? deviceId : null)
  const {
    data: camStreams,
    isLoading,
    isFetching,
  } = useQuery({
    queryKey: ['device', deviceId, 'cameraStreams.getCameraStreams'],
    queryFn: () => dev?.cameraStreams?.getCameraStreams({}) ?? [],
    enabled: !!dev && enabled,
  })
  const streams: readonly AvailableStream[] = (camStreams ?? []).map(
    (c): AvailableStream => ({
      id: c.camStreamId,
      label: c.label ?? c.camStreamId,
      kind: c.kind,
      ...(c.url !== undefined ? { url: c.url } : {}),
      ...(c.resolution !== undefined ? { resolution: c.resolution } : {}),
      ...(c.fps !== undefined ? { fps: c.fps } : {}),
      ...(c.codec !== undefined ? { codec: c.codec } : {}),
    }),
  )

  // Profile slot snapshot for this device — drives the "assigned" badges
  // on each stream tab and the per-stream live stats in StreamDetail.
  const { data: allProfileSlots } = useStreamBrokerListAllProfileSlots(undefined, {
    enabled,
    refetchInterval: 3_000,
  })
  const deviceSlots = (allProfileSlots ?? []).filter((s) => s.deviceId === deviceId)

  // Reverse view of deviceSlots: `{high?, mid?, low?}` → camStreamId.
  // Kept as a plain record so handleProfileChange can mutate it
  // like the old `profileMap` shape without restructuring the UI.
  const profileMap: Record<string, string | null> = {
    high: deviceSlots.find((s) => s.profile === 'high')?.sourceCamStreamId ?? null,
    mid: deviceSlots.find((s) => s.profile === 'mid')?.sourceCamStreamId ?? null,
    low: deviceSlots.find((s) => s.profile === 'low')?.sourceCamStreamId ?? null,
  }

  const probeMutation = useDeviceManagerProbeStreams({
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [['cameraStreams', 'getCameraStreams']] })
      queryClient.invalidateQueries({ queryKey: [['streamBroker', 'listAllProfileSlots']] })
    },
  })

  // Profile assignment is now broker-driven — route single-profile
  // writes to `streamBroker.assignProfile` / `unassignProfile`. The
  // old `deviceManager.setStreamProfileMap` (batch write) is gone;
  // operators can still set all three slots in one UI tick by
  // sequencing three mutations.
  const assignProfileMutation = useStreamBrokerAssignProfile({
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [['streamBroker', 'listAllProfileSlots']] })
    },
  })
  const unassignProfileMutation = useStreamBrokerUnassignProfile({
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [['streamBroker', 'listAllProfileSlots']] })
    },
  })

  const handleProfileChange = useCallback(
    (profile: ProfileKey, camStreamId: string | undefined) => {
      if (camStreamId) assignProfileMutation.mutate({ deviceId, profile, camStreamId })
      else unassignProfileMutation.mutate({ deviceId, profile })
    },
    [assignProfileMutation, unassignProfileMutation, deviceId],
  )

  const handleCopy = useCallback(async (url: string) => {
    try {
      await navigator.clipboard.writeText(url)
      setCopiedUrl(url)
      setTimeout(() => setCopiedUrl(null), 2000)
    } catch {
      /* clipboard not available */
    }
  }, [])

  if (isLoading) {
    return <div className="h-40 rounded-lg border border-border bg-surface animate-pulse" />
  }

  const streamList = streams ?? []
  const currentProfiles = profileMap ?? {}
  const selectedStream = streamList.find((s) => s.id === activeStreamTab) ?? streamList[0]

  // Reverse map: streamId → assigned profiles
  const streamProfiles = new Map<string, ProfileKey[]>()
  for (const { key } of PROFILES) {
    const assigned = currentProfiles[key]
    if (assigned) {
      const existing = streamProfiles.get(assigned) ?? []
      existing.push(key)
      streamProfiles.set(assigned, existing)
    }
  }

  return (
    <div className="space-y-4">
      {/* ── Profile Assignment ── */}
      <div className="rounded-lg border border-border bg-surface overflow-hidden">
        <div className="border-b border-border px-4 py-2.5 flex items-center justify-between">
          <h2 className="text-xs font-semibold text-foreground uppercase tracking-wider">
            {t('cameras.streamsTab.streamProfiles', 'Stream Profiles')}
          </h2>
          <button
            onClick={() => {
              // Sort by pixel count descending, then dispatch three
              // assignProfile mutations in sequence. The broker runs
              // its own computeInitialAssignment on publish; this
              // button is for operators who want to force a specific
              // pixel-rank mapping over the auto result.
              const sorted = [...streamList].toSorted((a, b) => {
                const pxA = (a.resolution?.width ?? 0) * (a.resolution?.height ?? 0)
                const pxB = (b.resolution?.width ?? 0) * (b.resolution?.height ?? 0)
                return pxB - pxA
              })
              const autoMap: StreamProfileMap = {}
              if (sorted.length >= 1) autoMap.high = sorted[0]?.id
              if (sorted.length >= 3) autoMap.mid = sorted[1]?.id
              if (sorted.length >= 2) autoMap.low = sorted[sorted.length - 1]?.id
              if (sorted.length === 1) {
                autoMap.mid = sorted[0]?.id
                autoMap.low = sorted[0]?.id
              }
              for (const { key } of PROFILES) {
                const camStreamId = autoMap[key]
                if (camStreamId)
                  assignProfileMutation.mutate({ deviceId, profile: key, camStreamId })
                else unassignProfileMutation.mutate({ deviceId, profile: key })
              }
            }}
            disabled={
              assignProfileMutation.isPending ||
              unassignProfileMutation.isPending ||
              streamList.length === 0
            }
            className="flex items-center gap-1.5 text-xs font-medium text-foreground-subtle hover:text-foreground disabled:opacity-40 transition-colors"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            {t('cameras.streamsTab.autoAssign', 'Auto-assign')}
          </button>
        </div>

        {streamList.length === 0 ? (
          <div className="px-4 py-6 text-center text-xs text-foreground-subtle">
            {t('cameras.streamsTab.noStreamsAvailable', 'No streams available')}
          </div>
        ) : (
          <div className="divide-y divide-border">
            {PROFILES.map(({ key, label, color }) => (
              <div key={key} className="flex items-center gap-4 px-4 py-3">
                <div className="w-20 flex-shrink-0">
                  <span
                    className={`inline-block text-[10px] font-bold uppercase px-2 py-0.5 rounded border ${color}`}
                  >
                    {label}
                  </span>
                </div>
                <select
                  className="flex-1 rounded-md border border-border bg-background px-3 py-1.5 text-sm text-foreground"
                  value={currentProfiles[key] ?? ''}
                  onChange={(e) => handleProfileChange(key, e.target.value || undefined)}
                  disabled={assignProfileMutation.isPending || unassignProfileMutation.isPending}
                >
                  <option value="">
                    {t('cameras.streamsTab.notAssigned', '— Not assigned —')}
                  </option>
                  {streamList.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.label ?? streamLabel(s.id)}
                      {s.resolution?.width ? ` (${s.resolution.width}×${s.resolution.height})` : ''}
                    </option>
                  ))}
                </select>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Available Streams (tabbed) ── */}
      <div className="rounded-lg border border-border bg-surface overflow-hidden">
        <div className="border-b border-border px-4 py-2.5 flex items-center justify-between">
          <h2 className="text-xs font-semibold text-foreground uppercase tracking-wider">
            {t('cameras.streamsTab.availableStreams', 'Available Streams')}
          </h2>
          <button
            onClick={() => probeMutation.mutate({ deviceId })}
            disabled={probeMutation.isPending || isFetching || streamList.length === 0}
            className="flex items-center gap-1.5 text-xs font-medium text-info hover:text-info/80 disabled:opacity-40 transition-colors"
          >
            <RefreshCw
              className={`h-3.5 w-3.5 ${probeMutation.isPending || isFetching ? 'animate-spin' : ''}`}
            />
            {t('cameras.streamsTab.reProbe', 'Re-probe')}
          </button>
        </div>

        {streamList.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-foreground-subtle">
            <Radio className="h-7 w-7 mb-2 opacity-30" />
            <p className="text-sm">
              {t('cameras.streamsTab.noStreamsAvailable', 'No streams available')}
            </p>
          </div>
        ) : (
          <>
            {/* Stream tabs */}
            <div className="flex border-b border-border">
              {streamList.map((stream) => {
                const isActive = (selectedStream?.id ?? streamList[0]?.id) === stream.id
                const assignedProfiles = streamProfiles.get(stream.id) ?? []
                return (
                  <button
                    key={stream.id}
                    onClick={() => setActiveStreamTab(stream.id)}
                    className={`flex items-center gap-2 px-4 py-2.5 text-xs font-medium border-b-2 transition-colors ${
                      isActive
                        ? 'border-primary text-primary'
                        : 'border-transparent text-foreground-subtle hover:text-foreground hover:border-border'
                    }`}
                  >
                    {stream.label ?? streamLabel(stream.id)}
                    {assignedProfiles.map((p) => (
                      <span
                        key={p}
                        className={`text-[9px] font-bold uppercase px-1 py-0.5 rounded border ${
                          PROFILES.find((pr) => pr.key === p)?.color ?? ''
                        }`}
                      >
                        {p}
                      </span>
                    ))}
                  </button>
                )
              })}
            </div>

            {/* Selected stream detail */}
            {selectedStream && enabled && (
              <StreamDetail stream={selectedStream} copiedUrl={copiedUrl} onCopy={handleCopy} />
            )}
          </>
        )}
      </div>

      {/* ── RTSP Restream URLs ── */}
      {enabled && (
        <RtspRestreamSection
          deviceId={deviceId}
          streamList={streamList}
          copiedUrl={copiedUrl}
          onCopy={handleCopy}
        />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// RTSP Restream Section
// ---------------------------------------------------------------------------

function RtspRestreamSection({
  deviceId,
  streamList: _streamList,
  copiedUrl,
  onCopy,
}: {
  /** Numeric system-wide id — brokerId is `${deviceId}/${streamId}`. */
  readonly deviceId: number
  readonly streamList: readonly AvailableStream[]
  readonly copiedUrl: string | null
  readonly onCopy: (url: string) => void
}) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const confirm = useConfirm()
  const [selectedHost, setSelectedHost] = useState<string>(window.location.hostname)

  const { data: networkAddresses } = useSystemNetworkAddresses(undefined)

  const ipv4Addresses = (networkAddresses ?? []).filter((a) => a.family === 'IPv4')

  const { data: rtspEntries, isError: rtspError } = useStreamBrokerGetAllRtspEntries(
    { hostname: selectedHost },
    {
      retry: 2,
      retryDelay: 3_000,
    },
  )

  const regenerateMutation = useStreamBrokerRegenerateRtspToken({
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [['streamBroker', 'getAllRtspEntries']] })
    },
  })

  const enabledMutation = useStreamBrokerSetRtspEnabled({
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [['streamBroker', 'getAllRtspEntries']] })
    },
  })

  // Filter entries for this device — brokerId = `${deviceId}/${streamId}`.
  const deviceIdStr = String(deviceId)
  const deviceUrls = (rtspEntries ?? []).filter(
    (r) => r.brokerId.startsWith(deviceIdStr + '/') || r.brokerId === deviceIdStr,
  )

  // Hide only when data loaded successfully but no entries for this device
  if (!rtspError && deviceUrls.length === 0) {
    return null
  }

  return (
    <div className="rounded-lg border border-border bg-surface overflow-hidden">
      <div className="border-b border-border px-4 py-2.5 flex items-center justify-between">
        <h2 className="text-xs font-semibold text-foreground uppercase tracking-wider">
          {t('cameras.streamsTab.rtspRestream', 'RTSP Restream')}
        </h2>
        {ipv4Addresses.length > 0 && (
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-foreground-subtle">
              {t('cameras.streamsTab.host', 'Host:')}
            </span>
            <select
              className="text-[11px] rounded border border-border bg-background px-2 py-0.5 text-foreground font-mono"
              value={selectedHost}
              onChange={(e) => setSelectedHost(e.target.value)}
            >
              <option value={window.location.hostname}>{window.location.hostname}</option>
              {ipv4Addresses.map((a) => (
                <option key={`${a.name}-${a.address}`} value={a.address}>
                  {a.address} ({a.name})
                </option>
              ))}
            </select>
          </div>
        )}
      </div>
      <div className="divide-y divide-border">
        {rtspError && (
          <div className="px-4 py-4 text-xs text-foreground-subtle italic">
            {t(
              'cameras.streamsTab.rtspRestreamProviderNotAvailable',
              'RTSP restream provider not available — capability may not be loaded yet',
            )}
          </div>
        )}
        {deviceUrls.map((entry) => {
          // brokerId format: `${deviceId}/${profile}` — trailing segment
          // is the CamProfile key, not an arbitrary stream id anymore.
          const profile = entry.brokerId.split('/')[1] ?? entry.brokerId
          const profileLabel =
            profile === 'high'
              ? 'High'
              : profile === 'mid'
                ? 'Mid'
                : profile === 'low'
                  ? 'Low'
                  : profile
          const isEnabled = entry.enabled
          return (
            <div key={entry.brokerId} className="px-4 py-3 space-y-2">
              {/* Header row: profile label + enable toggle + regenerate */}
              <div className="flex items-center gap-3">
                <div className="flex items-center gap-1.5 w-32 flex-shrink-0">
                  <span className="text-xs font-medium text-foreground truncate">
                    {profileLabel}
                  </span>
                </div>
                {/* Enable/disable toggle */}
                <button
                  onClick={() =>
                    enabledMutation.mutate({ brokerId: entry.brokerId, enabled: !isEnabled })
                  }
                  disabled={enabledMutation.isPending}
                  className={`relative inline-flex h-4 w-7 flex-shrink-0 rounded-full transition-colors duration-200 ${
                    isEnabled ? 'bg-success' : 'bg-foreground-subtle/30'
                  } ${enabledMutation.isPending ? 'opacity-50' : 'cursor-pointer'}`}
                  title={
                    isEnabled
                      ? t(
                          'cameras.streamsTab.restreamEnabledClickToDisable',
                          'Restream enabled — click to disable',
                        )
                      : t(
                          'cameras.streamsTab.restreamDisabledClickToEnable',
                          'Restream disabled — click to enable',
                        )
                  }
                >
                  <span
                    className={`inline-block h-3 w-3 transform rounded-full bg-white shadow transition-transform duration-200 mt-0.5 ${
                      isEnabled ? 'translate-x-3.5 ml-[-0.125rem]' : 'translate-x-0.5'
                    }`}
                  />
                </button>
                <div className="flex-1" />
                <button
                  onClick={async () => {
                    const ok = await confirm({
                      title: t('cameras.streamsTab.regenerateRtspToken', 'Regenerate RTSP Token'),
                      message: t(
                        'cameras.streamsTab.regenerateRtspTokenForThe',
                        'Regenerate RTSP token for {{profileLabel}}? The current URL will stop working and a new one will be generated.',
                        { profileLabel },
                      ),
                      confirmLabel: t('cameras.streamsTab.regenerate', 'Regenerate'),
                      variant: 'warning',
                    })
                    if (ok) {
                      regenerateMutation.mutate({ brokerId: entry.brokerId })
                    }
                  }}
                  disabled={regenerateMutation.isPending}
                  className="flex items-center gap-1 text-[10px] font-medium text-foreground-subtle hover:text-foreground border border-border rounded px-1.5 py-0.5 transition-colors disabled:opacity-40"
                  title={t(
                    'cameras.streamsTab.regenerateRtspTokenCurrentUrl',
                    'Regenerate RTSP token (current URL will change)',
                  )}
                >
                  <RefreshCcw
                    className={`h-3 w-3 ${regenerateMutation.isPending ? 'animate-spin' : ''}`}
                  />
                </button>
              </div>
              {/* URLs */}
              {isEnabled && (
                <div className="space-y-1 pl-[4.75rem]">
                  <CopyableUrl label="RTSP" url={entry.url} copiedUrl={copiedUrl} onCopy={onCopy} />
                  <CopyableUrl
                    label={t('cameras.streamsTab.muted', 'Muted')}
                    url={entry.mutedUrl}
                    copiedUrl={copiedUrl}
                    onCopy={onCopy}
                    description={t('cameras.streamsTab.videoOnlyNoAudio', 'Video only — no audio')}
                  />
                </div>
              )}
              {!isEnabled && (
                <p className="text-[10px] text-foreground-subtle italic pl-[4.75rem]">
                  {t(
                    'cameras.streamsTab.restreamDisabledRtspClientsWill',
                    'Restream disabled — RTSP clients will receive 403',
                  )}
                </p>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function CopyableUrl({
  label,
  url,
  copiedUrl,
  onCopy,
  description,
}: {
  readonly label: string
  readonly url: string
  readonly copiedUrl: string | null
  readonly onCopy: (url: string) => void
  readonly description?: string
}) {
  const { t } = useTranslation()
  const isCopied = copiedUrl === url
  return (
    <div className="flex items-center gap-2">
      <span className="text-[10px] font-bold text-foreground-subtle uppercase w-10 flex-shrink-0">
        {label}
      </span>
      <button
        onClick={() => onCopy(url)}
        className="flex-1 min-w-0 flex items-center gap-2 text-[11px] font-mono text-foreground-subtle hover:text-foreground truncate transition-colors"
        title={t('cameras.streamsTab.clickToCopy', 'Click to copy: {{url}}', { url })}
      >
        <span className="truncate">{url}</span>
        {isCopied ? (
          <Check className="h-3 w-3 text-success flex-shrink-0" />
        ) : (
          <Copy className="h-3 w-3 text-foreground-subtle/30 flex-shrink-0" />
        )}
      </button>
      {description && (
        <span className="text-[9px] text-foreground-subtle/60 flex-shrink-0">{description}</span>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Stream Detail (single stream tab content)
// ---------------------------------------------------------------------------

function StreamDetail({
  stream,
  copiedUrl,
  onCopy,
}: {
  stream: AvailableStream
  copiedUrl: string | null
  onCopy: (url: string) => void
}) {
  const { t } = useTranslation()
  // StreamSourceEntry exposes fields directly (not nested under metadata).
  // Live broker stats (bitrate, clients, pre-buffer) are rendered by
  // `<StreamBrokerPanel />` on the Overview tab — no longer duplicated
  // here since broker ids are now profile-keyed and one cam stream may
  // back up to three profile slots.
  const resolution = stream.resolution
    ? `${stream.resolution.width}×${stream.resolution.height}`
    : null
  const codec = stream.codec ? formatCodec(stream.codec) : null
  const fps = stream.fps ? `${Math.round(stream.fps)} fps` : null

  const hasMetadata = resolution || codec || fps

  return (
    <div className="p-4 space-y-4">
      {/* Metadata (from probe / provider) */}
      {hasMetadata ? (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {resolution && (
            <MetaCell label={t('cameras.streamsTab.resolution', 'Resolution')} value={resolution} />
          )}
          {codec && <MetaCell label={t('cameras.streamsTab.codec', 'Codec')} value={codec} />}
          {fps && <MetaCell label={t('cameras.streamsTab.frameRate', 'Frame Rate')} value={fps} />}
        </div>
      ) : (
        <div className="rounded-md bg-surface-hover/50 px-4 py-3 text-xs text-foreground-subtle italic">
          {t(
            'cameras.streamsTab.noMetadataAvailableClickRe',
            'No metadata available — click Re-probe to detect stream properties',
          )}
        </div>
      )}

      {/* Stream URL — StreamSourceEntry has a single url, not a protocols array */}
      {stream.url && (
        <div className="space-y-2">
          <h3 className="text-[10px] font-semibold text-foreground-subtle uppercase tracking-wider">
            {t('cameras.streamsTab.sourceUrl', 'Source URL')}
          </h3>
          <div className="space-y-1.5">
            <ProtocolRow
              protocol={stream.kind}
              url={stream.url}
              copiedUrl={copiedUrl}
              onCopy={onCopy}
            />
          </div>
        </div>
      )}
    </div>
  )
}

function MetaCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md bg-surface-hover/50 px-3 py-2">
      <span className="text-[10px] text-foreground-subtle uppercase tracking-wider">{label}</span>
      <p className="text-sm font-semibold text-foreground mt-0.5">{value}</p>
    </div>
  )
}

function ProtocolRow({
  protocol,
  url,
  copiedUrl,
  onCopy,
}: {
  protocol: string
  url: string
  copiedUrl: string | null
  onCopy: (url: string) => void
}) {
  const { t } = useTranslation()
  const isCopied = copiedUrl === url

  return (
    <button
      onClick={() => onCopy(url)}
      className="w-full flex items-center gap-2 text-xs font-mono bg-surface-hover hover:bg-border/50 rounded px-3 py-2 text-left transition-colors group"
      title={t('cameras.streamsTab.clickToCopy', 'Click to copy: {{url}}', { url })}
    >
      <span className="font-bold text-foreground flex-shrink-0">{protocol}</span>
      <span className="text-foreground-subtle truncate flex-1 min-w-0">{url}</span>
      {isCopied ? (
        <Check className="h-3.5 w-3.5 text-success flex-shrink-0" />
      ) : (
        <Copy className="h-3.5 w-3.5 text-foreground-subtle/30 group-hover:text-foreground-subtle flex-shrink-0 transition-colors" />
      )}
    </button>
  )
}
