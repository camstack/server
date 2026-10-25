/**
 * Where "Home" sends this camera, and how it is set.
 *
 * ## Why this exists at all
 *
 * The vendor "convention" was wrong on every camera of this fleet. Three
 * providers each hardcoded a slot — reolink 0, hikvision '1', amcrest 1 — and
 * measured on 2026-09-17 those slots held "stanza", "Credenza" and "Preset1":
 * the operator's own presets, not a home. Two of the three swallowed the
 * failure, so a head that never moved looked exactly like one that went home.
 *
 * ## The mistake this component made first
 *
 * Its first version rendered NOTHING for `source: 'native'`, with a comment
 * saying "the camera homes natively; there is no preset to choose". That is
 * true for ONVIF, whose home is the fixed PTZ origin. It was written hours
 * before we learned that Reolink's native home is a GUARD POINT — a stored
 * position, settable, with its own idle-return timer — so the control was
 * hidden from the one vendor that most needed it. A comment that is right about
 * one case and read as covering all of them is exactly the leftover that reads
 * as verification.
 *
 * ## What each state offers now
 *
 *   `native`   — no preset to pick, but "Set home here" and, where the camera
 *                has one, the idle-return delay.
 *   `firmware` — the camera named its own home (Hikvision's "Back to origin").
 *                Preselected; the operator may override.
 *   `operator` — pinned here.
 *   `none`     — Home REFUSES, and the UI says so. A disabled feature must
 *                never look like a broken one (D62).
 */
import { useUiText } from '../../contexts/ui-text'
import { useState } from 'react'
import type { UsePTZResult } from '../../hooks/use-ptz'

interface HomePresetPickerProps {
  readonly controls: UsePTZResult
}

const SELECT_CLASS =
  'rounded-md border border-border bg-surface px-2 py-1 text-[11px] text-foreground focus:border-primary focus:outline-none disabled:opacity-50'

export function HomePresetPicker({ controls }: HomePresetPickerProps): React.ReactElement | null {
  const t = useUiText()
  const { homePreset, presets, setHomePreset, captureHomeHere, homeReturn, setHomeReturn, busy } =
    controls
  const [saving, setSaving] = useState(false)

  // Not loaded yet: say nothing rather than claim "none" — an unanswered read
  // must not look like a configured absence (D315).
  if (homePreset === null) return null

  const disabled = busy || saving
  const run = (action: () => Promise<void>): void => {
    setSaving(true)
    void action().finally(() => setSaving(false))
  }

  const explanation =
    homePreset.source === 'native'
      ? 'This camera stores its own home position. “Set home here” pins it to where the camera is pointing now.'
      : homePreset.source === 'firmware'
        ? 'Taken from the camera, which names this preset as its home.'
        : homePreset.source === 'none'
          ? 'Nothing is set, so Home refuses rather than moving to an arbitrary preset.'
          : 'Pinned here. Clear it to fall back to the camera’s own home.'

  return (
    <div className="flex flex-col gap-2 px-2 pt-2">
      {homePreset.source !== 'native' && (
        <label className="flex flex-col gap-1">
          <span className="text-[10px] font-medium text-foreground-subtle">
            {t('uiLibrary.homePresetPicker.label', 'Home preset')}
          </span>
          <select
            value={homePreset.presetId ?? ''}
            disabled={disabled}
            onChange={(e) => {
              const next = e.target.value === '' ? null : e.target.value
              run(() => setHomePreset(next))
            }}
            className={SELECT_CLASS}
          >
            <option value="">
              {t('uiLibrary.homePresetPicker.notSet', 'Not set — Home is refused')}
            </option>
            {presets.map((preset) => (
              <option key={preset.id} value={preset.id}>
                {preset.fn === 'home'
                  ? t('uiLibrary.homePresetPicker.ownHome', '{{name}} (camera’s own home)', {
                      name: preset.name || preset.id,
                    })
                  : preset.name || preset.id}
              </option>
            ))}
          </select>
        </label>
      )}

      <button
        type="button"
        disabled={disabled}
        onClick={() => run(() => captureHomeHere())}
        className="self-start rounded-md border border-border px-2 py-1 text-[11px] text-foreground hover:bg-primary/10 disabled:opacity-50"
      >
        {t('uiLibrary.homePresetPicker.setHere', 'Set home here')}
      </button>

      {/* Only rendered when the camera actually HAS idle-return behaviour. A
          provider without one answers null, and null is not "off" — a camera
          that cannot return home and one that is configured not to are
          different statements, and only the second gets a switch. */}
      {homeReturn !== null && (
        <div className="flex flex-col gap-1">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={homeReturn.enabled}
              disabled={disabled}
              onChange={(e) => run(() => setHomeReturn(e.target.checked, homeReturn.seconds))}
            />
            <span className="text-[10px] font-medium text-foreground-subtle">
              {t('uiLibrary.homePresetPicker.returnIdle', 'Return home when idle')}
            </span>
          </label>
          {/* The delay stays editable while the behaviour is OFF: the camera
              keeps it either way, and clearing it on disable would lose a
              setting the operator chose. */}
          <label className="flex flex-col gap-1">
            <span className="text-[10px] font-medium text-foreground-subtle">
              {t('uiLibrary.homePresetPicker.after', 'After (s)')}
            </span>
            <input
              type="number"
              min={0}
              max={3600}
              defaultValue={homeReturn.seconds}
              disabled={disabled}
              onBlur={(e) => {
                const next = Number(e.target.value)
                if (!Number.isFinite(next) || Math.round(next) === homeReturn.seconds) return
                run(() => setHomeReturn(homeReturn.enabled, Math.round(next)))
              }}
              className={SELECT_CLASS}
            />
          </label>
        </div>
      )}

      <span className="text-[10px] text-foreground-subtle">{explanation}</span>
    </div>
  )
}
