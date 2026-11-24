/**
 * SceneSettingsForm — every knob a scene actually has, per scene.
 *
 * ## Why this exists
 *
 * The model has carried `enabled`, `triggerMode`, `checkIntervalSec`,
 * `check.threshold`, `check.hysteresisCount`, `quietSeconds`,
 * `minObservationSpacingSec`, `emit`, `autoRestore` and `confirm` since the
 * provider shipped, and `updateScene` has accepted a patch for all of them —
 * but the editor exposed **none**. Every scene therefore ran on the creation
 * defaults, and an operator whose scene fired too eagerly (or not at all) had
 * no move available except deleting it and drawing it again. Tuning knobs that
 * exist and cannot be reached are worse than absent ones: they read, from the
 * code, as a feature that shipped.
 *
 * ## What is deliberately NOT here
 *
 * `check.mode: 'llm'`. The cap declares it and the engine has an adapter seam
 * for it, but no production caller supplies `SceneEngineDeps.llm` — an
 * `llm`-mode scene reports `availability: 'unavailable'` forever. Offering the
 * switch would let an operator convert a working scene into a permanently
 * broken one in one click. The vision model reaches a scene through the
 * **`confirm`** adjudicator instead, which IS wired (`SceneConfirmGate`, built
 * unconditionally at the engine's construction site) and is the better
 * topology anyway: CLIP proposes at the poll cadence, the model is asked only
 * on a candidate flip.
 *
 * ## Editing model
 *
 * The typed knobs (name, intervals, threshold, agreeing checks, the question)
 * are a local draft that one Save writes together; Discard restores the stored
 * scene. Selects and checkboxes commit on change, because there is no
 * intermediate state worth protecting. There is no second store:
 * `updateScene` writes the authority the provider already owns and the caller
 * refetches (D62).
 */

import { Slider } from '../../primitives/slider'
import { Checkbox } from '../../primitives/checkbox'
import { Select } from '../../primitives/select'
import { DurationPartsInput } from '../duration-parts-input/DurationPartsInput'
import { FormSaveBar } from '../form-save-bar'
import type { SceneCheck, SceneMonitor, SceneUncoveredPolicy } from '@camstack/types'
import { useEffect, useRef, useState, type JSX } from 'react'
import { UiTrans, useUiText, type UiTextFn } from '../../contexts/ui-text'
import { TEXT_HINT } from '../../lib/responsive'
import { formatNumeric } from '../../lib/format-numeric'

/** The subset of `updateScene`'s patch this form can produce. */
export interface SceneSettingsPatch {
  readonly label?: string
  readonly enabled?: boolean
  readonly triggerMode?: SceneMonitor['triggerMode']
  readonly checkIntervalSec?: number
  readonly check?: SceneCheck
  readonly quietSeconds?: number
  readonly minObservationSpacingSec?: number
  readonly emit?: SceneMonitor['emit']
  readonly autoRestore?: boolean
  readonly onUncoveredCondition?: SceneUncoveredPolicy
  readonly confirm?: SceneMonitor['confirm'] | null
}

export interface SceneSettingsFormProps {
  readonly monitor: SceneMonitor
  readonly disabled: boolean
  readonly onPatch: (patch: SceneSettingsPatch) => void
}

interface Draft {
  label: string
  checkIntervalSec: number
  threshold: number
  hysteresisCount: number
  quietSeconds: number
  minObservationSpacingSec: number
  confirmPrompt: string
}

const FIELD =
  'rounded-md border border-border bg-surface px-2 py-1 text-[11px] text-foreground focus:border-primary focus:outline-none disabled:opacity-50'
const LABEL = 'text-[10px] font-medium text-foreground-subtle'
const GROUP = 'flex flex-col gap-2 rounded-md border border-border bg-surface/40 p-2'
const GROUP_TITLE = 'text-[10px] font-semibold uppercase tracking-wide text-foreground-subtle'

/** The two engine-visible interval floors, in the units the operator thinks in. */
const MIN_INTERVAL_SEC = 5
const MAX_INTERVAL_SEC = 3_600

