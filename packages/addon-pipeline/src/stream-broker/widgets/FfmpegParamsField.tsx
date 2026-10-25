import type { EncodeProfile } from '@camstack/types'
import type { WidgetProps } from '@camstack/ui-library'
import { useDeviceManagerUpdateDeviceField } from '@camstack/ui-library'
import { AlertCircle, Check, ChevronDown, ChevronRight, Loader2, Plus } from 'lucide-react'
import * as React from 'react'
import { useCallback, useMemo, useRef, useState } from 'react'
import { useT } from '../../i18n/index.js'
import { GeometryBuilder } from './GeometryBuilder.js'

/**
 * Curated catalogue of commonly-used ffmpeg flag groups, surfaced as
 * an "Add flag…" picker on top of the inputArgs / outputArgs textareas.
 *
 * Adding a flag from the picker appends it (with default value placeholder)
 * to the textarea — the operator can then tweak the value or remove the
 * line. The catalogue is intentionally short and curated — the spec calls
 * for "most-used" flags, not every ffmpeg option ever.
 */
type MessageKey = Parameters<ReturnType<typeof useT>['t']>[0]

interface FlagSuggestion {
  /** Bundle key of the group heading. */
  readonly group: MessageKey
  /** The flag as ffmpeg spells it — never translated. */
  readonly label: string
  readonly args: readonly string[] // tokens to append, one line per pair
  /** Bundle key of the human description, looked up at render time. */
  readonly descriptionKey?: MessageKey
}

const INPUT_FLAG_CATALOGUE: readonly FlagSuggestion[] = [
  {
    group: 'flagGroups.demuxer',
    label: '-thread_queue_size 1024',
    args: ['-thread_queue_size', '1024'],
    descriptionKey: 'flags.threadQueueSize1024',
  },
  {
    group: 'flagGroups.demuxer',
    label: '-fflags +genpts',
    args: ['-fflags', '+genpts'],
    descriptionKey: 'flags.fflagsGenpts',
  },
  {
    group: 'flagGroups.demuxer',
    label: '-re',
    args: ['-re'],
    descriptionKey: 'flags.re',
  },
  {
    group: 'flagGroups.demuxer',
    label: '-probesize 32',
    args: ['-probesize', '32'],
    descriptionKey: 'flags.probesize32',
  },
  {
    group: 'flagGroups.demuxer',
    label: '-analyzeduration 0',
    args: ['-analyzeduration', '0'],
    descriptionKey: 'flags.analyzeduration0',
  },
  {
    group: 'flagGroups.rtsp',
    label: '-rtsp_transport tcp',
    args: ['-rtsp_transport', 'tcp'],
    descriptionKey: 'flags.rtspTransportTcp',
  },
  {
    group: 'flagGroups.rtsp',
    label: '-stimeout 5000000',
    args: ['-stimeout', '5000000'],
    descriptionKey: 'flags.stimeout5000000',
  },
  {
    group: 'flagGroups.timestamps',
    label: '-use_wallclock_as_timestamps 1',
    args: ['-use_wallclock_as_timestamps', '1'],
    descriptionKey: 'flags.useWallclockAsTimestamps1',
  },
  {
    group: 'flagGroups.timestamps',
    label: '-fflags +genpts+igndts',
    args: ['-fflags', '+genpts+igndts'],
    descriptionKey: 'flags.fflagsGenptsIgndts',
  },
]

