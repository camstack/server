import type {
  DerivedEffectiveEncodeStats,
  DerivedEncodePreview,
  EncodeProfile,
} from '@dominevo/types'
import { Badge, Button } from '@dominevo/ui-library'
import { ChevronDown, ChevronRight } from 'lucide-react'
import * as React from 'react'
import { useState } from 'react'
import { useT } from '../../i18n/index.js'

/**
 * What the "Final result" panel knows about the profile being edited. The
 * server computes it (`previewDerivedEncode`), so the panel shows what the
 * encoder will really do — never a client-side guess. `pending` and
 * `unavailable` are distinct from `no-source`: a query that has not answered,
 * or failed, is never shown as "nothing to compute".
 */
export type ResultView =
  | { readonly kind: 'pending' }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'no-source' }
  | { readonly kind: 'ready'; readonly preview: DerivedEncodePreview }

/** The running encode of this stream, for the running / idle badge. */
export type RunningView =
  | { readonly kind: 'pending' }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'idle' }
  | { readonly kind: 'running'; readonly encode: DerivedEffectiveEncodeStats }

/** True when the running encode is not the one the current profile will produce. */
export function runningDiffers(
  preview: DerivedEncodePreview,
  running: DerivedEffectiveEncodeStats,
): boolean {
  return (
    running.encoder !== preview.encoder ||
    running.fps !== preview.fps ||
    running.gopFrames !== preview.gopFrames ||
    running.targetKbps !== preview.targetKbps ||
    running.capKbps !== preview.capKbps ||
    running.audio !== preview.audio
  )
}

const sectionCardCls = 'rounded-lg border border-border bg-surface overflow-hidden'
const sectionHeaderCls =
  'border-b border-border px-3 py-1.5 flex items-center justify-between gap-2 bg-surface-hover/30'
const sectionTitleCls = 'text-[11px] font-semibold text-foreground uppercase tracking-wider'
const labelRowCls = 'flex items-center justify-between gap-3 py-1.5'
const labelTextCls = 'text-[11px] uppercase tracking-wider text-foreground-subtle font-medium'
const noteCls =
  'rounded-md border border-warning/30 bg-warning/10 px-2 py-1 text-[11px] text-warning'

interface EncodeResultPanelProps {
  readonly profile: EncodeProfile | undefined
  readonly result: ResultView
  /** Absent for a stream with no broker of its own: no badge. */
  readonly running?: RunningView
}

export function EncodeResultPanel({
  profile,
  result,
  running,
}: EncodeResultPanelProps): React.ReactElement {
  const { t } = useT()
  return (
    <div className={sectionCardCls + ' @container'} data-testid="encode-result">
      <div className={sectionHeaderCls}>
        <h3 className={sectionTitleCls}>{t('ffmpeg.resultTitle')}</h3>
        <RunningBadge running={running} />
      </div>
      <div className="px-3 py-2">
        {result.kind === 'pending' && (
          <p className="text-[11px] text-foreground-subtle italic">{t('ffmpeg.resultLoading')}</p>
        )}
        {result.kind === 'unavailable' && (
          <p className="text-[11px] text-foreground-subtle italic">
            {t('ffmpeg.resultUnavailable')}
          </p>
        )}
        {result.kind === 'no-source' && (
          <p className="text-[11px] text-foreground-subtle italic">{t('ffmpeg.resultNoSource')}</p>
        )}
        {result.kind === 'ready' && (
          <ResultBody profile={profile} preview={result.preview} running={running} />
        )}
      </div>
    </div>
  )
}

function RunningBadge({
  running,
}: {
  readonly running: RunningView | undefined
}): React.ReactElement | null {
  const { t } = useT()
  if (running === undefined || running.kind === 'pending' || running.kind === 'unavailable') {
    return null
  }
  return running.kind === 'running' ? (
    <Badge variant="success">{t('ffmpeg.resultRunning')}</Badge>
  ) : (
    <Badge variant="default">{t('ffmpeg.resultNotRunning')}</Badge>
  )
}

interface ResultBodyProps {
  readonly profile: EncodeProfile | undefined
  readonly preview: DerivedEncodePreview
  readonly running: RunningView | undefined
}