function triggerHint(mode: SceneMonitor['triggerMode'], t: UiTextFn): string {
  switch (mode) {
    case 'periodic':
      return t(
        'uiLibrary.sceneSettingsForm.triggerHintPeriodic',
        'Only on the clock. Predictable, and it notices a change even on a camera nothing ever moves in front of.',
      )
    case 'on-motion':
      return t(
        'uiLibrary.sceneSettingsForm.triggerHintOnMotion',
        'Only after the camera has been still again for the quiet window below. Cheapest, but a change nobody walks past is never seen.',
      )
    case 'both':
      return t(
        'uiLibrary.sceneSettingsForm.triggerHintBoth',
        'Both — the clock is the safety net that lets the motion path miss. This is the right answer for almost every scene.',
      )
  }
}

function uncoveredHint(policy: SceneUncoveredPolicy, t: UiTextFn): string {
  switch (policy) {
    case 'skip':
      return t(
        'uiLibrary.sceneSettingsForm.uncoveredHintSkip',
        'Sit that light out. No verdict, no alarm, no flag touched — it picks itself back up when a light it knows returns. This is why the night capture is optional.',
      )
    case 'judge-anyway':
      return t(
        'uiLibrary.sceneSettingsForm.uncoveredHintJudge',
        'Compare against the references you do have. Only correct when the two lights genuinely look alike (a floodlit driveway, an indoor lamp) — against a real infrared frame it will report a change that did not happen.',
      )
  }
}

function draftOf(monitor: SceneMonitor): Draft {
  return {
    label: monitor.label,
    checkIntervalSec: monitor.checkIntervalSec ?? 60,
    threshold: monitor.check.mode === 'similarity' ? monitor.check.threshold : 0.8,
    hysteresisCount: monitor.check.hysteresisCount,
    quietSeconds: monitor.quietSeconds,
    minObservationSpacingSec: monitor.minObservationSpacingSec,
    confirmPrompt: monitor.confirm?.prompt ?? '',
  }
}