const OUTPUT_FLAG_CATALOGUE: readonly FlagSuggestion[] = [
  {
    group: 'flagGroups.muxer',
    label: '-flush_packets 1',
    args: ['-flush_packets', '1'],
    descriptionKey: 'flags.flushPackets1',
  },
  {
    group: 'flagGroups.muxer',
    label: '-movflags +faststart',
    args: ['-movflags', '+faststart'],
    descriptionKey: 'flags.movflagsFaststart',
  },
  {
    group: 'flagGroups.bitstream',
    label: '-bsf:v h264_mp4toannexb',
    args: ['-bsf:v', 'h264_mp4toannexb'],
    descriptionKey: 'flags.bsfVH264Mp4toannexb',
  },
  {
    group: 'flagGroups.bitstream',
    label: '-bsf:v hevc_mp4toannexb',
    args: ['-bsf:v', 'hevc_mp4toannexb'],
    descriptionKey: 'flags.bsfVHevcMp4toannexb',
  },
  {
    group: 'flagGroups.x264',
    label: '-x264-params keyint_min=15',
    args: ['-x264-params', 'keyint_min=15'],
    descriptionKey: 'flags.x264ParamsKeyintMin15',
  },
  {
    group: 'flagGroups.x264',
    label: '-x264-params scenecut=0',
    args: ['-x264-params', 'scenecut=0'],
    descriptionKey: 'flags.x264ParamsScenecut0',
  },
  {
    group: 'flagGroups.x264',
    label: '-x264-params nal-hrd=cbr',
    args: ['-x264-params', 'nal-hrd=cbr'],
    descriptionKey: 'flags.x264ParamsNalHrdCbr',
  },
  {
    group: 'flagGroups.x264',
    label: '-aq-mode 3',
    args: ['-aq-mode', '3'],
    descriptionKey: 'flags.aqMode3',
  },
  {
    group: 'flagGroups.x265',
    label: '-x265-params keyint=30',
    args: ['-x265-params', 'keyint=30'],
    descriptionKey: 'flags.x265ParamsKeyint30',
  },
  {
    group: 'flagGroups.x265',
    label: '-x265-params no-scenecut=1',
    args: ['-x265-params', 'no-scenecut=1'],
    descriptionKey: 'flags.x265ParamsNoScenecut1',
  },
  {
    group: 'flagGroups.global',
    label: '-fps_mode passthrough',
    args: ['-fps_mode', 'passthrough'],
    descriptionKey: 'flags.fpsModePassthrough',
  },
  {
    group: 'flagGroups.global',
    label: '-copyts',
    args: ['-copyts'],
    descriptionKey: 'flags.copyts',
  },
  {
    group: 'flagGroups.timestamps',
    label: '-avoid_negative_ts make_zero',
    args: ['-avoid_negative_ts', 'make_zero'],
    descriptionKey: 'flags.avoidNegativeTsMakeZero',
  },
  {
    group: 'flagGroups.audio',
    label: '-af aresample=async=1',
    args: ['-af', 'aresample=async=1'],
    descriptionKey: 'flags.afAresampleAsync1',
  },
  {
    group: 'flagGroups.muxer',
    label: '-muxdelay 0',
    args: ['-muxdelay', '0'],
    descriptionKey: 'flags.muxdelay0',
  },
]

export interface FfmpegParamsWidgetConfig {
  /** Patch key written through `deviceManager.updateDeviceField`. */
  fieldKey: string
  label?: string
  /**
   * "Args-only" mode. When true the widget renders ONLY the input/output
   * ffmpeg-args sections (the two textareas + their "Add flag…" pickers);
   * the video-codec / geometry / audio transcode controls are hidden
   * entirely. Used by the source-stream normalization UI, where the saved
   * `EncodeProfile` just carries `inputArgs`/`outputArgs` over a
   * copy/passthrough base (no re-encode). Default false = full transform
   * editor (derived streams).
   */
  argsOnly?: boolean
  /**
   * Read-only "Source (probed)" snapshot — codec / resolution / fps /
   * bitrate (and audio shape) the publisher actually advertised when it
   * registered the camStream. Rendered as a chips card at the top of the
   * widget so the operator sees the REAL per-stream numbers next to the
   * (separate) override editor. Each consumer (broker source-stream,
   * broker derived, HAP, Alexa) populates it from its own source-side
   * data — the widget never invents probed values.
   */
  sourceParams?: EncodeProfile
  /** Initial value sent by the contribution builder — read once on
   *  mount. The widget tracks its own state from then on. */
  initialValue?: EncodeProfile
  /** Routing for `deviceManager.updateDeviceField`. Required when the
   *  widget is mounted via the form-builder (WidgetProps wrapper). */
  writerCapName?: string
  writerAddonId?: string
}

/**
 * Autosave lifecycle surfaced to the operator. The widget persists every
 * edit immediately (there is no explicit Save button) — this drives the
 * inline "Saving… / Saved / Save failed" indicator so a change is never
 * silently in-flight or silently dropped.
 */
export type FfmpegSaveStatus = 'idle' | 'saving' | 'saved' | 'error'

export interface FfmpegParamsCoreProps {
  readonly config: FfmpegParamsWidgetConfig
  readonly value: EncodeProfile | undefined
  readonly onSave: (next: EncodeProfile | undefined) => void
  /** Live autosave status for the header indicator. Omit in tests. */
  readonly saveStatus?: FfmpegSaveStatus
}

/**
 * Fallback profile when nothing has been persisted yet — a plain
 * copy/passthrough transform (no re-encode). Module-level singleton so
 * the edited `profile` keeps a stable identity across renders while
 * `value` is undefined (otherwise the textarea-resync guard would loop).
 */
const PASSTHROUGH_DEFAULT: EncodeProfile = { video: { codec: 'copy' }, audio: 'passthrough' }

