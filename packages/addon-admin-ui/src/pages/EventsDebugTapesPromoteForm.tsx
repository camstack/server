/**
 * The promote-a-window form for Events → Debug → Tracking tapes (D681),
 * split out of `EventsDebugTapes.tsx` (Task 24 fix round 1 — kept that file
 * near the 400-line guideline). `cameras` is built by the caller from
 * `promotableCameras`: every camera with stored segments, regardless of its
 * CURRENT switch state — `debug.tape.promote` only needs a segment covering
 * the window, not a currently-armed switch, so a camera switched off after
 * capturing a scenario must still be promotable here.
 */
import { Button, Input, Select } from '@camstack/ui-library'
import { Loader2 } from 'lucide-react'
import { type JSX, useState } from 'react'
import {
  type CallAction,
  errorText,
  formatBytes,
  parseLocalDateTime,
  parsePromote,
  promoteRefusalText,
  TAPE_ACTIONS,
  UNREADABLE,
} from './events-debug-tapes.helpers'
import { useTranslation } from 'react-i18next'

export interface CameraOption {
  readonly value: string
  readonly label: string
}

export interface PromoteFormProps {
  readonly cameras: readonly CameraOption[]
  readonly call: CallAction
  readonly onPromoted: () => void
}

export function PromoteForm({ cameras, call, onPromoted }: PromoteFormProps): JSX.Element {
  const { t } = useTranslation()
  const [camera, setCamera] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [scenario, setScenario] = useState('')
  const [note, setNote] = useState('')
  const [lighting, setLighting] = useState('auto')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  const submit = async (): Promise<void> => {
    const deviceId = Number.parseInt(camera === '' ? (cameras[0]?.value ?? '') : camera, 10)
    const fromMs = parseLocalDateTime(from)
    const toMs = parseLocalDateTime(to)
    if (!Number.isFinite(deviceId) || fromMs === null || toMs === null) {
      setMessage('Pick a camera and both ends of the window.')
      return
    }
    setBusy(true)
    setMessage(null)
    try {
      const raw = await call(TAPE_ACTIONS.promote, {
        deviceId,
        fromMs,
        toMs,
        scenario,
        ...(note.trim().length > 0 ? { note: note.trim() } : {}),
        ...(lighting === 'day' || lighting === 'ir' ? { lighting } : {}),
      })
      const r = parsePromote(raw)
      if (r === null) setMessage(UNREADABLE)
      else if (!r.ok) setMessage(promoteRefusalText(r.reason, r.detail))
      else {
        setMessage(
          `Promoted ${r.tapeId}: ${String(r.frames)} frames, ${formatBytes(r.bytes)}, ${String(r.pinnedTracks)} tracks pinned` +
            (r.state === 'incomplete'
              ? ' — incomplete (it has gaps) and cannot become a case.'
              : '.'),
        )
        onPromoted()
      }
    } catch (err: unknown) {
      setMessage(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-wrap items-end gap-2 rounded-md border border-border px-3 py-2">
      <div className="w-40">
        <Select
          value={camera}
          options={[...cameras]}
          onChange={(e) => setCamera(e.target.value)}
          aria-label={t('eventsDebugTapesPromoteForm.camera', 'Camera')}
        />
      </div>
      <Input
        type="datetime-local"
        aria-label={t('eventsDebugTapesPromoteForm.from', 'From')}
        value={from}
        onChange={(e) => setFrom(e.target.value)}
        className="w-48"
      />
      <Input
        type="datetime-local"
        aria-label={t('eventsDebugTapesPromoteForm.to', 'To')}
        value={to}
        onChange={(e) => setTo(e.target.value)}
        className="w-48"
      />
      <Input
        aria-label={t('eventsDebugTapesPromoteForm.scenario', 'Scenario')}
        placeholder="101-door-groups"
        value={scenario}
        onChange={(e) => setScenario(e.target.value)}
        className="w-44"
      />
      <Input
        aria-label={t('eventsDebugTapesPromoteForm.note', 'Note')}
        placeholder={t('eventsDebugTapesPromoteForm.optionalNote', 'optional note')}
        value={note}
        onChange={(e) => setNote(e.target.value)}
        className="w-52"
      />
      <div className="w-28">
        <Select
          value={lighting}
          aria-label={t('eventsDebugTapesPromoteForm.lighting', 'Lighting')}
          options={[
            {
              value: 'auto',
              label: t('eventsDebugTapesPromoteForm.lightingAuto', 'Lighting: auto'),
            },
            { value: 'day', label: t('eventsDebugTapes.dayMode') },
            { value: 'ir', label: 'IR' },
          ]}
          onChange={(e) => setLighting(e.target.value)}
        />
      </div>
      <Button onClick={() => void submit()} disabled={busy || cameras.length === 0}>
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}{' '}
        {t('eventsDebugTapes.promoteWindow')}
      </Button>
      <p className="w-full text-xs text-foreground-subtle">
        {t(
          'eventsDebugTapesPromoteForm.aPromotedTapeMayBe',
          'A promoted tape may be shared as a test case — keep the scenario slug and note free of names or other personal data.',
        )}
      </p>
      {message !== null && <p className="w-full text-xs text-foreground">{message}</p>}
    </div>
  )
}
