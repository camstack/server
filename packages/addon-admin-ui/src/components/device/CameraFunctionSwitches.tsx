/**
 * The per-camera FUNCTION SWITCHES in device details — one control, every
 * function the hub reports (D544).
 *
 * ## What this replaced, and why
 *
 * It used to be a row of independent pills over a hand-written list of four
 * ids, each re-deriving its state locally from `getBindings` +
 * `recording.getDeviceConfig`. The viewer, meanwhile, rendered all nine rows
 * straight from `pipelineOrchestrator.getCameraSwitches`. So the two clients
 * disagreed about which functions a camera even HAS, and the operator found
 * it the obvious way: the privacy mask is on the viewer and not here.
 *
 * Now both render the same composed payload. Labels, cost lines, availability
 * and order all travel on the wire, so a switch the hub gains tomorrow appears
 * tomorrow — with its own label and its own cost line — from an admin UI built
 * today.
 *
 * ## What has NOT changed
 *
 * - **A switch stores nothing.** `setCameraSwitch` dispatches on
 *   `CameraSwitch.authority` and writes the authority that already owns the
 *   function. The group is a composition, never a second store (D62).
 * - **An off function is REPORTED off.** The trigger keeps the count and the
 *   labels even while the controls are folded behind it, because a camera
 *   producing nothing because somebody switched it off must never read as a
 *   broken one (D113's surviving half).
 * - **Unknown is not a control.** A row the hub could not read draws as
 *   unknown and cannot be clicked; a toggle over a guessed state writes the
 *   opposite of what the operator sees half the time.
 *
 * Optimistic is deliberately NOT done here: these writes walk the registry or
 * re-plan the recorder, and the hub answers with the whole recomposed group.
 * Rendering its answer is both simpler and more honest than guessing it.
 */