// ── Tailwind primitives matching StreamBrokerPanel conventions ──────────
const inputCls =
  'rounded border border-border bg-surface-2 px-2 py-1 text-xs text-foreground ' +
  'focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-50 disabled:cursor-not-allowed ' +
  'read-only:opacity-60 read-only:cursor-not-allowed'

const selectCls = inputCls + ' appearance-none pr-6'

const textareaCls =
  'w-full rounded border border-border bg-surface-2 px-2 py-1.5 text-[11px] font-mono text-foreground ' +
  'focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-50 read-only:opacity-60 ' +
  'min-h-[60px] resize-y'

const labelRowCls = 'flex items-center justify-between gap-3 py-1.5'
const labelTextCls = 'text-[11px] uppercase tracking-wider text-foreground-subtle font-medium'
const sectionCardCls = 'rounded-lg border border-border bg-surface overflow-hidden'
const sectionHeaderCls =
  'border-b border-border px-3 py-1.5 flex items-center justify-between bg-surface-hover/30'
const sectionTitleCls = 'text-[11px] font-semibold text-foreground uppercase tracking-wider'

/**
 * Pure presentational component. Receives `value` + `onSave` directly
 * from its parent — used by the WidgetProps wrapper below AND by the
 * unit tests (so we don't need to stub a tRPC client).
 *
 * This is the derived-stream transform editor: an always-editable codec
 * + video / audio + raw ffmpeg-args form. There is no preset layer — the
 * operator authors the transform fields directly.
 */
