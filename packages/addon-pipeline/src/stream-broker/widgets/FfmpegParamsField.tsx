import { DerivedSourceRefSchema, type EncodeProfile } from '@dominevo/types'
import type { WidgetProps } from '@dominevo/ui-library'
import {
  useDeviceManagerUpdateDeviceField,
  useStreamBrokerGetBrokerStats,
  useStreamBrokerPreviewDerivedEncode,
  Button,
  FormSaveBar,
  Input,
  Switch,
  Textarea,
  Select,
} from '@dominevo/ui-library'
import { AlertCircle, Check, ChevronDown, ChevronRight, Loader2, Plus } from 'lucide-react'
import * as React from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useT } from '../../i18n/index.js'
import {
  audioCodecOf,
  changedFieldCount,
  isBareSourceProfile,
  PASSTHROUGH_PROFILE,
  parseAudioCodec,
  parseVideoCodecChoice,
  profileToSave,
  type SectionId,
  type SectionState,
  sectionsOf,
  videoCodecChoiceOf,
  withAudioCodec,
  withFps,
  withVideoCodec,
  withVideoField,
  withWidth,
} from './encode-sections.js'
import { EncodeResultPanel, type ResultView, type RunningView } from './EncodeResultPanel.js'
import { GeometryBuilder } from './GeometryBuilder.js'
import { migrateHeightToWidth, resolutionLadder, type SourceSize } from './resolution-ladder.js'

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
  /**
   * Broker id (`<deviceId>/derived:<name>`) whose running encode the "Final
   * result" panel compares with the plan. Absent for a stream with no broker
   * of its own: no running / idle badge.
   */
  statsBrokerId?: string
  /**
   * The derived stream's source (a `DerivedSourceRef`), so the plan is computed
   * against the stream the encode will really read. Validated on read.
   */
  previewSource?: unknown
}

/**
 * Lifecycle of the last Save, surfaced to the operator. Edits stay a local
 * draft until the Save button writes them (every save respawns the derived
 * feeder) — this drives the inline "Saving… / Saved / Save failed" indicator
 * so a save is never silently in-flight or silently dropped.
 */
export type FfmpegSaveStatus = 'idle' | 'saving' | 'saved' | 'error'

export interface FfmpegParamsCoreProps {
  readonly config: FfmpegParamsWidgetConfig
  readonly value: EncodeProfile | undefined
  readonly onSave: (next: EncodeProfile | undefined) => void
  /** Status of the last save for the header indicator. Omit in tests. */
  readonly saveStatus?: FfmpegSaveStatus
  /** Fires with the profile being edited (the draft, or the stored one after a save or discard). */
  readonly onEditedChange?: (edited: EncodeProfile | undefined) => void
  /** The server's plan for the profile being edited; absent = nothing asked yet. */
  readonly result?: ResultView
  /** The running encode of this stream; absent = no badge. */
  readonly running?: RunningView
}

/**
 * Fallback profile when nothing has been persisted yet — a plain
 * copy/passthrough transform (no re-encode). Module-level singleton so
 * the edited `profile` keeps a stable identity across renders while
 * `value` is undefined (otherwise the textarea-resync guard would loop).
 */
const PASSTHROUGH_DEFAULT: EncodeProfile = PASSTHROUGH_PROFILE

// ── Tailwind primitives matching StreamBrokerPanel conventions ──────────
const inputCls =
  'rounded border border-border bg-surface px-2 py-1 text-xs text-foreground ' +
  'focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-50 disabled:cursor-not-allowed ' +
  'read-only:opacity-60 read-only:cursor-not-allowed'

const textareaCls =
  'w-full rounded border border-border bg-surface px-2 py-1.5 text-[11px] font-mono text-foreground ' +
  'focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-50 read-only:opacity-60 ' +
  'min-h-[60px] resize-y'

const labelRowCls = 'flex items-center justify-between gap-3 py-1.5'
const labelTextCls = 'text-[11px] uppercase tracking-wider text-foreground-subtle font-medium'
const sectionCardCls = 'rounded-lg border border-border bg-surface overflow-hidden'
const sectionHeaderCls =
  'border-b border-border px-3 py-1.5 flex items-center justify-between bg-surface-hover/30'
const sectionTitleCls = 'text-[11px] font-semibold text-foreground uppercase tracking-wider'