import { useCallback, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import {
  Archive,
  Bell,
  Disc,
  Ear,
  EyeOff,
  Mic,
  Radio,
  ScanEye,
  SlidersHorizontal,
  Volume2,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { CameraSwitchId } from '@camstack/types'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
  usePipelineOrchestratorGetCameraSwitches,
  usePipelineOrchestratorSetCameraSwitch,
} from '@camstack/ui-library'
import { useEventInvalidation } from '../../hooks/useEventInvalidation'
import {
  type CameraSwitchIconKey,
  type CameraSwitchRow,
  iconKeyForLabel,
  parseCameraSwitchRows,
  summariseCameraSwitches,
} from './camera-switch-rows'
import { useTranslation } from 'react-i18next'

export interface CameraFunctionSwitchesProps {
  /** Numeric device id — cameras only; the caller filters by device type. */
  readonly deviceId: number
}

/**
 * Glyphs by icon KEY, never by switch id — the key comes from the label, so a
 * row this build has never heard of still gets a complete control.
 */
const ICONS: Readonly<Record<CameraSwitchIconKey, LucideIcon>> = {
  stream: Radio,
  detection: ScanEye,
  privacy: EyeOff,
  microphone: Mic,
  speaker: Volume2,
  listening: Ear,
  // Writing history, not capturing it — deliberately not `Disc`, which is
  // recording. Two functions, two glyphs.
  archive: Archive,
  recording: Disc,
  notifications: Bell,
  generic: SlidersHorizontal,
}

export function CameraFunctionSwitches({ deviceId }: CameraFunctionSwitchesProps) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const enabled = Number.isFinite(deviceId)
  const [failure, setFailure] = useState<{ id: string; message: string } | null>(null)
  // Held here rather than left to `Popover`'s own state so a toggle does NOT
  // close the menu: an operator usually flips more than one, and a sheet that
  // dismisses itself after each row makes three clicks into six.
  const [menuOpen, setMenuOpen] = useState(false)

  const switchesQuery = usePipelineOrchestratorGetCameraSwitches({ deviceId }, { enabled })

  // A binding flipped anywhere else — the Bindings tab, another admin, the
  // viewer — must move this control too. Two surfaces onto one authority that
  // disagree is exactly what composing from the authority is meant to end.
  useEventInvalidation(
    ['pipelineOrchestrator', 'getCameraSwitches'],
    ['capability.binding-changed'],
  )

  const rows = parseCameraSwitchRows(switchesQuery.data)

  const setCameraSwitch = usePipelineOrchestratorSetCameraSwitch({
    onError: (err: unknown, input: { switchId: string }) => {
      // The revert is invisible unless it is said out loud. Tagged with the
      // numeric deviceId like every other per-device line, so "why is 102
      // different from 101" stays answerable.
      console.error('[CameraFunctionSwitches] switch write failed — reverting', {
        tags: { deviceId },
        meta: {
          switchId: input.switchId,
          error: err instanceof Error ? err.message : String(err),
        },
      })
      void queryClient.invalidateQueries({
        queryKey: [['pipelineOrchestrator', 'getCameraSwitches']],
      })
      setFailure({ id: input.switchId, message: err instanceof Error ? err.message : String(err) })
    },
    onSuccess: () => {
      setFailure(null)
      // The write moved an authority other surfaces read — the device
      // aggregate, the bindings list, the recorder's config.
      void queryClient.invalidateQueries({ queryKey: [['pipelineOrchestrator']] })
      void queryClient.invalidateQueries({ queryKey: [['deviceManager']] })
      void queryClient.invalidateQueries({ queryKey: [['recording']] })
    },
  })

  const toggle = useCallback(
    (row: CameraSwitchRow): void => {
      // Unknown is not a control, and neither is unavailable.
      if (!row.available || row.on === null) return
      // The id is the SERVER'S own value returning to the server: it arrived
      // in this camera's `getCameraSwitches` payload moments ago. Narrowing it
      // with a literal union here would be the catalog this surface exists to
      // stop keeping (D544) — so this is a documented type boundary in the
      // sense CLAUDE.md's no-casts rule allows, and the only one in this file.
      setCameraSwitch.mutate({
        deviceId,
        switchId: row.id as CameraSwitchId,
        enabled: !row.on,
      })
    },
    [deviceId, setCameraSwitch],
  )

  // A query that has not answered makes no claim: no control at all, rather
  // than a row of switches that all read "off" (D315).
  if (rows === null) return null

  const fold = summariseCameraSwitches(rows)
  const failureFor = (row: CameraSwitchRow): string | null =>
    failure?.id === row.id ? failure.message : null

  return (
    <Popover open={menuOpen} onOpenChange={setMenuOpen}>
      <PopoverTrigger
        aria-label={t('device.cameraFunctionSwitches.cameraFunctions', 'Camera functions')}
        title={fold.summary}
        className={`inline-flex items-center gap-1 rounded-lg border px-2 py-1.5 text-[11px] font-medium transition-colors ${
          failure !== null
            ? 'border-danger/50 text-danger bg-danger/5'
            : fold.offIds.length > 0
              ? 'border-warning/40 text-warning hover:bg-warning/10'
              : 'border-border text-foreground-subtle hover:text-foreground hover:bg-surface-hover'
        }`}
      >
        <SlidersHorizontal className="h-3.5 w-3.5" />
        <span className="hidden lg:inline">
          {t('device.cameraFunctionSwitches.functions', 'Functions')}
        </span>
        {/* An off function is REPORTED off, from the CLOSED trigger: a camera
            producing nothing because somebody turned it off must not look
            like a broken one just because the controls folded away. */}
        {fold.offIds.length > 0 && (
          <span className="rounded bg-warning/20 px-1 text-[9px] font-semibold uppercase tracking-wide">
            {t('device.cameraFunctionSwitches.offCount', { count: fold.offIds.length })}
          </span>
        )}
      </PopoverTrigger>
      {/* Bounded and scrollable: nine rows of prose ran off the bottom of the
          page. The viewer learned the same thing at eight rows and moved the
          cost sentence off the permanently-rendered surface — this does the
          same, keeping it in the row's `title`. */}
      <PopoverContent align="end" className="min-w-[240px] max-h-[60vh] overflow-y-auto p-1">
        <div className="px-2 py-1 text-[10px] uppercase tracking-wider text-foreground-subtle">
          {t('device.cameraFunctionSwitches.cameraFunctions', 'Camera functions')}
        </div>
        <ul className="space-y-0.5">
          {rows.map((row) => (
            <li key={row.id}>
              <FunctionMenuRow row={row} failure={failureFor(row)} onToggle={() => toggle(row)} />
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  )
}

interface FunctionMenuRowProps {
  readonly row: CameraSwitchRow
  readonly failure: string | null
  readonly onToggle: () => void
}

/**
 * One function. An UNAVAILABLE row is still drawn, with the hub's reason
 * instead of a toggle — never a dead control, and never silently absent: a
 * toggle that does nothing at least tells the operator the feature exists.
 */
function FunctionMenuRow({ row, failure, onToggle }: FunctionMenuRowProps) {
  const { t } = useTranslation()
  const Icon = ICONS[iconKeyForLabel(row.label)]
  const unknown = row.on === null
  const off = row.on === false
  // The full cost sentence is the TOOLTIP, never the row: it is a paragraph
  // per function, and nine of them is two screens of prose to find one toggle.
  const title =
    failure !== null
      ? `Write failed: ${failure}`
      : unknown
        ? (row.unavailableReason ?? 'The source that owns this did not answer.')
        : row.costWhenOff
  // What the row itself says, when it needs to say anything at all: a state
  // the operator cannot act on, in as few words as it takes.
  const note =
    failure !== null ? 'write failed' : unknown ? (row.unavailableReason ?? 'unknown') : null
  return (
    <button
      type="button"
      role="switch"
      aria-label={row.label}
      aria-checked={row.on === true}
      disabled={!row.available}
      onClick={onToggle}
      title={title}
      className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[12px] text-foreground transition-colors hover:bg-surface-hover disabled:opacity-40 disabled:cursor-not-allowed"
    >
      <Icon
        className={`h-3.5 w-3.5 shrink-0 ${
          failure !== null
            ? 'text-danger'
            : unknown
              ? 'text-foreground-subtle/50'
              : off
                ? 'text-warning'
                : 'text-success'
        }`}
      />
      <span className="flex-1 min-w-0 truncate">
        {row.label}
        {note !== null && <span className="ml-1 text-[10px] text-foreground-subtle">· {note}</span>}
      </span>
      {/* The row states what it IS, not what clicking it does. */}
      <span
        className={`shrink-0 rounded px-1 py-0.5 text-[9px] font-semibold uppercase tracking-wide ${
          unknown
            ? 'bg-surface-hover text-foreground-subtle/60'
            : off
              ? 'bg-warning/20 text-warning'
              : 'bg-success/20 text-success'
        }`}
      >
        {unknown ? '—' : off ? t('common.off') : t('common.on')}
      </span>
    </button>
  )
}
