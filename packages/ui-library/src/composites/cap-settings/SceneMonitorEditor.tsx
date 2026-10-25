/**
 * SceneMonitorEditor — the per-camera half of the Scenes surface.
 *
 * **Imported directly, not resolved as a widget.** It briefly lived behind the
 * host widget `host/scene-monitor-editor`, mounted as a "Scenes" tab on one
 * camera's detail page. That put a standing question about the property ("is
 * the bin still out") one camera deep, where the operator's actual question —
 * "which of my scenes have tripped" — could not be asked at all. The overview
 * is now the top-level `/scenes` page; this component is what that page opens
 * once a camera is chosen, in a dialog. The widget id and its `deviceConfig`
 * declaration are both gone, in the same commit, because
 * `scripts/check-host-widget-resolves.ts` checks both directions.
 *
 * It renders BARE — no `WidgetPanel` — because its only caller supplies a
 * dialog header, and two stacked titles read as a layout bug.
 *
 * ## The flow, in the order the operator meets it
 *
 * 1. **Draw a region on the still frame.** A rect over a SNAPSHOT, not the live
 *    player: a scene is defined against a photograph, and drawing on a moving
 *    picture makes it impossible to see whether the box actually contains the
 *    bin. The editor starts in draw mode and warns above ~40 % of the frame,
 *    because a full-frame scene is dominated by weather, sky and parked cars —
 *    it will not work, and it will look broken rather than misconfigured.
 * 2. **Capture the initial state, per lighting variant.** Two buttons, Daylight
 *    and Night (IR), each forcing a fresh snapshot. The variant is DETECTED
 *    from the frame and shown rather than asked; the buttons exist so the
 *    operator can say "capture this as the night reference" while standing
 *    outside at 22:00 — which is exactly why **Night (IR) is labelled
 *    optional**. Almost nobody does that, and a scene captured only in daylight
 *    is a configuration, not a defect: under the default
 *    `onUncoveredCondition: 'skip'` the infrared hours are simply sat out.
 * 3. **Read the coverage line.** "Daylight ✓ · Night (IR) ✗ — optional; checks
 *    in night (ir) are skipped". This feature's failure mode is silence that
 *    reads as "nothing has happened", and that one line is the difference
 *    between a five-minute fix and a session of guessing — but it must say what
 *    HAPPENS, not complain. It used to end "reports 'can't tell'", which made a
 *    correctly configured scene look broken every night.
 * 4. **Reset.** Clears the flag AND re-captures the baseline for the current
 *    light, because the bin never goes back in exactly the same spot.
 * 5. **Settings.** Every knob the model has actually carried since the provider
 *    shipped — how often it looks, how closely it has to match, how many
 *    agreeing checks a change costs, what a missing light means, which boolean
 *    drives notifications, and whether a vision model adjudicates a flip. None
 *    of it was reachable before; see `SceneSettingsForm`.
 *
 * Live state arrives through the cap's `status.kind: 'push'` runtime slice, so
 * the card updates itself without polling.
 */