interface SectionCardProps {
  readonly title: string
  readonly on: boolean
  readonly onToggle: (next: boolean) => void
  /** One line shown while the section is off: what the stream does without it. */
  readonly offHint: string
  readonly children: React.ReactNode
}

/** One independent editor section: a title, its own switch, its controls only while on. */
function SectionCard({
  title,
  on,
  onToggle,
  offHint,
  children,
}: SectionCardProps): React.ReactElement {
  return (
    <div className={sectionCardCls}>
      <div className={sectionHeaderCls}>
        <h3 className={sectionTitleCls}>{title}</h3>
        <Switch checked={on} onCheckedChange={onToggle} aria-label={title} />
      </div>
      <div className="px-3 py-2">
        {on ? children : <p className="text-[11px] text-foreground-subtle italic">{offHint}</p>}
      </div>
    </div>
  )
}

interface DraftNumberInputProps {
  readonly id: string
  readonly ariaLabel: string
  /** The persisted value; `undefined` = the field is absent. */
  readonly value: number | undefined
  /** Whole numbers only (width, bitrate). */
  readonly integer: boolean
  /** Even numbers only (a picture width the encoder accepts). */
  readonly even?: boolean
  readonly placeholder: string
  readonly invalidText: string
  /** `undefined` = the operator cleared the field. */
  readonly onCommit: (next: number | undefined) => void
}

/**
 * A numeric field that keeps a local draft and commits on blur / Enter, so a
 * keystroke is not an edit. An empty
 * draft clears the value, an invalid one is not applied and shows the error
 * state, Escape reverts to the persisted value.
 */
function DraftNumberInput({
  id,
  ariaLabel,
  value,
  integer,
  even = false,
  placeholder,
  invalidText,
  onCommit,
}: DraftNumberInputProps): React.ReactElement {
  const [draft, setDraft] = useState<string | null>(null)
  const [invalid, setInvalid] = useState(false)

  const commit = (): void => {
    if (draft === null) return
    const trimmed = draft.trim()
    if (trimmed === '') {
      if (value !== undefined) onCommit(undefined)
    } else {
      const n = Number(trimmed)
      if (
        !Number.isFinite(n) ||
        n <= 0 ||
        (integer && !Number.isInteger(n)) ||
        (even && n % 2 !== 0)
      ) {
        setInvalid(true)
        return
      }
      if (n !== value) onCommit(n)
    }
    setInvalid(false)
    setDraft(null)
  }

  return (
    <Input
      id={id}
      type="number"
      aria-label={ariaLabel}
      aria-invalid={invalid || undefined}
      title={invalid ? invalidText : undefined}
      state={invalid ? 'error' : 'default'}
      placeholder={placeholder}
      value={draft ?? (value === undefined ? '' : String(value))}
      onChange={(e) => {
        setInvalid(false)
        setDraft(e.target.value)
      }}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit()
        else if (e.key === 'Escape') {
          setInvalid(false)
          setDraft(null)
        }
      }}
      className={inputCls + ' w-24 text-right'}
    />
  )
}

const CUSTOM_WIDTH = 'custom'

interface ResizeControlProps {
  readonly id: string
  /** The edited output width; `undefined` = none chosen yet. */
  readonly width: number | undefined
  readonly source: SourceSize | undefined
  readonly onChange: (width: number | undefined) => void
}

/**
 * The Resize control: the sizes at the source aspect ratio, from the source's
 * own down to the lowest, plus a custom (even) width. Only the width is stored;
 * the height follows the source.
 */