function ResultBody({ profile, preview, running }: ResultBodyProps): React.ReactElement {
  const { t } = useT()
  const [argsOpen, setArgsOpen] = useState(false)

  const size =
    preview.width !== null && preview.height !== null
      ? `${preview.width}×${preview.height}`
      : t('ffmpeg.resultSizeUnknown')
  const codec =
    preview.videoCodec === 'copy'
      ? t('ffmpeg.resultCodecCopy')
      : t('ffmpeg.resultCodecValue', {
          codec: preview.videoCodec.toUpperCase(),
          encoder: preview.encoder ?? t('ffmpeg.resultEncoderUnknown'),
        })
  const fps =
    preview.fps === null
      ? t('ffmpeg.resultFpsSource')
      : t('ffmpeg.resultFpsValue', { fps: preview.fps })
  const kbps = (n: number | null): string =>
    n === null ? t('ffmpeg.resultBitrateUnknown') : t('ffmpeg.resultKbps', { kbps: n })
  const bitrate =
    preview.targetKbps === null && preview.capKbps === null
      ? t('ffmpeg.resultBitrateUnknown')
      : t('ffmpeg.resultBitrateValue', {
          target: kbps(preview.targetKbps),
          cap: kbps(preview.capKbps),
        })
  const keyframe =
    preview.keyframeIntervalSec === null
      ? t('ffmpeg.resultKeyframeUnknown')
      : t('ffmpeg.resultKeyframeValue', { sec: preview.keyframeIntervalSec })
  const audioProfile = profile?.audio
  const audio =
    preview.audio === 'copy'
      ? t('ffmpeg.resultAudioCopy')
      : preview.audio === 'aac'
        ? t('ffmpeg.resultAudioAac')
        : preview.audio === 'none'
          ? t('ffmpeg.resultAudioNone')
          : t('ffmpeg.resultAudioProfile', {
              codec:
                audioProfile !== undefined && audioProfile !== 'passthrough'
                  ? audioProfile.codec.toUpperCase()
                  : '',
            })

  const rows: ReadonlyArray<readonly [string, string]> = [
    [t('ffmpeg.resultSize'), size],
    [t('ffmpeg.resultCodec'), codec],
    [t('ffmpeg.resultFps'), fps],
    [t('ffmpeg.resultBitrate'), bitrate],
    [t('ffmpeg.resultKeyframe'), keyframe],
    [t('ffmpeg.resultAudio'), audio],
  ]

  const differs =
    running?.kind === 'running' && runningDiffers(preview, running.encode) ? running.encode : null

  return (
    <div className="space-y-2">
      <dl className="grid grid-cols-1 gap-x-6 divide-y divide-border/30 @[480px]:grid-cols-2 @[480px]:divide-y-0">
        {rows.map(([label, text]) => (
          <div key={label} className={labelRowCls}>
            <dt className={labelTextCls}>{label}</dt>
            <dd className="text-right text-xs text-foreground">{text}</dd>
          </div>
        ))}
      </dl>
      {preview.fpsClampedToSource && preview.requestedFps !== null && preview.fps !== null && (
        <p className={noteCls}>
          {t('ffmpeg.resultFpsCapped', { asked: preview.requestedFps, fps: preview.fps })}
        </p>
      )}
      {preview.raisedToFloor && preview.requestedKbps !== null && preview.floorKbps !== null && (
        <p className={noteCls}>
          {t('ffmpeg.resultBitrateRaised', {
            asked: preview.requestedKbps,
            floor: preview.floorKbps,
          })}
        </p>
      )}
      {differs !== null && (
        <p className="text-[11px] text-foreground-subtle">
          {t('ffmpeg.resultDiffers', {
            summary: [
              differs.encoder ?? t('ffmpeg.resultEncoderUnknown'),
              differs.fps === null
                ? t('ffmpeg.resultFpsSource')
                : t('ffmpeg.resultFpsValue', { fps: differs.fps }),
              kbps(differs.targetKbps),
            ].join(' · '),
          })}
        </p>
      )}
      <div>
        <Button
          variant="unstyled"
          type="button"
          aria-expanded={argsOpen}
          onClick={() => setArgsOpen((open) => !open)}
          className="inline-flex items-center gap-1 text-[11px] text-foreground-subtle hover:text-foreground"
        >
          {argsOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          {t('ffmpeg.resultArgs')}
        </Button>
        {argsOpen && (
          <pre
            data-testid="encode-result-args"
            className="mt-1 whitespace-pre-wrap break-all rounded border border-border bg-background px-2 py-1.5 font-mono text-[11px] text-foreground"
          >
            {preview.args.join(' ')}
          </pre>
        )}
      </div>
    </div>
  )
}
