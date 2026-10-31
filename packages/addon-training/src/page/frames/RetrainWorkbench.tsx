/**
 * The frame workbench — one frame of the retrain corpus on the canvas, its
 * subjects beside it, and every control that edits them.
 *
 * It addresses a frame by the frame alone: its own camera (`frame.deviceId`),
 * its own track when it has one, and its id. The assist resolves the detector
 * of THAT frame's camera.
 *
 * **Layout.** A flex column that FILLS the modal and never scrolls: summary
 * strip, then the canvas pane (toolbar, the frame fitted into whatever is left,
 * the action bar) beside the subject list. Below `lg` the list is a drawer over
 * the canvas, opened from the action bar. Only the list scrolls, on its own.
 *
 * **What it owns:** the stored annotations of the open frame, the editor (with
 * undo history), the viewport, the keyboard, hover, propose, save and the
 * "all subjects boxed" tick. **What it does not:** which frames exist and which
 * one is open — the Frames tab owns that and is told when the operator steps.
 *
 * **What it protects:** unsaved edits. A background refetch never re-seeds a
 * dirty editor; a revision conflict keeps the operator's edits on screen and
 * offers the latest version instead of replacing them.
 */

import { useT } from '../../i18n/index.js'
import { parseRetrainRevisionConflict, type RetrainFrame } from '@camstack/types'
import {
  Badge,
  Button,
  hubPath,
  IconButton,
  usePipelineAnalyticsListRetrainAnnotations,
  usePipelineAnalyticsProposeRetrainAnnotations,
  usePipelineAnalyticsSaveRetrainAnnotations,
  usePipelineAnalyticsSetRetrainFrameComplete,
} from '@camstack/ui-library'
import { ChevronDown, ChevronRight, Loader2, Sparkles } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { frameAddress } from './frame-address.js'
import { useAuthedImage } from './lib/authed-image.js'
import type { NormBox } from './lib/retrain-boxes.js'
import { editorSignature, isEditorDirty } from './lib/retrain-dirty.js'
import {
  acceptAllDrafts,
  acceptBox,
  addDrafts,
  addOperatorBox,
  deleteBox,
  type EditorBoxInput,
  type EditorState,
  markModelError,
  pendingDraftCount,
  seedEditor,
  selectBox,
  toSaveDismissed,
  toSavePayload,
  updateBox,
} from './lib/retrain-editor.js'
import { type Hover, hoverAfterBoxesChange } from './lib/retrain-hover.js'
import { liveReview } from './lib/retrain-live-review.js'
import { buildVocabulary } from './lib/retrain-vocabulary.js'
import { RetrainActionBar } from './RetrainActionBar.js'
import { annotationsAreValid, RetrainAnnotationEditor } from './RetrainAnnotationEditor.js'
import { RetrainAssistPanel } from './RetrainAssistPanel.js'
import { RetrainCanvas } from './RetrainCanvas.js'
import { RetrainCanvasToolbar, useRetrainViewport } from './RetrainCanvasToolbar.js'
import { RetrainEditorSummary } from './RetrainEditorSummary.js'
import { useAssistDetector } from './use-assist-detector.js'
import { useRetrainEditorHistory } from './use-retrain-editor-history.js'
import { useRetrainShortcuts } from './use-retrain-shortcuts.js'
import { useUnsavedGuard } from './use-unsaved-guard.js'

/** What a freshly drawn box starts as, before the operator names it. */
const NEW_ANNOTATION_MACRO = 'person'

export interface RetrainWorkbenchProps {
  /** The frames of the open page, in order — the vocabulary is read from them. */
  readonly frames: readonly RetrainFrame[]
  readonly activeFrameId: string
  /** "3 of 120" — the open frame's place in the whole filtered corpus. */
  readonly framePosition: string
  /** Is there a frame in that direction (across pages)? */
  readonly canStep: (step: 1 | -1) => boolean
  /** Open the neighbouring frame. The workbench has already asked about unsaved edits. */
  readonly onStep: (step: 1 | -1) => void
  /** The list changed (a frame was ticked complete): refetch it. */
  readonly onFramesChanged: () => Promise<unknown>
  /** Annotations were saved: refresh whatever counts them. */
  readonly onSaved?: () => Promise<unknown>
  /** Whether the open frame has unsaved edits — the dialog guards its close on it. */
  readonly onDirtyChange?: (dirty: boolean) => void
  readonly setNotice: (text: string | null) => void
}

