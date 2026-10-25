/**
 * The selected clip — what it is, how it plays, and how it is saved.
 *
 * **No second player.** `getClipPlayback` answers `{ playbackUrl, format,
 * served }` and the panel hands it to the SAME hero the recordings timeline
 * drives: `vod.play({ url, format })` → `StreamPanel playbackUrl/playbackFormat`
 * → `HlsVideo`'s `mp4` branch (`video.src`, no hls.js). Building a clip player
 * here is the thing D549 decision 22 exists to refuse.
 *
 * **`format` travels.** An MP4 handed to hls.js is parsed as a manifest and
 * fails, so the format the provider named is forwarded verbatim and never
 * defaulted here.
 *
 * **`served` is shown.** A clip that holds only one twin answers with the one
 * it has, and the surface SAYS so — a missing main twin must never be served
 * silently as if it were the asked-for quality (D549 decision 15). Both ids
 * are already on the row, so changing quality re-asks the hub and never
 * re-searches the camera.
 *
 * **Nothing is appended to the URL.** The route is `access:'authenticated'`
 * and the session cookie authenticates it (D549 decision 22); the same URL is
 * the download.
 */
import { useEffect, type JSX } from 'react'
import { Download } from 'lucide-react'
import type { CamProfile, Clip } from '@camstack/types'
import { useVideoclipsGetClipPlayback } from '../../generated/system-hooks.js'
import { UiTrans, useUiText } from '../../contexts/ui-text.js'
import { useVodPlayback } from '../../contexts/vod-playback.js'
import { hubPath } from '../../lib/hub-mount.js'
import { Button } from '../../primitives/button.js'
import { Card } from '../../primitives/card.js'
import { Skeleton } from '../../primitives/skeleton.js'
import { ErrorBox } from '../error-box.js'

const PROFILES: readonly CamProfile[] = ['low', 'mid', 'high']

export interface ClipPanelProps {
  readonly deviceId: number
  readonly clip: Clip
  readonly profile: CamProfile
  readonly onProfileChange: (profile: CamProfile) => void
}

export function ClipPanel({
  deviceId,
  clip,
  profile,
  onProfileChange,
}: ClipPanelProps): JSX.Element {
  const t = useUiText()
  const vod = useVodPlayback()
  const playback = useVideoclipsGetClipPlayback({ deviceId, clipId: clip.id, profile })
  const data = playback.data
  const label = `${new Date(clip.timeRange.startMs).toLocaleString()} · ${clip.source}`

  useEffect(() => {
    if (data === undefined) return
    vod.play({
      url: hubPath(data.playbackUrl),
      ...(data.format === undefined ? {} : { format: data.format }),
      label,
    })
    // `vod` is deliberately not a dependency: its identity changes on every
    // request it holds, so keying the effect on it would re-play the clip
    // forever. The effect fires on the ANSWER changing, which is the event.
  }, [data, label])

  return (
    <Card className="space-y-2 text-sm">
      <div className="font-medium text-foreground">{label}</div>
      <div className="flex items-center gap-1">
        <span className="mr-1 text-[10px] uppercase tracking-wide text-foreground-subtle">
          {t('uiLibrary.clipPanel.quality', 'Quality')}
        </span>
        {PROFILES.map((option) => (
          <Button
            key={option}
            variant={option === profile ? 'primary' : 'secondary'}
            aria-pressed={option === profile}
            onClick={() => onProfileChange(option)}
          >
            {option}
          </Button>
        ))}
      </div>
      {playback.status === 'pending' ? (
        <div className="space-y-1">
          <div role="status" className="text-xs text-foreground-subtle">
            {t(
              'uiLibrary.clipPanel.preparing',
              'Preparing the clip — the file is fetched and muxed once…',
            )}
          </div>
          <Skeleton className="h-4 w-48" />
        </div>
      ) : playback.status === 'error' ? (
        <ErrorBox
          title={t('uiLibrary.clipPanel.prepareFailed', 'This clip could not be prepared')}
          message={
            playback.error?.message ?? t('uiLibrary.clipPanel.noReasonGiven', 'no reason given')
          }
        />
      ) : data === undefined ? null : (
        <div className="space-y-2">
          {data.served === undefined || data.served === profile ? null : (
            <ErrorBox
              variant="warning"
              message={
                <UiTrans
                  uiKey="uiLibrary.clipPanel.servedFallback"
                  fallback="Served the <0>{{served}}</0> stream — this clip has no {{profile}} twin."
                  components={[<strong key="served" />]}
                  values={{ served: data.served, profile }}
                />
              }
            />
          )}
          <a
            href={hubPath(data.playbackUrl)}
            download
            className="inline-flex items-center gap-1.5 text-xs font-medium text-primary hover:underline"
          >
            <Download className="h-3.5 w-3.5" aria-hidden="true" />
            {t('uiLibrary.clipPanel.download', 'Download this clip')}
          </a>
        </div>
      )}
    </Card>
  )
}