export function FfmpegParamsCore({
  config,
  value,
  onSave,
  saveStatus,
}: FfmpegParamsCoreProps): React.ReactElement {
  const { t } = useT()
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const argsOnly = config.argsOnly === true

  const profile: EncodeProfile = value ?? PASSTHROUGH_DEFAULT

  // Local textarea state synced from the persisted profile — lets us
  // append flags from the picker without going through onBlur cycles.
  const [inputArgsText, setInputArgsText] = useState<string>(() =>
    (profile.inputArgs ?? []).join('\n'),
  )
  const [outputArgsText, setOutputArgsText] = useState<string>(() =>
    (profile.outputArgs ?? []).join('\n'),
  )
  const lastProfileRef = useRef(profile)
  // Resync local textarea state when the persisted profile changes.
  // Doesn't fire when the user edits the textarea — only when the
  // upstream profile object identity changes.
  if (lastProfileRef.current !== profile) {
    lastProfileRef.current = profile
    setInputArgsText((profile.inputArgs ?? []).join('\n'))
    setOutputArgsText((profile.outputArgs ?? []).join('\n'))
  }

  const updateProfile = (mutator: (p: EncodeProfile) => EncodeProfile): void => {
    onSave(mutator(profile))
  }

  const setVideoCodec = (codec: EncodeProfile['video']['codec']): void =>
    updateProfile((p) => ({ ...p, video: { ...p.video, codec } }))
  // Numeric setters skip an empty / non-positive field: `Number('')` is 0,
  // which fails the backend's `positive()` schema and would reject the WHOLE
  // save (leaving the widget looking "stuck"). A blank keystroke is a no-op;
  // only a valid positive value is persisted.
  const setVideoWidth = (width: number): void => {
    if (!Number.isFinite(width) || width <= 0) return
    updateProfile((p) => ({ ...p, video: { ...p.video, width } }))
  }
  const setVideoHeight = (height: number): void => {
    if (!Number.isFinite(height) || height <= 0) return
    updateProfile((p) => ({ ...p, video: { ...p.video, height } }))
  }
  const setVideoFps = (fps: number): void => {
    if (!Number.isFinite(fps) || fps <= 0) return
    updateProfile((p) => ({ ...p, video: { ...p.video, fps } }))
  }
  const setVideoBitrate = (bitrateKbps: number): void => {
    if (!Number.isFinite(bitrateKbps) || bitrateKbps <= 0) return
    updateProfile((p) => ({ ...p, video: { ...p.video, bitrateKbps } }))
  }
  const setAudioPassthrough = (): void =>
    updateProfile((p) => ({ ...p, audio: 'passthrough' as const }))
  const setAudioCodec = (codec: 'opus' | 'aac' | 'pcmu' | 'pcma' | 'copy'): void =>
    updateProfile((p) => ({
      ...p,
      audio: typeof p.audio === 'object' ? { ...p.audio, codec } : { codec },
    }))
  const setAudioBitrate = (bitrateKbps: number): void => {
    if (!Number.isFinite(bitrateKbps) || bitrateKbps <= 0) return
    updateProfile((p) => ({
      ...p,
      audio:
        typeof p.audio === 'object' ? { ...p.audio, bitrateKbps } : { codec: 'opus', bitrateKbps },
    }))
  }
  const setInputArgs = (lines: string): void =>
    updateProfile((p) => ({
      ...p,
      inputArgs: lines
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0),
    }))
  const setOutputArgs = (lines: string): void =>
    updateProfile((p) => ({
      ...p,
      outputArgs: lines
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0),
    }))

  // Picker: append a flag suggestion to either textarea and save immediately.
  const appendFlag = (which: 'input' | 'output', suggestion: FlagSuggestion): void => {
    const line = suggestion.args.join(' ')
    if (which === 'input') {
      const next = inputArgsText.length === 0 ? line : `${inputArgsText}\n${line}`
      setInputArgsText(next)
      setInputArgs(next)
    } else {
      const next = outputArgsText.length === 0 ? line : `${outputArgsText}\n${line}`
      setOutputArgsText(next)
      setOutputArgs(next)
    }
  }

  // ── Input / Output arg editors (textarea + "Add flag…" picker) ────────
  // Extracted so both the full editor's Advanced section and the
  // args-only mode render the SAME markup (DRY).
  const inputArgsBlock = (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <label htmlFor={`${config.fieldKey}-input-args`} className={labelTextCls}>
          {t('ffmpeg.inputArgs')}
          <span className="ml-2 text-[10px] normal-case text-foreground-subtle italic">
            {t('ffmpeg.inputArgsHint')}
          </span>
        </label>
        <FlagPicker
          id={`${config.fieldKey}-input-picker`}
          disabled={false}
          catalogue={INPUT_FLAG_CATALOGUE}
          onPick={(suggestion) => appendFlag('input', suggestion)}
        />
      </div>
      <textarea
        id={`${config.fieldKey}-input-args`}
        value={inputArgsText}
        onChange={(e) => setInputArgsText(e.target.value)}
        onBlur={(e) => setInputArgs(e.target.value)}
        placeholder="-thread_queue_size 1024"
        className={textareaCls}
      />
    </div>
  )
  const outputArgsBlock = (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <label htmlFor={`${config.fieldKey}-output-args`} className={labelTextCls}>
          {t('ffmpeg.outputArgs')}
          <span className="ml-2 text-[10px] normal-case text-foreground-subtle italic">
            {t('ffmpeg.outputArgsHint')}
          </span>
        </label>
        <FlagPicker
          id={`${config.fieldKey}-output-picker`}
          disabled={false}
          catalogue={OUTPUT_FLAG_CATALOGUE}
          onPick={(suggestion) => appendFlag('output', suggestion)}
        />
      </div>
      <textarea
        id={`${config.fieldKey}-output-args`}
        value={outputArgsText}
        onChange={(e) => setOutputArgsText(e.target.value)}
        onBlur={(e) => setOutputArgs(e.target.value)}
        placeholder="-bsf:v h264_mp4toannexb"
        className={textareaCls}
      />
    </div>
  )

  return (
    <div className="space-y-3">
      {/* ── Autosave indicator ──────────────────────────────────────────── */}
      {/*    These params have NO explicit Save button — every edit is       */}
      {/*    persisted immediately. This row tells the operator the change   */}
      {/*    landed (or is in flight / failed) so a silent autosave never    */}
      {/*    looks like "nothing happened".                                  */}
      {saveStatus !== undefined && (
        <div className="flex items-center justify-end">
          <SaveStatusBadge status={saveStatus} />
        </div>
      )}

      {/* ── Source (probed) — read-only snapshot of what the camStream  */}
      {/*    publisher advertised. Populated by each consumer from its   */}
      {/*    own probe data; absent when nothing is known yet.           */}
      {config.sourceParams !== undefined && (
        <div className={sectionCardCls}>
          <div className={sectionHeaderCls}>
            <h3 className={sectionTitleCls}>{t('ffmpeg.sourceProbed')}</h3>
            <span className="text-[10px] text-foreground-subtle italic">
              {t('ffmpeg.fromPublisher')}
            </span>
          </div>
          <div className="px-3 py-2 flex flex-wrap gap-1.5">
            <SourceParamsChips profile={config.sourceParams} />
          </div>
        </div>
      )}

      {/* ── Video + Audio: 2 columns when the widget is wide, stacked when */}
      {/*    narrow. Container-query threshold (@[480px]) matches the form's */}
      {/*    section grid — NOT a viewport breakpoint — so the panels track  */}
      {/*    the widget's own available width like every sibling composition. */}
      {/*    Hidden entirely in args-only mode (source normalization): there */}
      {/*    is no transcode, so the codec/geometry/audio controls don't apply. */}
      {!argsOnly && (
        <div className="@container">
          <div className="grid grid-cols-1 @[480px]:grid-cols-2 gap-3">
            {/* ── Video panel ─────────────────────────────────────────────────── */}
            <div className={sectionCardCls}>
              <div className={sectionHeaderCls}>
                <h3 className={sectionTitleCls}>{t('ffmpeg.video')}</h3>
              </div>
              <div className="px-3 py-2 divide-y divide-border/30">
                <div className={labelRowCls}>
                  <label htmlFor={`${config.fieldKey}-video-codec`} className={labelTextCls}>
                    {t('ffmpeg.codec')}
                  </label>
                  <select
                    id={`${config.fieldKey}-video-codec`}
                    value={profile.video.codec}
                    onChange={(e) =>
                      setVideoCodec(e.target.value as EncodeProfile['video']['codec'])
                    }
                    className={selectCls + ' min-w-[120px]'}
                  >
                    <option value="h264">h264</option>
                    <option value="h265">h265</option>
                    <option value="copy">{t('ffmpeg.copyPassthrough')}</option>
                  </select>
                </div>
                {profile.video.codec !== 'copy' && (
                  <>
                    <div className={labelRowCls}>
                      <label htmlFor={`${config.fieldKey}-video-width`} className={labelTextCls}>
                        {t('ffmpeg.width')}
                      </label>
                      <input
                        id={`${config.fieldKey}-video-width`}
                        type="number"
                        aria-label={t('ffmpeg.width')}
                        value={profile.video.width ?? ''}
                        onChange={(e) => setVideoWidth(Number(e.target.value))}
                        className={inputCls + ' w-24 text-right'}
                      />
                    </div>
                    <div className={labelRowCls}>
                      <label htmlFor={`${config.fieldKey}-video-height`} className={labelTextCls}>
                        {t('ffmpeg.height')}
                      </label>
                      <input
                        id={`${config.fieldKey}-video-height`}
                        type="number"
                        value={profile.video.height ?? ''}
                        onChange={(e) => setVideoHeight(Number(e.target.value))}
                        className={inputCls + ' w-24 text-right'}
                      />
                    </div>
                    <div className={labelRowCls}>
                      <label htmlFor={`${config.fieldKey}-video-fps`} className={labelTextCls}>
                        {t('ffmpeg.fps')}
                      </label>
                      <input
                        id={`${config.fieldKey}-video-fps`}
                        type="number"
                        value={profile.video.fps ?? ''}
                        onChange={(e) => setVideoFps(Number(e.target.value))}
                        className={inputCls + ' w-24 text-right'}
                      />
                    </div>
                    <div className={labelRowCls}>
                      <label htmlFor={`${config.fieldKey}-video-bitrate`} className={labelTextCls}>
                        {t('ffmpeg.bitrateKbps')}
                      </label>
                      <input
                        id={`${config.fieldKey}-video-bitrate`}
                        type="number"
                        value={profile.video.bitrateKbps ?? ''}
                        onChange={(e) => setVideoBitrate(Number(e.target.value))}
                        className={inputCls + ' w-24 text-right'}
                      />
                    </div>
                  </>
                )}
              </div>
            </div>

            {/* ── Audio panel ─────────────────────────────────────────────────── */}
            <div className={sectionCardCls}>
              <div className={sectionHeaderCls}>
                <h3 className={sectionTitleCls}>{t('ffmpeg.audio')}</h3>
              </div>
              <div className="px-3 py-2">
                {profile.audio === 'passthrough' ? (
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-[11px] text-foreground-subtle italic">
                      {t('ffmpeg.audioPassthroughNote')}
                    </span>
                    <button
                      type="button"
                      onClick={() => setAudioCodec('opus')}
                      className="rounded-md border border-border bg-surface-hover px-2 py-1 text-[11px] text-foreground hover:bg-surface-hover/70 transition-colors"
                    >
                      {t('ffmpeg.switchToCustom')}
                    </button>
                  </div>
                ) : (
                  <div className="divide-y divide-border/30">
                    <div className={labelRowCls}>
                      <label htmlFor={`${config.fieldKey}-audio-codec`} className={labelTextCls}>
                        {t('ffmpeg.codec')}
                      </label>
                      <select
                        id={`${config.fieldKey}-audio-codec`}
                        value={profile.audio.codec}
                        onChange={(e) =>
                          setAudioCodec(e.target.value as 'opus' | 'aac' | 'pcmu' | 'pcma' | 'copy')
                        }
                        className={selectCls + ' min-w-[120px]'}
                      >
                        <option value="opus">opus</option>
                        <option value="aac">aac</option>
                        <option value="pcmu">pcmu</option>
                        <option value="pcma">pcma</option>
                        <option value="copy">{t('ffmpeg.copyPassthrough')}</option>
                      </select>
                    </div>
                    <div className={labelRowCls}>
                      <label htmlFor={`${config.fieldKey}-audio-bitrate`} className={labelTextCls}>
                        {t('ffmpeg.bitrateKbps')}
                      </label>
                      <input
                        id={`${config.fieldKey}-audio-bitrate`}
                        type="number"
                        value={profile.audio.bitrateKbps ?? ''}
                        onChange={(e) => setAudioBitrate(Number(e.target.value))}
                        className={inputCls + ' w-24 text-right'}
                      />
                    </div>
                    <div className="pt-2">
                      <button
                        type="button"
                        onClick={setAudioPassthrough}
                        className="text-[11px] text-foreground-subtle hover:text-foreground underline-offset-2 hover:underline"
                      >
                        {t('ffmpeg.switchToPassthrough')}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
          {/* end Video+Audio grid */}
        </div>
      )}

      {/* ── Args-only mode: the two raw-args sections rendered directly    */}
      {/*    (always visible, no transcode controls, no geometry builder).  */}
      {argsOnly ? (
        <>
          <div className={sectionCardCls}>
            <div className={sectionHeaderCls}>
              <h3 className={sectionTitleCls}>{t('ffmpeg.inputArgs')}</h3>
            </div>
            <div className="px-3 py-2">{inputArgsBlock}</div>
          </div>
          <div className={sectionCardCls}>
            <div className={sectionHeaderCls}>
              <h3 className={sectionTitleCls}>{t('ffmpeg.outputArgs')}</h3>
            </div>
            <div className="px-3 py-2">{outputArgsBlock}</div>
          </div>
        </>
      ) : (
        /* ── Advanced (collapsible) — full editor's raw ffmpeg args ─────── */
        <div className={sectionCardCls}>
          <button
            type="button"
            onClick={() => setAdvancedOpen((v) => !v)}
            className="w-full px-3 py-1.5 flex items-center justify-between bg-surface-hover/30 hover:bg-surface-hover transition-colors"
          >
            <span className={'inline-flex items-center gap-1.5 ' + sectionTitleCls}>
              {advancedOpen ? (
                <ChevronDown className="h-3 w-3" />
              ) : (
                <ChevronRight className="h-3 w-3" />
              )}
              {t('ffmpeg.advanced')}
            </span>
            <span className="text-[10px] text-foreground-subtle italic">
              {t('ffmpeg.argsCount', {
                count: (profile.inputArgs?.length ?? 0) + (profile.outputArgs?.length ?? 0),
              })}
            </span>
          </button>
          {advancedOpen && (
            <div className="px-3 py-2 space-y-3 border-t border-border/50">
              {inputArgsBlock}
              <GeometryBuilder
                outputArgs={profile.outputArgs ?? []}
                onChange={(next) => {
                  setOutputArgsText(next.join('\n'))
                  setOutputArgs(next.join('\n'))
                }}
              />
              {outputArgsBlock}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── Autosave status badge ───────────────────────────────────────────────
// Small inline affordance for the button-less autosave form. Idle renders a
// muted "Autosaves" hint so the operator knows edits persist without a Save
// click; the other states flash the in-flight / success / failure of the
// last write.

function SaveStatusBadge({ status }: { readonly status: FfmpegSaveStatus }): React.ReactElement {
  const { t } = useT()
  const base =
    'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium border'
  if (status === 'saving') {
    return (
      <span className={`${base} bg-accent/10 text-accent border-accent/30`}>
        <Loader2 className="h-2.5 w-2.5 animate-spin" />
        {t('ffmpeg.saving')}
      </span>
    )
  }
  if (status === 'saved') {
    return (
      <span className={`${base} bg-success/10 text-success border-success/30`}>
        <Check className="h-2.5 w-2.5" />
        {t('ffmpeg.saved')}
      </span>
    )
  }
  if (status === 'error') {
    return (
      <span className={`${base} bg-red-500/10 text-red-400 border-red-500/30`}>
        <AlertCircle className="h-2.5 w-2.5" />
        {t('ffmpeg.saveFailed')}
      </span>
    )
  }
  return (
    <span className={`${base} bg-foreground-subtle/10 text-foreground-subtle border-border`}>
      {t('ffmpeg.autosaves')}
    </span>
  )
}

// ── Source (probed) chips ───────────────────────────────────────────────
// Renders the read-only snapshot of the publisher-advertised params as a
// compact row of chips. Each chip carries a label + value so the operator
// can scan the source state at a glance without any editable input.

interface SourceParamsChipsProps {
  readonly profile: EncodeProfile
}

function SourceParamsChips({ profile }: SourceParamsChipsProps): React.ReactElement {
  const { t } = useT()
  const chipCls =
    'inline-flex items-center gap-1 rounded-full bg-foreground-subtle/10 border border-border ' +
    'px-2 py-0.5 text-[11px] font-mono text-foreground-subtle'
  const { video, audio } = profile
  const resolution =
    video.width !== undefined && video.height !== undefined
      ? `${video.width}×${video.height}`
      : undefined
  return (
    <>
      <span className={chipCls}>
        <span className="opacity-60">{t('ffmpeg.chipCodec')}</span>
        {video.codec}
      </span>
      {resolution !== undefined && (
        <span className={chipCls}>
          <span className="opacity-60">{t('ffmpeg.chipRes')}</span>
          {resolution}
        </span>
      )}
      {video.fps !== undefined && (
        <span className={chipCls}>
          <span className="opacity-60">{t('ffmpeg.chipFps')}</span>
          {video.fps}
        </span>
      )}
      {video.bitrateKbps !== undefined && (
        <span className={chipCls}>
          <span className="opacity-60">{t('ffmpeg.chipBitrate')}</span>
          {video.bitrateKbps}k
        </span>
      )}
      {audio === 'passthrough' ? (
        <span className={chipCls}>
          <span className="opacity-60">{t('ffmpeg.chipAudio')}</span>
          {t('ffmpeg.chipPassthrough')}
        </span>
      ) : (
        <>
          <span className={chipCls}>
            <span className="opacity-60">{t('ffmpeg.chipAudio')}</span>
            {audio.codec}
          </span>
          {audio.bitrateKbps !== undefined && (
            <span className={chipCls}>
              <span className="opacity-60">{t('ffmpeg.chipAudioBitrate')}</span>
              {audio.bitrateKbps}k
            </span>
          )}
          {audio.sampleRateHz !== undefined && (
            <span className={chipCls}>
              <span className="opacity-60">{t('ffmpeg.chipSampleRate')}</span>
              {audio.sampleRateHz}Hz
            </span>
          )}
          {audio.channels !== undefined && (
            <span className={chipCls}>
              <span className="opacity-60">{t('ffmpeg.chipChannels')}</span>
              {audio.channels}
            </span>
          )}
        </>
      )}
    </>
  )
}

// ── WidgetProps wrapper (mounted by the form-builder via WidgetSlot) ─────
//
// The form-builder framework mounts widgets with `{instanceId, host,
// config, deviceId, integrationId}` only — no value, no save handler.
// This wrapper:
//   - reads the initial value from `config.initialValue` (passed by the
//     contribution builder in `getDeviceSettingsContribution`),
//   - tracks the EncodeProfile in local state from then on,
//   - dispatches edits through `deviceManager.updateDeviceField` using
//     the `writerCapName` + `writerAddonId` routing tags from config.
//
// The contribution builder is responsible for populating `initialValue`
// + `writerCapName` + `writerAddonId` per (deviceId, fieldKey) — that's
// what makes each (camera, camStream) instance show its OWN persisted
// override instead of the same baked default for everyone.

export function FfmpegParamsField(props: WidgetProps): React.ReactElement | null {
  const { t } = useT()
  // Documented type boundary: the framework declares widget config as
  // `Readonly<Record<string, unknown>>` because every widget defines its
  // own shape. We narrow to a typed Partial — guards below assert the
  // mandatory fields before any save dispatch.
  const cfg = (props.config ?? {}) as Readonly<Partial<FfmpegParamsWidgetConfig>>
  const updateField = useDeviceManagerUpdateDeviceField()

  // Local state seeded from the contribution-builder snapshot — the
  // widget is the source of truth from mount onward. We intentionally
  // do NOT re-sync from `cfg.initialValue` on re-render: the parent
  // form-builder may produce new identities each render even when the
  // value hasn't changed; re-syncing would clobber user edits in flight.
  const [value, setValue] = useState<EncodeProfile | undefined>(() => cfg.initialValue)

  const handleSave = useCallback(
    (next: EncodeProfile | undefined): void => {
      setValue(next)
      if (props.deviceId === undefined) return
      const writerCapName = cfg.writerCapName
      const writerAddonId = cfg.writerAddonId
      const fieldKey = cfg.fieldKey
      if (writerCapName === undefined || writerAddonId === undefined || fieldKey === undefined) {
        // Misconfigured contribution — log loudly so the operator notices.
        console.warn(
          `[ffmpeg-params] widgetConfig is missing writerCapName/writerAddonId/fieldKey — ` +
            `field ${fieldKey ?? '(unknown)'} cannot be saved. Fix the contribution builder.`,
        )
        return
      }
      updateField.mutate({
        deviceId: props.deviceId,
        writerCapName,
        writerAddonId,
        key: fieldKey,
        value: next ?? null,
      })
    },
    [props.deviceId, cfg.fieldKey, cfg.writerCapName, cfg.writerAddonId, updateField],
  )

  if (props.deviceId === undefined) {
    return (
      <div className="rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
        {t('ffmpeg.noDeviceId')}
      </div>
    )
  }
  const fieldKey = cfg.fieldKey
  if (fieldKey === undefined || fieldKey.length === 0) {
    return (
      <div className="rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
        {t('ffmpeg.fieldKeyRequired')}
      </div>
    )
  }

  // Autosave status derived from the mutation. `isPending` → in flight;
  // `isError` → the last write was rejected (e.g. an invalid encode value);
  // `isSuccess` → persisted. `idle` before the first edit shows the muted
  // "Autosaves" hint so the operator knows there is no Save button to click.
  const saveStatus: FfmpegSaveStatus = updateField.isPending
    ? 'saving'
    : updateField.isError
      ? 'error'
      : updateField.isSuccess
        ? 'saved'
        : 'idle'

  const fullCfg: FfmpegParamsWidgetConfig = { ...cfg, fieldKey }
  return (
    <FfmpegParamsCore config={fullCfg} value={value} onSave={handleSave} saveStatus={saveStatus} />
  )
}

// ── Flag picker ──────────────────────────────────────────────────────────
// Compact "Add flag…" dropdown that groups the catalogue by `group` and
// shows the flag literal as the label. Clicking a row dispatches `onPick`
// which appends the flag to the host textarea.

interface FlagPickerProps {
  readonly id: string
  readonly disabled: boolean
  readonly catalogue: readonly FlagSuggestion[]
  readonly onPick: (suggestion: FlagSuggestion) => void
}

function FlagPicker({ id, disabled, catalogue, onPick }: FlagPickerProps): React.ReactElement {
  const { t } = useT()
  const [open, setOpen] = useState(false)

  // Group catalogue entries by their `group` field.
  const grouped = useMemo(() => {
    const out = new Map<MessageKey, FlagSuggestion[]>()
    for (const s of catalogue) {
      const list = out.get(s.group) ?? []
      list.push(s)
      out.set(s.group, list)
    }
    return out
  }, [catalogue])

  return (
    <div className="relative">
      <button
        id={id}
        type="button"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        className={
          'inline-flex items-center gap-1 rounded-md border border-border bg-surface-hover ' +
          'px-2 py-0.5 text-[10px] font-medium text-foreground-subtle hover:bg-surface-hover/70 ' +
          'disabled:opacity-40 disabled:cursor-not-allowed transition-colors'
        }
      >
        <Plus className="h-3 w-3" />
        {t('ffmpeg.addFlag')}
      </button>
      {open && !disabled && (
        <>
          {/* Click-outside scrim */}
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} aria-hidden="true" />
          <div
            className={
              'absolute right-0 top-full z-50 mt-1 max-h-72 w-72 overflow-y-auto rounded-lg ' +
              'border border-border bg-surface shadow-lg'
            }
            role="menu"
          >
            {Array.from(grouped.entries()).map(([groupName, entries]) => (
              <div key={groupName} className="border-b border-border/30 last:border-b-0">
                <div className="sticky top-0 bg-surface-hover/80 backdrop-blur px-2 py-1 text-[9px] font-semibold uppercase tracking-wider text-foreground-subtle">
                  {t(groupName)}
                </div>
                {entries.map((s) => (
                  <button
                    key={s.label}
                    type="button"
                    onClick={() => {
                      onPick(s)
                      setOpen(false)
                    }}
                    className="w-full text-left px-2 py-1.5 hover:bg-surface-hover transition-colors group"
                  >
                    <div className="font-mono text-[11px] text-foreground">{s.label}</div>
                    {s.descriptionKey !== undefined && (
                      <div className="text-[10px] text-foreground-subtle leading-snug mt-0.5">
                        {t(s.descriptionKey)}
                      </div>
                    )}
                  </button>
                ))}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