export function RetrainWorkbench({
  frames,
  activeFrameId,
  framePosition,
  canStep,
  onStep,
  onFramesChanged,
  onSaved,
  onDirtyChange,
  setNotice,
}: RetrainWorkbenchProps) {
  const { t } = useT()
  const rootRef = useRef<HTMLDivElement | null>(null)
  const activeCopy = frames.find((c) => c.frameId === activeFrameId)
  const deviceId = activeCopy?.deviceId ?? null

  const history = useRetrainEditorHistory(() => seedEditor([], []))
  const { editor, setEditor, resetEditor, selectOnly } = history
  const view = useRetrainViewport()
  const [hover, setHover] = useState<Hover | null>(null)
  const [showRemoved, setShowRemoved] = useState(true)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [assistOpen, setAssistOpen] = useState(false)
  const [conflict, setConflict] = useState<number | null>(null)

  const storedAnnotations = usePipelineAnalyticsListRetrainAnnotations({
    frameIds: [activeFrameId],
  })
  // The corpus vocabulary the label field suggests from — the annotations of
  // the open page, which the page can already see; no new method.
  const pageFrameIds = useMemo(() => frames.map((f) => f.frameId), [frames])
  const vocabularySource = usePipelineAnalyticsListRetrainAnnotations(
    { frameIds: pageFrameIds },
    { enabled: pageFrameIds.length > 0, staleTime: 60_000 },
  )
  const vocabulary = useMemo(
    () => buildVocabulary(vocabularySource.data ?? []),
    [vocabularySource.data],
  )

  // The pixels come over the admin `retrain-frame` data plane (D613), not as
  // base64 inside a cap answer; the frame row already carries the URL.
  const frameImage = useAuthedImage(
    activeCopy?.imageUrl !== undefined ? hubPath(activeCopy.imageUrl) : undefined,
  )
  const propose = usePipelineAnalyticsProposeRetrainAnnotations()
  const saveAnnotations = usePipelineAnalyticsSaveRetrainAnnotations()
  const setFrameComplete = usePipelineAnalyticsSetRetrainFrameComplete()
  const { detector: assistDetector, schema: nodeSchema } = useAssistDetector(deviceId)

  /**
   * The editor is seeded from the SERVER's annotations for the open frame, plus
   * the boxes the pipeline drew on it as drafts — never merged with what was on
   * screen. Re-seeded when the frame changes or its stored annotations change
   * after a save or a reload; a refetch that lands while the operator has
   * unsaved edits (window focus, another surface) must NOT replace them, so a
   * dirty editor of the same frame keeps what is on screen.
   */
  const seedInputs = useRef({ stored: storedAnnotations.data, copy: activeCopy })
  seedInputs.current = { stored: storedAnnotations.data, copy: activeCopy }
  const baseline = useRef(editorSignature(seedEditor([], [])))
  const dirty = isEditorDirty(editor, baseline.current)
  // What the last seed put on screen. A pre-answered box makes the editor dirty
  // against the baseline from the start, but that is not the operator's edit:
  // only a change away from the seed itself blocks a re-seed.
  const seededSignature = useRef(baseline.current)
  const editedRef = useRef(false)
  editedRef.current = editorSignature(editor) !== seededSignature.current
  const seededFrame = useRef<string | null>(null)
  const forceReseed = useRef(false)
  const copyLoaded = activeCopy !== undefined
  useEffect(() => {
    const sameFrame = seededFrame.current === activeFrameId
    if (sameFrame && editedRef.current && !forceReseed.current) return
    forceReseed.current = false
    seededFrame.current = activeFrameId
    // A new frame opens unzoomed.
    if (!sameFrame) {
      view.fit()
      setHover(null)
      setConflict(null)
    }
    const { stored, copy } = seedInputs.current
    const saved = (stored ?? []).filter((a) => a.mediaKey === activeFrameId)
    const seeded = seedEditor(
      saved,
      copy?.pipelineBoxes ?? [],
      copy?.dismissed ?? [],
      copy?.verdict,
    )
    // The baseline is the seed WITHOUT the notification answer: a box the
    // operator already answered about is unsaved work until they confirm it.
    baseline.current = editorSignature(
      seedEditor(saved, copy?.pipelineBoxes ?? [], copy?.dismissed ?? []),
    )
    seededSignature.current = editorSignature(seeded)
    resetEditor(seeded)
  }, [activeFrameId, storedAnnotations.dataUpdatedAt, copyLoaded, resetEditor, view.fit])

  useEffect(() => {
    onDirtyChange?.(dirty)
  }, [dirty, onDirtyChange])

  const review = useMemo(
    () => liveReview(editor, activeCopy?.pipelineBoxes ?? []),
    [editor, activeCopy?.pipelineBoxes],
  )
  useEffect(() => {
    setHover((current) =>
      hoverAfterBoxesChange(
        current,
        editor.boxes.map((b) => b.key),
      ),
    )
  }, [editor.boxes])

  const guard = useUnsavedGuard(dirty)

  /** The operator's "every subject in this frame is boxed" — never derived. */
  const onToggleComplete = useCallback(
    async (complete: boolean) => {
      if (activeCopy === undefined) return
      await setFrameComplete.mutateAsync({ ...frameAddress(activeCopy), complete })
      await onFramesChanged()
    },
    [activeCopy, setFrameComplete, onFramesChanged],
  )

  const onPropose = useCallback(
    async (kind: 'objects' | 'package') => {
      if (activeCopy === undefined) return
      setNotice(null)
      // An object proposal is only asked when the server said WHICH model, at
      // WHICH threshold, on WHICH node. Without all three there is nothing
      // honest to ask, and the button that leads here is disabled — this is the
      // second gate, for a call that reached here any other way.
      if (assistDetector.kind !== 'resolved') {
        setNotice(t(`assistGap.${assistDetector.gap}`))
        return
      }
      const result = await propose.mutateAsync({
        ...frameAddress(activeCopy),
        subject:
          kind === 'package'
            ? { kind: 'package' }
            : {
                kind: 'objects',
                modelId: assistDetector.modelId,
                minScore: assistDetector.minScore,
              },
        // The node the camera's pipeline REALLY runs on.
        nodeId: assistDetector.nodeId,
      })
      if (result.kind === 'refused') {
        setNotice(
          result.reason === 'no-zone'
            ? t('workbench.noZone')
            : result.detail !== undefined
              ? t('workbench.refusedDetail', { reason: result.reason, detail: result.detail })
              : t('workbench.refused', { reason: result.reason }),
        )
        return
      }
      // Proposals ADD to what is on screen, as drafts; they never replace the
      // operator's own boxes, and one that duplicates a box already there is
      // dropped rather than drawn twice.
      const added = addDrafts(
        editor,
        result.proposals.map(
          (p): EditorBoxInput => ({
            bbox: p.bbox,
            macroClass: p.macroClass,
            ...(p.label !== undefined ? { label: p.label } : {}),
            kind: p.kind,
            source: p.source,
            ...(p.assistModelId !== undefined ? { assistModelId: p.assistModelId } : {}),
            ...(p.assistScore !== undefined ? { assistScore: p.assistScore } : {}),
            ...(p.origin ? { origin: p.origin } : {}),
            draft: true,
          }),
        ),
      )
      setEditor(added.state)
      setNotice(
        `${[
          t('workbench.proposals', { count: result.proposals.length, model: result.modelId }),
          ...(added.skipped > 0 ? [t('workbench.skipped', { count: added.skipped })] : []),
          ...(result.belowThreshold > 0
            ? [
                t('workbench.belowThreshold', {
                  count: result.belowThreshold,
                  score: result.minScore.toFixed(2),
                }),
              ]
            : []),
        ].join(' — ')}. ${t('workbench.proposalsTail')}`,
      )
    },
    [activeCopy, propose, assistDetector, editor, setEditor, setNotice, t],
  )

  const onDraw = useCallback(
    (box: NormBox) => {
      setEditor((current: EditorState) => addOperatorBox(current, box, NEW_ANNOTATION_MACRO))
    },
    [setEditor],
  )

  // A save re-seeds the editor from the server when its refetch lands, so
  // editing is frozen for the WHOLE round trip (mutation + refetch): an edit
  // made in between would be replaced by the re-seed.
  const [saving, setSaving] = useState(false)
  const onSave = useCallback(async () => {
    if (activeCopy === undefined) return
    const pending = pendingDraftCount(editor)
    setSaving(true)
    try {
      await saveAnnotations.mutateAsync({
        ...frameAddress(activeCopy),
        annotations: [...toSavePayload(editor)],
        dismissed: [...toSaveDismissed(editor)],
        // The revision this editor was seeded from: another surface that saved
        // since is refused rather than silently overwritten.
        ...(activeCopy.revision !== undefined ? { expectedRevision: activeCopy.revision } : {}),
      })
      forceReseed.current = true
      setConflict(null)
      await storedAnnotations.refetch()
      void vocabularySource.refetch()
    } catch (err: unknown) {
      const refused = parseRetrainRevisionConflict(err instanceof Error ? err.message : '')
      if (refused === null) throw err
      // Keep what the operator did on screen: replacing it with the latest
      // version is theirs to choose (`onReloadLatest`).
      setConflict(refused.currentRevision)
      return
    } finally {
      setSaving(false)
    }
    await onSaved?.()
    setNotice(
      pending > 0 ? t('workbench.savedWithDrafts', { count: pending }) : t('workbench.saved'),
    )
  }, [
    activeCopy,
    editor,
    saveAnnotations,
    storedAnnotations,
    vocabularySource,
    onSaved,
    setNotice,
    t,
  ])

  /** Throw the operator's edits away for the version another surface saved. */
  const onReloadLatest = useCallback(async () => {
    forceReseed.current = true
    setConflict(null)
    await Promise.all([storedAnnotations.refetch(), onSaved?.()])
  }, [storedAnnotations, onSaved])

  const imageSrc = frameImage.src
  const canSave = annotationsAreValid(editor.boxes) && activeCopy !== undefined
  const drafts = pendingDraftCount(editor)

  // The keyboard (`lib/retrain-shortcuts.ts`): frames across the whole corpus,
  // box edits through the history, zoom through the shared viewport.
  const stepFrame = (step: 1 | -1): boolean => {
    if (!canStep(step)) return false
    void guard(() => {
      onStep(step)
    })
    return true
  }
  useRetrainShortcuts(
    !saving,
    {
      history,
      onNextFrame: () => stepFrame(1),
      onPrevFrame: () => stepFrame(-1),
      onToggleComplete: () => {
        if (activeCopy === undefined || setFrameComplete.isPending) return false
        void onToggleComplete(!activeCopy.complete)
        return true
      },
      onSave: () => {
        if (!canSave || saving || !dirty) return false
        void onSave()
        return true
      },
      onZoomIn: view.zoomIn,
      onZoomOut: view.zoomOut,
      onZoomFit: view.fit,
    },
    rootRef,
  )

  const select = (key: string): void => {
    selectOnly((current) => selectBox(current, key))
  }

  const subjectsPanel = (
    <div
      id="retrain-subjects-panel"
      data-testid="retrain-subjects-panel"
      className={`${drawerOpen ? 'flex' : 'hidden'} absolute inset-x-0 bottom-0 z-20 max-h-[70%] min-h-0 flex-col overflow-hidden rounded-md border border-border bg-background-elevated shadow-lg lg:static lg:z-auto lg:flex lg:max-h-none lg:w-[380px] lg:shrink-0 lg:bg-surface lg:shadow-none`}
    >
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <h2 className="flex-1 text-xs font-semibold text-foreground">
          {t('actionBar.subjects', { count: editor.boxes.length })}
        </h2>
        <IconButton
          variant="ghost"
          size="sm"
          icon={ChevronDown}
          aria-label={t('workbench.closeList')}
          className="lg:hidden"
          onClick={() => {
            setDrawerOpen(false)
          }}
        />
        {activeCopy?.origin === 'recording' && (
          <Badge variant="info">{t('workbench.fromRecording')}</Badge>
        )}
        <Button
          variant="secondary"
          size="sm"
          disabled={propose.isPending || assistDetector.kind !== 'resolved'}
          onClick={() => void onPropose('objects')}
        >
          <Sparkles className="h-3 w-3" />
          <span className="ml-1">{t('workbench.propose')}</span>
        </Button>
        <Button
          variant="secondary"
          size="sm"
          disabled={propose.isPending || assistDetector.kind !== 'resolved'}
          onClick={() => void onPropose('package')}
        >
          <Sparkles className="h-3 w-3" />
          <span className="ml-1">{t('workbench.packages')}</span>
        </Button>
      </div>
      <p className="shrink-0 border-b border-border px-3 py-1 text-[11px] text-foreground-subtle">
        {assistDetector.kind === 'resolved'
          ? t('workbench.proposalsFrom', {
              model: assistDetector.modelId,
              score: assistDetector.minScore.toFixed(2),
              node: assistDetector.nodeId,
            })
          : t(`assistGap.${assistDetector.gap}`)}
      </p>
      {activeCopy !== undefined && (
        <div className="shrink-0 border-b border-border">
          <Button
            variant="ghost"
            size="sm"
            className="w-full justify-start"
            aria-expanded={assistOpen}
            onClick={() => {
              setAssistOpen((open) => !open)
            }}
          >
            {assistOpen ? (
              <ChevronDown className="h-3 w-3" />
            ) : (
              <ChevronRight className="h-3 w-3" />
            )}
            <span className="ml-1 text-[11px]">{t('workbench.assist')}</span>
          </Button>
          {assistOpen && (
            <div className="max-h-64 overflow-y-auto">
              <RetrainAssistPanel
                frame={activeCopy}
                history={history}
                detector={assistDetector}
                schema={nodeSchema}
                setNotice={setNotice}
              />
            </div>
          )}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <RetrainAnnotationEditor
          boxes={editor.boxes}
          selectedKey={editor.selectedKey}
          review={review}
          showRemoved={showRemoved}
          hover={hover}
          vocabulary={vocabulary}
          onHover={setHover}
          onSelect={select}
          onChange={(key, patch) => {
            setEditor((current) => updateBox(current, key, patch))
          }}
          onEditStart={history.beginGesture}
          onEditLive={(key, patch) => {
            history.updateGesture((current) => updateBox(current, key, patch))
          }}
          onEditEnd={history.endGesture}
          onAccept={(key) => {
            setEditor((current) => acceptBox(current, key))
          }}
          onToggleModelError={(key) => {
            setEditor((current) => markModelError(current, key))
          }}
          onDelete={(key) => {
            setEditor((current) => deleteBox(current, key))
          }}
        />
      </div>
    </div>
  )

  return (
    <div
      ref={rootRef}
      data-testid="retrain-workbench"
      className={`flex min-h-0 flex-1 flex-col gap-2 p-2 sm:p-3 ${saving ? 'pointer-events-none opacity-70' : ''}`}
      aria-busy={saving}
    >
      <RetrainEditorSummary
        review={review}
        savedCounts={activeCopy?.review?.summary.counts ?? null}
        savedApproximate={activeCopy?.review?.summary.approximate ?? false}
        dirty={dirty}
        showRemoved={showRemoved}
        onShowRemovedChange={setShowRemoved}
      />
      {conflict !== null && (
        <div
          role="alert"
          data-testid="retrain-conflict"
          className="flex shrink-0 flex-wrap items-center gap-2 rounded-md border border-danger bg-danger/10 px-3 py-1.5 text-[11px] text-foreground"
        >
          <span className="min-w-0 flex-1">
            {t('workbench.conflict', { revision: String(conflict) })}
          </span>
          <Button variant="secondary" size="sm" onClick={() => void onReloadLatest()}>
            {t('workbench.reload')}
          </Button>
        </div>
      )}
      <div className="relative flex min-h-0 flex-1 gap-3">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-md border border-border">
          <RetrainCanvasToolbar
            frameNav={{
              label: framePosition,
              canPrev: canStep(-1),
              canNext: canStep(1),
              onPrev: () => stepFrame(-1),
              onNext: () => stepFrame(1),
            }}
            view={view}
            canUndo={history.canUndo}
            canRedo={history.canRedo}
            onUndo={history.undo}
            onRedo={history.redo}
          />
          {imageSrc === null || activeCopy === undefined ? (
            <div className="flex flex-1 items-center justify-center gap-2 p-6 text-xs text-foreground-subtle">
              {frameImage.failed ? (
                t('workbench.couldNotLoad')
              ) : (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  {t('workbench.loading')}
                </>
              )}
            </div>
          ) : (
            <RetrainCanvas
              imageSrc={imageSrc}
              imageWidth={activeCopy.width}
              imageHeight={activeCopy.height}
              boxes={editor.boxes}
              selectedKey={editor.selectedKey}
              review={review}
              showRemoved={showRemoved}
              hover={hover}
              onHover={setHover}
              viewport={view.viewport}
              onViewportChange={view.setViewport}
              panMode={view.panMode}
              onSelect={(key) => {
                selectOnly((current) => selectBox(current, key))
              }}
              onDraw={onDraw}
              onGestureStart={history.beginGesture}
              onGestureBox={(key, bbox) => {
                history.updateGesture((current) => updateBox(current, key, { bbox }))
              }}
              onGestureEnd={history.endGesture}
            />
          )}
          <RetrainActionBar
            subjectCount={editor.boxes.length}
            drawerOpen={drawerOpen}
            onToggleDrawer={() => {
              setDrawerOpen((open) => !open)
            }}
            drafts={drafts}
            onAcceptAll={() => {
              setEditor((current) => acceptAllDrafts(current))
            }}
            complete={activeCopy?.complete === true}
            completeDisabled={activeCopy === undefined || setFrameComplete.isPending}
            onCompleteChange={(complete) => void onToggleComplete(complete)}
            canSave={canSave}
            saving={saving}
            dirty={dirty}
            onSave={() => void onSave()}
          />
        </div>
        {subjectsPanel}
      </div>
    </div>
  )
}