export function SceneSettingsForm({
  monitor,
  disabled,
  onPatch,
}: SceneSettingsFormProps): JSX.Element {
  const t = useUiText()
  const [draft, setDraft] = useState<Draft>(() => draftOf(monitor))
  // The server copy the draft was last in step with. This card re-renders on
  // every pushed runtime slice: a draft the operator has not saved is never
  // overwritten, an untouched one follows the server.
  const synced = useRef<Draft>(draft)

  useEffect(() => {
    const stored = draftOf(monitor)
    setDraft((current) => (sameDraft(current, synced.current) ? stored : current))
    synced.current = stored
  }, [monitor])

  const commit = (patch: SceneSettingsPatch): void => {
    onPatch(patch)
  }

  /** Patch the check union in place, so a mode's own fields travel with it. */
  const patchCheck = (next: Partial<{ threshold: number; hysteresisCount: number }>): SceneCheck =>
    monitor.check.mode === 'similarity'
      ? {
          mode: 'similarity',
          threshold: next.threshold ?? monitor.check.threshold,
          hysteresisCount: next.hysteresisCount ?? monitor.check.hysteresisCount,
        }
      : {
          ...monitor.check,
          hysteresisCount: next.hysteresisCount ?? monitor.check.hysteresisCount,
        }

  const confirmEnabled = monitor.confirm?.enabled === true
  const pending = pendingPatch(monitor, draft, confirmEnabled, patchCheck)
  const writeCount = Object.keys(pending).length
  const dirty = !sameDraft(draft, draftOf(monitor))
  const problem = draftProblem(monitor, draft, t)
  // A dirty draft always offers Save / Discard, even when nothing can be written yet.
  const pendingCount = dirty ? Math.max(1, writeCount) : 0
  const save = (): void => {
    if (problem !== undefined) return
    if (writeCount === 0) {
      setDraft(draftOf(monitor))
      return
    }
    setDraft((d) => ({
      ...d,
      label: d.label.trim(),
      checkIntervalSec: clamp(d.checkIntervalSec, MIN_INTERVAL_SEC, MAX_INTERVAL_SEC),
      hysteresisCount: clamp(d.hysteresisCount, 1, 10),
      quietSeconds: clamp(d.quietSeconds, 0, 3_600),
      minObservationSpacingSec: clamp(d.minObservationSpacingSec, 0, 3_600),
      confirmPrompt: d.confirmPrompt.trim(),
    }))
    commit(pending)
  }

  return (
    <div className="flex flex-col gap-2">
      {/* ── What it watches ───────────────────────────────────────────── */}
      <div className={GROUP}>
        <p className={GROUP_TITLE}>
          {t('uiLibrary.sceneSettingsForm.whatItWatches', 'What it watches')}
        </p>
        <label className="flex flex-col gap-1">
          <span className={LABEL}>{t('uiLibrary.sceneSettingsForm.name', 'Name')}</span>
          <input
            type="text"
            value={draft.label}
            disabled={disabled}
            className={FIELD}
            onChange={(e) => setDraft((d) => ({ ...d, label: e.target.value }))}
          />
        </label>

        <label className="flex items-center gap-2">
          <Checkbox
            checked={monitor.enabled}
            disabled={disabled}
            onChange={(e) => commit({ enabled: e.target.checked })}
          />
          <span className={LABEL}>{t('uiLibrary.sceneSettingsForm.watching', 'Watching')}</span>
        </label>
        <p className={TEXT_HINT}>
          {t(
            'uiLibrary.sceneSettingsForm.watchingHint',
            'Turned off, the scene keeps its region, its references and its flag — it simply stops checking. Nothing is lost by pausing one for a while.',
          )}
        </p>

        <label className="flex flex-col gap-1">
          <span className={LABEL}>
            {t('uiLibrary.sceneSettingsForm.whenToLook', 'When to look')}
          </span>
          <Select
            value={monitor.triggerMode}
            disabled={disabled}
            className={FIELD}
            onChange={(e) => {
              const value = e.target.value
              if (value === 'periodic' || value === 'on-motion' || value === 'both') {
                commit({ triggerMode: value })
              }
            }}
          >
            <option value="both">
              {t(
                'uiLibrary.sceneSettingsForm.triggerBoth',
                'On the clock and after motion settles',
              )}
            </option>
            <option value="periodic">
              {t('uiLibrary.sceneSettingsForm.triggerPeriodic', 'On the clock only')}
            </option>
            <option value="on-motion">
              {t('uiLibrary.sceneSettingsForm.triggerOnMotion', 'After motion settles only')}
            </option>
          </Select>
        </label>
        <p className={TEXT_HINT}>{triggerHint(monitor.triggerMode, t)}</p>

        <div className="flex flex-col gap-1">
          <span className={LABEL}>
            {t('uiLibrary.sceneSettingsForm.checkEvery', 'Check every (seconds)')}
          </span>
          <DurationPartsInput
            seconds={draft.checkIntervalSec}
            min={MIN_INTERVAL_SEC}
            max={MAX_INTERVAL_SEC}
            disabled={disabled}
            aria-label={t('uiLibrary.sceneSettingsForm.checkEvery', 'Check every (seconds)')}
            testIdPrefix="scene-check-every"
            onChange={(seconds) => setDraft((d) => ({ ...d, checkIntervalSec: seconds }))}
          />
        </div>
        <p className={TEXT_HINT}>
          {t(
            'uiLibrary.sceneSettingsForm.intervalHint',
            '60 s suits “is the bin still out”. Every check costs one photograph and one encode, so going below about 30 s buys latency you almost never need and multiplies the cost by the number of scenes you own.',
          )}
        </p>
      </div>

      {/* ── How sure it has to be ─────────────────────────────────────── */}
      <div className={GROUP}>
        <p className={GROUP_TITLE}>
          {t('uiLibrary.sceneSettingsForm.howSure', 'How sure it has to be')}
        </p>

        {monitor.check.mode === 'similarity' && (
          <>
            <label className="flex flex-col gap-1">
              <span className={LABEL}>
                <UiTrans
                  uiKey="uiLibrary.sceneSettingsForm.matchThreshold"
                  fallback="Match threshold — <0>{{value}}</0>"
                  components={[<span key="value" className="tabular-nums" />]}
                  values={{ value: formatNumeric(draft.threshold, undefined) }}
                />
              </span>
              <Slider
                min={0.3}
                max={0.99}
                step={0.01}
                value={draft.threshold}
                disabled={disabled}
                onChange={(e) => setDraft((d) => ({ ...d, threshold: Number(e.target.value) }))}
              />
            </label>
            <p className={TEXT_HINT}>
              {t(
                'uiLibrary.sceneSettingsForm.thresholdHint',
                'How closely the region still has to resemble the photograph to count as unchanged. Higher means fussier: at 0.95 a passing cloud can read as a change; at 0.60 the bin can be taken and the scene will shrug. 0.80 is a sensible start — if it cries wolf, lower it; if it misses the thing you care about, raise it.',
              )}
            </p>
          </>
        )}

        <label className="flex flex-col gap-1">
          <span className={LABEL}>
            {t(
              'uiLibrary.sceneSettingsForm.agreeingChecks',
              'Agreeing checks before it changes its mind',
            )}
          </span>
          <input
            type="number"
            min={1}
            max={10}
            value={draft.hysteresisCount}
            disabled={disabled}
            className={FIELD}
            onChange={(e) =>
              setDraft((d) => ({
                ...d,
                hysteresisCount: Number(e.target.value) || 1,
              }))
            }
          />
        </label>
        <p className={TEXT_HINT}>
          {t(
            'uiLibrary.sceneSettingsForm.agreeingHint',
            'One bad photograph must never be able to flip a scene. 3 agreeing checks at 60 s is about four minutes of latency and is what makes the answer trustworthy — leaving a state costs exactly the same as entering one.',
          )}
        </p>

        <div className="flex flex-col gap-1">
          <span className={LABEL}>
            {t('uiLibrary.sceneSettingsForm.quietFor', 'Quiet for (seconds) before a check counts')}
          </span>
          <DurationPartsInput
            seconds={draft.quietSeconds}
            min={0}
            max={3_600}
            disabled={disabled}
            aria-label={t(
              'uiLibrary.sceneSettingsForm.quietFor',
              'Quiet for (seconds) before a check counts',
            )}
            testIdPrefix="scene-quiet-for"
            onChange={(seconds) => setDraft((d) => ({ ...d, quietSeconds: seconds }))}
          />
        </div>
        <p className={TEXT_HINT}>
          {t(
            'uiLibrary.sceneSettingsForm.quietHint',
            'A check taken while something is moving is a photograph of the van parked in front of the bin, so it is discarded rather than merely delayed. 0 disables the gate.',
          )}
        </p>

        <div className="flex flex-col gap-1">
          <span className={LABEL}>
            {t(
              'uiLibrary.sceneSettingsForm.minGap',
              'Minimum gap between counted checks (seconds)',
            )}
          </span>
          <DurationPartsInput
            seconds={draft.minObservationSpacingSec}
            min={0}
            max={3_600}
            disabled={disabled}
            aria-label={t(
              'uiLibrary.sceneSettingsForm.minGap',
              'Minimum gap between counted checks (seconds)',
            )}
            testIdPrefix="scene-min-gap"
            onChange={(seconds) => setDraft((d) => ({ ...d, minObservationSpacingSec: seconds }))}
          />
        </div>
        <p className={TEXT_HINT}>
          {t(
            'uiLibrary.sceneSettingsForm.minGapHint',
            'Spreads the agreeing checks over real time instead of letting three adjacent polls inside one long occlusion be mistaken for three independent opinions.',
          )}
        </p>
      </div>

      {/* ── Lighting ─────────────────────────────────────────────────── */}
      <div className={GROUP}>
        <p className={GROUP_TITLE}>{t('uiLibrary.sceneSettingsForm.lighting', 'Lighting')}</p>
        <label className="flex flex-col gap-1">
          <span className={LABEL}>
            {t(
              'uiLibrary.sceneSettingsForm.noReference',
              'When a light has no reference of its own',
            )}
          </span>
          <Select
            value={monitor.onUncoveredCondition}
            disabled={disabled}
            className={FIELD}
            onChange={(e) => {
              const value = e.target.value
              if (value === 'skip' || value === 'judge-anyway') {
                commit({ onUncoveredCondition: value })
              }
            }}
          >
            <option value="skip">
              {t('uiLibrary.sceneSettingsForm.uncoveredSkip', 'Skip the check (recommended)')}
            </option>
            <option value="judge-anyway">
              {t(
                'uiLibrary.sceneSettingsForm.uncoveredJudge',
                'Judge against the other light anyway',
              )}
            </option>
          </Select>
        </label>
        <p className={TEXT_HINT}>{uncoveredHint(monitor.onUncoveredCondition, t)}</p>
      </div>

      {/* ── What you get told ────────────────────────────────────────── */}
      <div className={GROUP}>
        <p className={GROUP_TITLE}>
          {t('uiLibrary.sceneSettingsForm.whatYouGetTold', 'What you get told')}
        </p>
        <label className="flex flex-col gap-1">
          <span className={LABEL}>
            {t('uiLibrary.sceneSettingsForm.notificationsFollow', 'Notifications follow')}
          </span>
          <Select
            value={monitor.emit}
            disabled={disabled}
            className={FIELD}
            onChange={(e) => {
              const value = e.target.value
              if (value === 'latched' || value === 'live') commit({ emit: value })
            }}
          >
            <option value="latched">
              {t(
                'uiLibrary.sceneSettingsForm.emitLatched',
                'The flag — told once, still visible at breakfast',
              )}
            </option>
            <option value="live">
              {t(
                'uiLibrary.sceneSettingsForm.emitLive',
                'The live state — follows the region as it changes',
              )}
            </option>
          </Select>
        </label>
        <p className={TEXT_HINT}>
          {t(
            'uiLibrary.sceneSettingsForm.emitHint',
            '“Is the bin gone” is a flag: you want to be told once and still see it later. “Is the gate open” is a live state.',
          )}
        </p>

        <label className="flex items-center gap-2">
          <Checkbox
            checked={monitor.autoRestore}
            disabled={disabled}
            onChange={(e) => commit({ autoRestore: e.target.checked })}
          />
          <span className={LABEL}>
            {t(
              'uiLibrary.sceneSettingsForm.autoRestore',
              'Clear the flag by itself when things look normal again',
            )}
          </span>
        </label>
        <p className={TEXT_HINT}>
          {t(
            'uiLibrary.sceneSettingsForm.autoRestoreHint',
            'Off by default, so an alarm never silently clears itself. The “back to normal” moment is recorded either way, so an automation can still react to it.',
          )}
        </p>
      </div>

      {/* ── AI double-check ──────────────────────────────────────────── */}
      <div className={GROUP}>
        <p className={GROUP_TITLE}>
          {t('uiLibrary.sceneSettingsForm.aiDoubleCheck', 'AI double-check')}
        </p>
        <label className="flex items-center gap-2">
          <Checkbox
            checked={confirmEnabled}
            disabled={disabled || draft.confirmPrompt.trim().length === 0}
            onChange={(e) =>
              commit(
                e.target.checked
                  ? {
                      confirm: {
                        ...defaultConfirm(draft.confirmPrompt.trim()),
                        enabled: true,
                      },
                    }
                  : { confirm: null },
              )
            }
          />
          <span className={LABEL}>
            {t(
              'uiLibrary.sceneSettingsForm.askVision',
              'Ask a vision model before changing the answer',
            )}
          </span>
        </label>
        <label className="flex flex-col gap-1">
          <span className={LABEL}>
            {t('uiLibrary.sceneSettingsForm.question', 'The question to ask')}
          </span>
          <input
            type="text"
            value={draft.confirmPrompt}
            placeholder={t(
              'uiLibrary.sceneSettingsForm.questionPlaceholder',
              'e.g. Is the wheelie bin still there?',
            )}
            disabled={disabled}
            className={FIELD}
            onChange={(e) => setDraft((d) => ({ ...d, confirmPrompt: e.target.value }))}
          />
        </label>
        <p className={TEXT_HINT}>
          <UiTrans
            uiKey="uiLibrary.sceneSettingsForm.confirmHint"
            fallback="The model is asked <0>only</0> when the region has already changed enough to flip the answer — roughly twice a week for a bin, not once a minute. It reasons about the object rather than the pixels, so rain, shadows and a repositioned bin stop counting as the thing being taken. If it cannot be reached, the change is held rather than announced."
            components={[<strong key="only" />]}
          />
        </p>
      </div>

      <FormSaveBar
        pendingCount={pendingCount}
        saving={disabled}
        problem={problem}
        onSave={save}
        onDiscard={() => setDraft(draftOf(monitor))}
      />
    </div>
  )
}