function ResizeControl({ id, width, source, onChange }: ResizeControlProps): React.ReactElement {
  const { t } = useT()
  const ladder = useMemo(() => resolutionLadder(source), [source])
  const inLadder = width !== undefined && ladder.some((option) => option.width === width)
  const [customOpen, setCustomOpen] = useState(false)
  const custom = customOpen || (width !== undefined && !inLadder)
  const selected = custom ? CUSTOM_WIDTH : width === undefined ? '' : String(width)
  return (
    <div className="space-y-1.5">
      <div className={labelRowCls}>
        <label htmlFor={id} className={labelTextCls}>
          {t('ffmpeg.outputSize')}
        </label>
        <Select
          wrapperClassName="inline-block w-auto"
          id={id}
          value={selected}
          onChange={(e) => {
            if (e.target.value === CUSTOM_WIDTH) {
              setCustomOpen(true)
              return
            }
            setCustomOpen(false)
            const next = Number(e.target.value)
            if (Number.isInteger(next) && next > 0) onChange(next)
          }}
          className="min-w-[120px]"
        >
          {width === undefined && !custom ? (
            <option value="" disabled>
              {t('ffmpeg.resizeChoose')}
            </option>
          ) : null}
          {ladder.map((option) => (
            <option key={option.width} value={String(option.width)}>
              {`${String(option.width)}×${String(option.height)}`}
            </option>
          ))}
          <option value={CUSTOM_WIDTH}>{t('ffmpeg.resizeCustom')}</option>
        </Select>
      </div>
      {custom ? (
        <div className={labelRowCls}>
          <label htmlFor={`${id}-custom`} className={labelTextCls}>
            {t('ffmpeg.outputWidth')}
          </label>
          <DraftNumberInput
            id={`${id}-custom`}
            ariaLabel={t('ffmpeg.outputWidth')}
            value={width}
            integer={true}
            even={true}
            placeholder={t('ffmpeg.placeholderSource')}
            invalidText={t('ffmpeg.invalidEvenNumber')}
            onCommit={onChange}
          />
        </div>
      ) : null}
    </div>
  )
}

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
  onEditedChange,
  result,
  running,
}: FfmpegParamsCoreProps): React.ReactElement {
  const { t } = useT()
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const argsOnly = config.argsOnly === true

  // The source picture the Resize sizes are cut from, and the stored profile
  // read against it: a height stored by the old editor shows as the matching
  // width. Nothing is written back until the operator saves.
  const sourceWidth = config.sourceParams?.video.width
  const sourceHeight = config.sourceParams?.video.height
  const sourceSize: SourceSize | undefined = useMemo(
    () =>
      sourceWidth !== undefined && sourceHeight !== undefined
        ? { width: sourceWidth, height: sourceHeight }
        : undefined,
    [sourceWidth, sourceHeight],
  )
  const storedView = useMemo(
    () => (value === undefined ? undefined : migrateHeightToWidth(value, sourceSize)),
    [value, sourceSize],
  )
  // Edits are a draft until Save: `null` = nothing edited yet.
  const [draft, setDraft] = useState<{ readonly profile: EncodeProfile | undefined } | null>(null)
  // A stored bare `source` profile shows as passthrough, so it is pending:
  // stored differs from what the editor shows, and Save writes passthrough.
  const bareSource = isBareSourceProfile(value)
  const current: EncodeProfile | undefined =
    draft !== null ? draft.profile : bareSource ? undefined : storedView
  const pendingCount = draft !== null || bareSource ? changedFieldCount(value, current) : 0

  const profile: EncodeProfile = current ?? PASSTHROUGH_DEFAULT
  const probedCodec = config.sourceParams?.video.codec
  const codecOffHint =
    probedCodec === 'h264' || probedCodec === 'h265'
      ? t('ffmpeg.codecOffHintKnown', { codec: probedCodec === 'h265' ? 'H.265' : 'H.264' })
      : t('ffmpeg.codecOffHint')

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

  // Which sections are switched on. Read from the stored profile ONCE, on
  // open, and never written back: only an operator edit saves. A section the
  // operator just switched on that has no value yet (a Resize with no height)
  // stays on here without touching the profile.
  const [on, setOn] = useState<SectionState>(() => sectionsOf(value))
  // An edit changes the draft only. Passthrough is no profile: back at
  // passthrough, saving clears the stored one.
  const edit = (next: EncodeProfile): void => {
    const edited = profileToSave(next)
    if (changedFieldCount(current, edited) === 0) return
    setDraft({ profile: edited })
    onEditedChange?.(edited)
  }
  const save = (): void => {
    if (draft === null && !bareSource) return
    onSave(current)
    setDraft(null)
  }
  const discard = (): void => {
    setDraft(null)
    setOn(sectionsOf(value))
    onEditedChange?.(storedView)
  }
  const toggleSection = (id: SectionId, next: boolean): void => {
    setOn((prev) => ({ ...prev, [id]: next }))
    if (id === 'resize' && !next) edit(withWidth(current, undefined))
    else if (id === 'fps' && !next) edit(withFps(current, undefined))
    else if (id === 'codec') edit(withVideoCodec(current, next ? 'h264' : null))
    else if (id === 'audio') edit(withAudioCodec(current, next ? 'aac' : null))
  }
  const setAudioBitrate = (bitrateKbps: number): void => {
    if (!Number.isFinite(bitrateKbps) || bitrateKbps <= 0) return
    edit({
      ...profile,
      audio:
        typeof profile.audio === 'object'
          ? { ...profile.audio, bitrateKbps }
          : { codec: 'opus', bitrateKbps },
    })
  }
  // A blur that changed nothing is not a save.
  const setArgs = (key: 'inputArgs' | 'outputArgs', lines: string): void => {
    const next = lines
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
    const current = profile[key] ?? []
    if (next.length === current.length && next.every((line, i) => line === current[i])) return
    edit({ ...profile, [key]: next })
  }
  const setInputArgs = (lines: string): void => setArgs('inputArgs', lines)
  const setOutputArgs = (lines: string): void => setArgs('outputArgs', lines)

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
      <Textarea
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
      <Textarea
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
      {/* ── Save status ─────────────────────────────────────────────────── */}
      {/*    Edits are a draft until the Save bar below writes them. This    */}
      {/*    row tells the operator how the last save went.                  */}
      {saveStatus !== undefined && saveStatus !== 'idle' && (
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

      {/* ── Sections: independent, each switched on separately and freely   */}
      {/*    combinable. A section that is off contributes nothing to the    */}
      {/*    profile. The grid tracks the widget's own width (container      */}
      {/*    query), like every sibling composition. Hidden in args-only     */}
      {/*    mode (source normalization), where nothing is transcoded.       */}
      {!argsOnly && (
        <div className="@container space-y-3">
          <div className="grid grid-cols-1 gap-3 @[480px]:grid-cols-2">
            <SectionCard
              title={t('ffmpeg.sectionResize')}
              on={on.resize}
              onToggle={(next) => toggleSection('resize', next)}
              offHint={t('ffmpeg.resizeOffHint')}
            >
              <ResizeControl
                id={`${config.fieldKey}-resize-width`}
                width={profile.video.width}
                source={sourceSize}
                onChange={(next) => edit(withWidth(current, next))}
              />
              <p className="text-[11px] text-foreground-subtle">{t('ffmpeg.resizeOnHint')}</p>
            </SectionCard>

            <SectionCard
              title={t('ffmpeg.sectionCodec')}
              on={on.codec}
              onToggle={(next) => toggleSection('codec', next)}
              offHint={codecOffHint}
            >
              <div className={labelRowCls}>
                <label htmlFor={`${config.fieldKey}-video-codec`} className={labelTextCls}>
                  {t('ffmpeg.sectionCodec')}
                </label>
                <Select
                  wrapperClassName="inline-block w-auto"
                  id={`${config.fieldKey}-video-codec`}
                  value={videoCodecChoiceOf(current)}
                  onChange={(e) => {
                    const choice = parseVideoCodecChoice(e.target.value)
                    if (choice !== undefined) edit(withVideoCodec(current, choice))
                  }}
                  className="min-w-[120px]"
                >
                  <option value="h264">{t('ffmpeg.codecH264')}</option>
                  <option value="h265">{t('ffmpeg.codecH265')}</option>
                </Select>
              </div>
            </SectionCard>

            <SectionCard
              title={t('ffmpeg.sectionAudio')}
              on={on.audio}
              onToggle={(next) => toggleSection('audio', next)}
              offHint={t('ffmpeg.audioOffHint')}
            >
              <div className={labelRowCls}>
                <label htmlFor={`${config.fieldKey}-audio-codec`} className={labelTextCls}>
                  {t('ffmpeg.sectionAudio')}
                </label>
                <Select
                  wrapperClassName="inline-block w-auto"
                  id={`${config.fieldKey}-audio-codec`}
                  value={audioCodecOf(current)}
                  onChange={(e) => {
                    const codec = parseAudioCodec(e.target.value)
                    if (codec !== undefined) edit(withAudioCodec(current, codec))
                  }}
                  className="min-w-[120px]"
                >
                  <option value="aac">{t('ffmpeg.audioAac')}</option>
                  <option value="opus">{t('ffmpeg.audioOpus')}</option>
                  <option value="pcmu">{t('ffmpeg.audioPcmu')}</option>
                  <option value="pcma">{t('ffmpeg.audioPcma')}</option>
                  <option value="none">{t('ffmpeg.audioNone')}</option>
                </Select>
              </div>
            </SectionCard>

            <SectionCard
              title={t('ffmpeg.sectionFps')}
              on={on.fps}
              onToggle={(next) => toggleSection('fps', next)}
              offHint={t('ffmpeg.fpsOffHint')}
            >
              <div className={labelRowCls}>
                <label htmlFor={`${config.fieldKey}-video-fps`} className={labelTextCls}>
                  {t('ffmpeg.fps')}
                </label>
                <DraftNumberInput
                  id={`${config.fieldKey}-video-fps`}
                  ariaLabel={t('ffmpeg.fps')}
                  value={profile.video.fps}
                  integer={false}
                  placeholder={
                    config.sourceParams?.video.fps !== undefined
                      ? t('ffmpeg.placeholderFps', { fps: config.sourceParams.video.fps })
                      : t('ffmpeg.placeholderSource')
                  }
                  invalidText={t('ffmpeg.invalidNumber')}
                  onCommit={(next) => edit(withFps(current, next))}
                />
              </div>
              <p className="text-[11px] text-foreground-subtle">{t('ffmpeg.fpsOnHint')}</p>
            </SectionCard>
          </div>

          <EncodeResultPanel
            profile={current}
            result={result ?? { kind: 'pending' }}
            {...(running !== undefined ? { running } : {})}
          />
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
        /* ── Expert (collapsible, last) — the fields no section owns, and the raw args ── */
        <div className={sectionCardCls}>
          <Button
            variant="unstyled"
            type="button"
            onClick={() => setAdvancedOpen((v) => !v)}
            aria-expanded={advancedOpen}
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
          </Button>
          {advancedOpen && (
            <div className="px-3 py-2 space-y-3 border-t border-border/50">
              <p className="text-[11px] text-foreground-subtle">{t('ffmpeg.expertHint')}</p>
              <div className="divide-y divide-border/30">
                <div className={labelRowCls}>
                  <label htmlFor={`${config.fieldKey}-video-bitrate`} className={labelTextCls}>
                    {t('ffmpeg.bitrateKbps')}
                  </label>
                  <DraftNumberInput
                    id={`${config.fieldKey}-video-bitrate`}
                    ariaLabel={t('ffmpeg.bitrateKbps')}
                    value={profile.video.bitrateKbps}
                    integer={true}
                    placeholder={t('ffmpeg.placeholderAuto')}
                    invalidText={t('ffmpeg.invalidNumber')}
                    onCommit={(next) => edit(withVideoField(current, 'bitrateKbps', next))}
                  />
                </div>
                <div className={labelRowCls}>
                  <label htmlFor={`${config.fieldKey}-video-gop`} className={labelTextCls}>
                    {t('ffmpeg.gopFrames')}
                  </label>
                  <DraftNumberInput
                    id={`${config.fieldKey}-video-gop`}
                    ariaLabel={t('ffmpeg.gopFrames')}
                    value={profile.video.gopFrames}
                    integer={true}
                    placeholder={t('ffmpeg.placeholderAuto')}
                    invalidText={t('ffmpeg.invalidNumber')}
                    onCommit={(next) => edit(withVideoField(current, 'gopFrames', next))}
                  />
                </div>
                {typeof profile.audio === 'object' && (
                  <div className={labelRowCls}>
                    <label htmlFor={`${config.fieldKey}-audio-bitrate`} className={labelTextCls}>
                      {t('ffmpeg.audioBitrate')}
                    </label>
                    <Input
                      id={`${config.fieldKey}-audio-bitrate`}
                      type="number"
                      value={profile.audio.bitrateKbps ?? ''}
                      onChange={(e) => setAudioBitrate(Number(e.target.value))}
                      className={inputCls + ' w-24 text-right'}
                    />
                  </div>
                )}
              </div>
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

      {/* The same Save / Discard bar the other settings forms use. */}
      <FormSaveBar
        pendingCount={pendingCount}
        onSave={save}
        onDiscard={discard}
        saving={saveStatus === 'saving'}
      />
    </div>
  )
}

// ── Save status badge ───────────────────────────────────────────────
// Small inline affordance for the in-flight / success / failure of the last
// save. Idle renders nothing: the Save bar speaks for pending edits.

function SaveStatusBadge({
  status,
}: {
  readonly status: FfmpegSaveStatus
}): React.ReactElement | null {
  const { t } = useT()
  const base =
    'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium border'
  if (status === 'saving') {
    return (
      <span className={`${base} bg-primary/10 text-primary border-primary/30`}>
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
      <span className={`${base} bg-danger/10 text-danger border-danger/30`}>
        <AlertCircle className="h-2.5 w-2.5" />
        {t('ffmpeg.saveFailed')}
      </span>
    )
  }
  return null
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
  // The profile being edited (the unsaved draft, or the saved value): the plan
  // below is computed for what the operator sees, not only for what is stored.
  const [edited, setEdited] = useState<EncodeProfile | undefined>(() => cfg.initialValue)

  // The plan for the profile being edited, computed by the server and asked
  // for once the operator pauses. The profile is the query key, so a new edit
  // is a new query; the last answer stays on screen meanwhile.
  const debouncedProfile = useDebouncedValue(edited ?? PASSTHROUGH_PROFILE, PREVIEW_DEBOUNCE_MS)
  const previewSource = DerivedSourceRefSchema.safeParse(cfg.previewSource)
  const previewQuery = useStreamBrokerPreviewDerivedEncode(
    {
      deviceId: props.deviceId ?? 0,
      profile: debouncedProfile,
      ...(previewSource.success ? { source: previewSource.data } : {}),
    },
    {
      enabled: props.deviceId !== undefined && cfg.argsOnly !== true,
      placeholderData: keepPrevious,
    },
  )
  const result: ResultView = previewQuery.isError
    ? { kind: 'unavailable' }
    : previewQuery.data === undefined
      ? { kind: 'pending' }
      : previewQuery.data.kind === 'no-source'
        ? { kind: 'no-source' }
        : { kind: 'ready', preview: previewQuery.data.preview }

  // The running encode, polled: a broker that is not running answers with the
  // stats of a stopped one and no `derivedEncode`, which is "not running" — an
  // unanswered or failed query is `pending` / `unavailable`, never that.
  const statsQuery = useStreamBrokerGetBrokerStats(
    { brokerId: cfg.statsBrokerId ?? '' },
    { enabled: cfg.statsBrokerId !== undefined, refetchInterval: 5_000 },
  )
  const running: RunningView | undefined =
    cfg.statsBrokerId === undefined
      ? undefined
      : statsQuery.isError
        ? { kind: 'unavailable' }
        : statsQuery.data === undefined
          ? { kind: 'pending' }
          : statsQuery.data.derivedEncode !== undefined
            ? { kind: 'running', encode: statsQuery.data.derivedEncode }
            : { kind: 'idle' }

  const handleSave = useCallback(
    (next: EncodeProfile | undefined): void => {
      setValue(next)
      setEdited(next)
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

  // Save status derived from the mutation. `isPending` → in flight;
  // `isError` → the last write was rejected (e.g. an invalid encode value);
  // `isSuccess` → persisted. `idle` before the first save shows nothing.
  const saveStatus: FfmpegSaveStatus = updateField.isPending
    ? 'saving'
    : updateField.isError
      ? 'error'
      : updateField.isSuccess
        ? 'saved'
        : 'idle'

  const fullCfg: FfmpegParamsWidgetConfig = { ...cfg, fieldKey }
  return (
    <FfmpegParamsCore
      config={fullCfg}
      value={value}
      onSave={handleSave}
      saveStatus={saveStatus}
      onEditedChange={setEdited}
      result={result}
      {...(running !== undefined ? { running } : {})}
    />
  )
}

/** How long the operator must pause before the plan is asked for. */
const PREVIEW_DEBOUNCE_MS = 300

/** react-query `placeholderData`: keep the previous answer while the next one loads. */
function keepPrevious<T>(previous: T | undefined): T | undefined {
  return previous
}

/** `value`, delayed until it has stopped changing for `delayMs`. */
function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs)
    return () => clearTimeout(timer)
  }, [value, delayMs])
  return debounced
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
      <Button
        variant="unstyled"
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
      </Button>
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
                  <Button
                    variant="unstyled"
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
                  </Button>
                ))}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