import { useUiText } from '../../contexts/ui-text'
import type { MaskShape, SceneMonitor, SceneMonitorStatus } from '@camstack/types'
import { Camera, RotateCcw, Settings2, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react'
import { useSystem } from '../../contexts/system-context'
import { useDeviceProxy, useDeviceStateSlice } from '../../hooks/use-device-proxy'
import { useDeviceSnapshotImage } from '../../hooks/use-device-snapshot'
import { isAbsentProvider } from '../../lib/cap-error'
import { TEXT_HINT } from '../../lib/responsive'
import { MaskShapeCanvas, type MaskShapeItem } from './MaskShapeCanvas'
import { SceneReferenceGallery } from './SceneReferenceGallery'
import { SceneSettingsForm, type SceneSettingsPatch } from './SceneSettingsForm'
import {
  badgeFor,
  coverageLine,
  roiTooLarge,
  SCENE_CAPTURE_VARIANTS,
  SCENE_OPTIONAL_VARIANT,
  statusLine,
  variantLabel,
} from './scene-monitor-copy'

const BTN_NEUTRAL =
  'rounded-md border border-border bg-surface px-2 py-1 text-[11px] font-medium text-foreground-subtle hover:bg-surface-hover disabled:opacity-40 transition-colors'
const BTN_PRIMARY =
  'rounded-md border border-primary/50 bg-primary/15 px-2.5 py-1 text-[11px] font-medium text-primary hover:bg-primary/25 disabled:opacity-40 transition-colors'
const BTN_DANGER =
  'rounded-md border border-danger/50 bg-danger/10 px-2 py-1 text-[11px] font-medium text-danger hover:bg-danger/20 disabled:opacity-40 transition-colors'

const TONE_CLASS: Readonly<Record<'alarm' | 'ok' | 'unknown', string>> = {
  alarm: 'border-danger/50 bg-danger/15 text-danger',
  ok: 'border-success/50 bg-success/15 text-success',
  unknown: 'border-border bg-surface text-foreground-subtle',
}

/** A scene without at least one reference cannot judge anything, so the
 *  similarity threshold only becomes meaningful after the first capture. */
const DEFAULT_THRESHOLD = 0.8
const DEFAULT_HYSTERESIS = 3

export interface SceneMonitorEditorProps {
  readonly deviceId: number
}

export function SceneMonitorEditor({ deviceId }: SceneMonitorEditorProps): JSX.Element | null {
  const t = useUiText()
  const system = useSystem()
  const dev = useDeviceProxy(system.trpcClient, deviceId)
  const pushed = useDeviceStateSlice<SceneMonitorStatus>(dev?.state.sceneMonitor)
  const snapshot = useDeviceSnapshotImage(deviceId, { width: 640 })

  const [fetched, setFetched] = useState<SceneMonitorStatus | null>(null)
  const [unsupported, setUnsupported] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  /** Which scene has its settings panel open — one at a time, because the panel
   *  is tall and a wall of them would bury the list it belongs to. */
  const [tuningId, setTuningId] = useState<string | null>(null)
  const [drafting, setDrafting] = useState(false)
  const [draftRoi, setDraftRoi] = useState<SceneMonitor['roi'] | null>(null)
  const [draftLabel, setDraftLabel] = useState('')
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const reload = useCallback(async (): Promise<void> => {
    if (!dev) return
    try {
      const status = await dev.sceneMonitor?.listScenes({})
      if (!mounted.current) return
      if (status) setFetched(status)
    } catch (err: unknown) {
      if (!mounted.current) return
      if (isAbsentProvider(err)) setUnsupported(true)
      else setError(err instanceof Error ? err.message : String(err))
    }
  }, [dev])

  useEffect(() => {
    setFetched(null)
    setUnsupported(false)
    setError(null)
    void reload()
  }, [reload])

  // The PUSHED slice wins when present — it is the live one. The fetched copy
  // covers the window before the first push, which on a freshly booted hub is
  // however long it takes the first check to run.
  const monitors: readonly SceneMonitor[] = pushed?.monitors ?? fetched?.monitors ?? []
  const now = Date.now()

  const run = useCallback(
    async (key: string, fn: () => Promise<unknown>): Promise<void> => {
      setBusy(key)
      setError(null)
      try {
        await fn()
        await reload()
      } catch (err: unknown) {
        if (mounted.current) setError(err instanceof Error ? err.message : String(err))
      } finally {
        if (mounted.current) setBusy(null)
      }
    },
    [reload],
  )

  const items = useMemo<MaskShapeItem[]>(() => {
    const existing = monitors.map((m) => ({
      id: m.id,
      shape: m.roi,
      label: m.label,
      enabled: m.enabled,
    }))
    return draftRoi !== null
      ? [
          ...existing,
          {
            id: '__draft__',
            shape: draftRoi,
            label: t('uiLibrary.sceneMonitor.newSceneLabel', 'New scene'),
          },
        ]
      : existing
  }, [monitors, draftRoi, t])

  const onShapeChange = useCallback(
    (id: string | number, shape: MaskShape): void => {
      if (shape.kind !== 'rect') return
      if (id === '__draft__') {
        setDraftRoi(shape)
        return
      }
      // An ROI edit on a SAVED scene is written immediately: there is no draft
      // list here, so a "save" button would be a second source of truth over a
      // rectangle the canvas already owns.
      void run(`roi-${String(id)}`, async () =>
        dev?.sceneMonitor?.updateScene({ monitorId: String(id), patch: { roi: shape } }),
      )
    },
    [dev, run],
  )

  const onDrawComplete = useCallback((shape: MaskShape): void => {
    if (shape.kind !== 'rect') return
    setDraftRoi(shape)
  }, [])

  const createScene = useCallback(async (): Promise<void> => {
    if (draftRoi === null || draftLabel.trim().length === 0) return
    await run('create', async () => {
      await dev?.sceneMonitor?.createScene({
        label: draftLabel.trim(),
        roi: draftRoi,
        check: {
          mode: 'similarity',
          threshold: DEFAULT_THRESHOLD,
          hysteresisCount: DEFAULT_HYSTERESIS,
        },
      })
    })
    setDraftRoi(null)
    setDraftLabel('')
    setDrafting(false)
  }, [dev, draftRoi, draftLabel, run])

  if (!dev) return null

  return (
    <div className="flex flex-col gap-3">
      {unsupported ? (
        <p className={`${TEXT_HINT} leading-relaxed`}>
          {t(
            'uiLibrary.sceneMonitor.unsupported',
            'Scene monitoring is not available for this camera.',
          )}
        </p>
      ) : (
        <>
          <p className={`${TEXT_HINT} leading-relaxed`}>
            {t(
              'uiLibrary.sceneMonitor.intro',
              'A scene watches one region of this camera and tells you when it stops looking like the picture you captured. Draw a box around the thing you care about — a wheelie bin, a gate, a parking space — then capture what “normal” looks like. Daylight is enough to start: the night reference is optional, and without it the scene simply sits the infrared hours out instead of reporting a problem.',
            )}
          </p>

          <div className="relative overflow-hidden rounded-md border border-border">
            <MaskShapeCanvas
              items={items}
              supportedShapes={['rect']}
              selectedId={selectedId ?? (draftRoi !== null ? '__draft__' : null)}
              onSelect={(id) => setSelectedId(id === null ? null : String(id))}
              onShapeChange={onShapeChange}
              onDrawComplete={onDrawComplete}
              drawingKind={drafting && draftRoi === null ? 'rect' : null}
              backdrop={
                snapshot.src !== null ? (
                  <img
                    src={snapshot.src}
                    alt=""
                    className="h-full w-full object-contain"
                    draggable={false}
                  />
                ) : null
              }
            />
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className={drafting ? BTN_PRIMARY : BTN_NEUTRAL}
              aria-pressed={drafting}
              onClick={() => {
                setDrafting((v) => !v)
                setDraftRoi(null)
              }}
              disabled={busy !== null}
            >
              {drafting
                ? t('uiLibrary.sceneMonitor.cancel', 'Cancel')
                : t('uiLibrary.sceneMonitor.newScene', '+ New scene')}
            </button>
            <button
              type="button"
              className={BTN_NEUTRAL}
              onClick={snapshot.refresh}
              disabled={busy !== null}
            >
              {t('uiLibrary.sceneMonitor.refresh', 'Refresh frame')}
            </button>
          </div>

          {drafting && (
            <div className="flex flex-col gap-2 rounded-md border border-border bg-surface p-2">
              <p className={TEXT_HINT}>
                {draftRoi === null
                  ? t(
                      'uiLibrary.sceneMonitor.draftHint',
                      'Click on the frame to drop a box, then drag its corner to fit it around the thing you want watched.',
                    )
                  : t(
                      'uiLibrary.sceneMonitor.nameHint',
                      'Name it, then create. You capture what “normal” looks like next.',
                    )}
              </p>
              {draftRoi !== null && roiTooLarge(draftRoi) && (
                <p className="text-[11px] leading-relaxed text-warning">
                  {t(
                    'uiLibrary.sceneMonitor.tooLarge',
                    'That box covers most of the frame. A scene that big is dominated by the weather, the sky and passing cars — it will quietly stop noticing the thing you actually care about. Draw it tighter.',
                  )}
                </p>
              )}
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={draftLabel}
                  onChange={(e) => setDraftLabel(e.target.value)}
                  placeholder={t('uiLibrary.sceneMonitor.placeholder', 'e.g. Immondizia prelevata')}
                  className="flex-1 rounded-md border border-border bg-surface px-2 py-1 text-[12px] text-foreground"
                />
                <button
                  type="button"
                  className={BTN_PRIMARY}
                  onClick={() => void createScene()}
                  disabled={draftRoi === null || draftLabel.trim().length === 0 || busy !== null}
                >
                  {t('uiLibrary.sceneMonitor.create', 'Create')}
                </button>
              </div>
            </div>
          )}

          {error !== null && <p className="text-[11px] leading-relaxed text-danger">{error}</p>}

          {monitors.length === 0 ? (
            <p className={`${TEXT_HINT} leading-relaxed`}>
              {t('uiLibrary.sceneMonitor.empty', 'No scenes on this camera yet.')}
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {monitors.map((m) => {
                const badge = badgeFor(m, t)
                return (
                  <li
                    key={m.id}
                    className={`flex flex-col gap-1.5 rounded-md border p-2 ${
                      selectedId === m.id ? 'border-primary/50' : 'border-border'
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        className="flex-1 text-left text-[12px] font-medium text-foreground"
                        onClick={() => setSelectedId(m.id)}
                      >
                        {m.label}
                      </button>
                      <span
                        className={`rounded border px-1.5 py-0.5 text-[10px] font-medium ${TONE_CLASS[badge.tone]}`}
                      >
                        {badge.text}
                      </span>
                    </div>

                    <p className={`${TEXT_HINT} leading-relaxed`}>{statusLine(m, now, t)}</p>
                    <p className={`${TEXT_HINT} tabular-nums`}>{coverageLine(m, t)}</p>

                    {/* The photographs themselves. A count cannot tell the
                        operator WHICH capture was taken while a van was in the
                        way, and a cosine score never will either. */}
                    <SceneReferenceGallery
                      monitor={m}
                      disabled={busy !== null}
                      onDelete={({ stateId, index }) =>
                        void run(`refdel-${m.id}-${stateId}-${String(index)}`, async () =>
                          dev.sceneMonitor?.deleteReference({
                            monitorId: m.id,
                            stateId,
                            index,
                          }),
                        )
                      }
                    />

                    <div className="flex flex-wrap items-center gap-1.5">
                      {SCENE_CAPTURE_VARIANTS.map((variant) => {
                        const optional = variant === SCENE_OPTIONAL_VARIANT
                        return (
                          <button
                            key={variant}
                            type="button"
                            className={BTN_NEUTRAL}
                            disabled={busy !== null}
                            title={
                              optional
                                ? // The operator's complaint, answered on the control
                                  // itself: nobody stands outside at 22:00 for this, and
                                  // the scene must not imply that they should.
                                  t(
                                    'uiLibrary.sceneMonitor.optionalTitle',
                                    'Optional. Without a night reference the checks in infrared are simply skipped — the scene keeps working in daylight and nothing is reported as broken.',
                                  )
                                : t(
                                    'uiLibrary.sceneMonitor.captureTitle',
                                    'Take a fresh photo now and store it as the {{variant}} reference',
                                    { variant: variantLabel(variant, t).toLowerCase() },
                                  )
                            }
                            onClick={() =>
                              void run(`cap-${m.id}-${variant}`, async () =>
                                dev.sceneMonitor?.captureReference({
                                  monitorId: m.id,
                                  condition: variant,
                                }),
                              )
                            }
                          >
                            <Camera className="mr-1 inline h-3 w-3" />
                            {t('uiLibrary.sceneMonitor.capture', 'Capture {{variant}}', {
                              variant: variantLabel(variant, t).toLowerCase(),
                            })}
                            {optional && (
                              <span className="ml-1 text-foreground-subtle/70">
                                {t('uiLibrary.sceneMonitor.optional', '(optional)')}
                              </span>
                            )}
                          </button>
                        )
                      })}
                      <button
                        type="button"
                        className={BTN_PRIMARY}
                        disabled={busy !== null || m.states.length === 0}
                        title={t(
                          'uiLibrary.sceneMonitor.resetTitle',
                          'Clear the flag and re-photograph what normal looks like right now',
                        )}
                        onClick={() =>
                          void run(`reset-${m.id}`, async () =>
                            dev.sceneMonitor?.resetScene({ monitorId: m.id }),
                          )
                        }
                      >
                        <RotateCcw className="mr-1 inline h-3 w-3" />
                        {t('uiLibrary.sceneMonitor.reset', 'Reset')}
                      </button>
                      <button
                        type="button"
                        className={BTN_NEUTRAL}
                        disabled={busy !== null}
                        onClick={() =>
                          void run(`check-${m.id}`, async () =>
                            dev.sceneMonitor?.recheckNow({ monitorId: m.id }),
                          )
                        }
                      >
                        {t('uiLibrary.sceneMonitor.checkNow', 'Check now')}
                      </button>
                      <button
                        type="button"
                        className={tuningId === m.id ? BTN_PRIMARY : BTN_NEUTRAL}
                        aria-pressed={tuningId === m.id}
                        aria-label={t(
                          'uiLibrary.sceneMonitor.settingsFor',
                          'Settings for {{label}}',
                          {
                            label: m.label,
                          },
                        )}
                        disabled={busy !== null}
                        onClick={() => setTuningId((id) => (id === m.id ? null : m.id))}
                      >
                        <Settings2 className="mr-1 inline h-3 w-3" />
                        {t('uiLibrary.sceneMonitor.settings', 'Settings')}
                      </button>
                      <button
                        type="button"
                        className={BTN_DANGER}
                        disabled={busy !== null}
                        onClick={() =>
                          void run(`del-${m.id}`, async () =>
                            dev.sceneMonitor?.deleteScene({ monitorId: m.id }),
                          )
                        }
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    </div>

                    {tuningId === m.id && (
                      <SceneSettingsForm
                        monitor={m}
                        disabled={busy !== null}
                        onPatch={(patch: SceneSettingsPatch) =>
                          void run(`tune-${m.id}`, async () =>
                            dev.sceneMonitor?.updateScene({ monitorId: m.id, patch }),
                          )
                        }
                      />
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </>
      )}
    </div>
  )
}