/** Whether two drafts hold the same values. */
function sameDraft(a: Draft, b: Draft): boolean {
  return (
    a.label === b.label &&
    a.checkIntervalSec === b.checkIntervalSec &&
    a.threshold === b.threshold &&
    a.hysteresisCount === b.hysteresisCount &&
    a.quietSeconds === b.quietSeconds &&
    a.minObservationSpacingSec === b.minObservationSpacingSec &&
    a.confirmPrompt === b.confirmPrompt
  )
}

/** Why the draft cannot be saved, or `undefined` when it can. */
function draftProblem(monitor: SceneMonitor, draft: Draft, t: UiTextFn): string | undefined {
  if (draft.label.trim().length === 0) {
    return t('uiLibrary.sceneSettingsForm.nameRequired', 'The scene needs a name.')
  }
  if (monitor.confirm !== undefined && draft.confirmPrompt.trim().length === 0) {
    return t(
      'uiLibrary.sceneSettingsForm.questionRequired',
      'The confirmation question cannot be empty.',
    )
  }
  return undefined
}

/** What Save would write: only the fields whose draft differs from the stored scene. */
function pendingPatch(
  monitor: SceneMonitor,
  draft: Draft,
  confirmEnabled: boolean,
  patchCheck: (next: Partial<{ threshold: number; hysteresisCount: number }>) => SceneCheck,
): SceneSettingsPatch {
  const label = draft.label.trim()
  const interval = clamp(draft.checkIntervalSec, MIN_INTERVAL_SEC, MAX_INTERVAL_SEC)
  const hysteresis = clamp(draft.hysteresisCount, 1, 10)
  const quiet = clamp(draft.quietSeconds, 0, 3_600)
  const spacing = clamp(draft.minObservationSpacingSec, 0, 3_600)
  const prompt = draft.confirmPrompt.trim()
  const storedThreshold = monitor.check.mode === 'similarity' ? monitor.check.threshold : null
  const thresholdChanged = storedThreshold !== null && draft.threshold !== storedThreshold
  const hysteresisChanged = hysteresis !== monitor.check.hysteresisCount
  return {
    ...(label.length > 0 && label !== monitor.label ? { label } : {}),
    ...(interval !== monitor.checkIntervalSec ? { checkIntervalSec: interval } : {}),
    ...(thresholdChanged || hysteresisChanged
      ? {
          check: patchCheck({
            ...(thresholdChanged ? { threshold: draft.threshold } : {}),
            hysteresisCount: hysteresis,
          }),
        }
      : {}),
    ...(quiet !== monitor.quietSeconds ? { quietSeconds: quiet } : {}),
    ...(spacing !== monitor.minObservationSpacingSec ? { minObservationSpacingSec: spacing } : {}),
    ...(prompt.length > 0 && prompt !== monitor.confirm?.prompt
      ? { confirm: { ...defaultConfirm(prompt), enabled: confirmEnabled } }
      : {}),
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/** The adjudicator's own defaults, restated here because a Zod `.default()`
 *  does not run on the cap path — the provider receives exactly this object. */
function defaultConfirm(prompt: string): NonNullable<SceneMonitor['confirm']> {
  return {
    enabled: false,
    prompt,
    timeoutMs: 8_000,
    maxImagePx: 448,
    onTimeout: 'hold',
  }
}
