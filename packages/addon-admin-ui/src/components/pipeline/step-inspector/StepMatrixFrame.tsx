/**
 * StepMatrixFrame — what the node and the camera step pages share (D757): the
 * steps × accelerators TABLE as the page, and the settings of the clicked cell
 * in a docked panel.
 *
 *   - The matrix is the view: one row per step, one column per accelerator
 *     (disabled accelerators behind a toggle). A cell opens that step on THAT
 *     accelerator and the panel is about it alone; a step's header (or a
 *     search hit) opens the step itself, with no accelerator.
 *   - The panel (`StepDetailDock`) is fixed to the page's scroll container and
 *     OVERLAYS the matrix — it never reserves width, so the matrix does not
 *     reflow; the matrix scrolls the selected column clear of it instead. On a
 *     phone it is a full-screen sheet.
 *   - The open cell lives in `?step=&acc=`; Escape (or ✕) closes the panel and
 *     returns focus to the cell it was opened from.
 *   - `/` filters the rows by step name or field label; Enter opens the first.
 *   - Moving away from unsaved edits asks first.
 */
import { type ReactNode, useCallback, useMemo, useRef, useState } from 'react'
import { X } from 'lucide-react'
import {
  type AgentColumn,
  acceleratorLabel,
  agentColumnKey,
  BackToStepsButton,
  type CellState,
  Checkbox,
  DeviceStepMatrix,
  type DeviceStepMatrixHandle,
  IconButton,
  STEP_DOCK_WIDTH_PX,
  StepDetailDock,
  type StepSearchRow,
  type StepTreeNode,
  searchSteps,
  TEXT_HINT,
  useConfirm,
  useIsMobile,
  useSearchFieldHotkey,
  Input,
} from '@camstack/ui-library'
import { useStepUrlSelection } from '../../../hooks/useStepUrlSelection'
import { filterStepTree, flattenStepTree, type InspectorAccelerator } from './step-inspector-model'
import { useTranslation } from 'react-i18next'

export interface StepDetailContext {
  /** The open step. */
  readonly stepId: string
  /** The clicked accelerator, or `null` for the step view (row header, search hit). */
  readonly accelerator: InspectorAccelerator | null
  /** The field label a search hit matched, to highlight. */
  readonly matchedField: string | null
  /** Leading control of the panel header: "‹ Steps" on a phone, ✕ elsewhere. */
  readonly closeButton: ReactNode
  /** Escape inside the panel: close it and return to the cell. */
  readonly onEscape: () => void
  /** Attach to the panel's heading so opening from the keyboard focuses it. */
  readonly headingRef: (el: HTMLHeadingElement | null) => void
}

export interface StepMatrixFrameProps {
  readonly tree: readonly StepTreeNode[]
  /** Name + field labels per step, for the `/` filter. */
  readonly searchRows: readonly StepSearchRow[]
  /** The accelerators shown as columns. */
  readonly accelerators: readonly InspectorAccelerator[]
  readonly cellState: (addonId: string, acc: InspectorAccelerator) => CellState
  /** A badge in a step's header (the camera gate). */
  readonly stepBadge?: (addonId: string) => ReactNode
  /** How many accelerators are switched off — the toggle shows when > 0. */
  readonly disabledCount: number
  readonly showDisabled: boolean
  readonly onShowDisabledChange: (show: boolean) => void
  /** Unsaved edits on the open step. */
  readonly dirty: boolean
  /** Throw the draft away (after the operator agreed to). */
  readonly onDiscard: () => void
  /** Left of the toolbar: a one-line summary. */
  readonly summary?: ReactNode
  /** Right of the toolbar: the page's own actions. */
  readonly toolbar?: ReactNode
  readonly label: string
  readonly renderDetail: (ctx: StepDetailContext) => ReactNode
}

function toColumn(acc: InspectorAccelerator): AgentColumn {
  return {
    agentNodeId: acc.nodeId,
    nodeLabel: acc.nodeLabel,
    engineLabel: acc.device.format,
    deviceKey: acc.deviceKey,
    deviceLabel: acceleratorLabel(acc.device),
    detail: acc.device.defaultModelId,
    disabled: acc.disabled,
  }
}

export function StepMatrixFrame({
  tree,
  searchRows,
  accelerators,
  cellState,
  stepBadge,
  disabledCount,
  showDisabled,
  onShowDisabledChange,
  dirty,
  onDiscard,
  summary,
  toolbar,
  label,
  renderDetail,
}: StepMatrixFrameProps) {
  const { t } = useTranslation()
  const confirm = useConfirm()
  const isMobile = useIsMobile()
  const stepIds = useMemo(() => flattenStepTree(tree).map((r) => r.node.addonId), [tree])
  const accIds = useMemo(() => accelerators.map((a) => a.id), [accelerators])
  const { selection, open, close } = useStepUrlSelection(stepIds, accIds)
  const [query, setQuery] = useState('')
  const [matchedField, setMatchedField] = useState<string | null>(null)
  const [fallbackNodeId, setFallbackNodeId] = useState<string | null>(null)
  const matrixRef = useRef<DeviceStepMatrixHandle | null>(null)
  const anchorRef = useRef<HTMLDivElement | null>(null)
  const searchRef = useRef<HTMLInputElement | null>(null)
  useSearchFieldHotkey(searchRef)
  const headingEl = useRef<HTMLHeadingElement | null>(null)

  const hits = useMemo(() => searchSteps(searchRows, query), [searchRows, query])
  const shownTree = useMemo(
    () => (query.trim() === '' ? tree : filterStepTree(tree, new Set(hits.map((h) => h.addonId)))),
    [tree, hits, query],
  )
  const fieldOf = (addonId: string): string | null =>
    hits.find((h) => h.addonId === addonId)?.matchedField ?? null

  const columns = useMemo(() => accelerators.map(toColumn), [accelerators])
  const accOf = (agent: AgentColumn): InspectorAccelerator | undefined =>
    accelerators.find((a) => a.nodeId === agent.agentNodeId && a.deviceKey === agent.deviceKey)
  const selectedAcc = accelerators.find((a) => a.id === selection.acceleratorId) ?? null
  const isOpen = selection.stepId !== null

  /** Run `go` now, or after the operator agreed to drop the unsaved draft. */
  const leaveDraft = useCallback(
    async (go: () => void): Promise<void> => {
      if (dirty) {
        const ok = await confirm({
          title: t(
            'stepInspector.stepMatrixFrame.discardUnsavedChanges',
            'Discard unsaved changes?',
          ),
          message: t(
            'stepInspector.stepMatrixFrame.thisStepHasChangesThat',
            'This step has changes that are not saved yet.',
          ),
          confirmLabel: t('stepInspector.stepMatrixFrame.discard', 'Discard'),
          variant: 'danger',
        })
        if (!ok) return
        onDiscard()
      }
      go()
    },
    [confirm, dirty, onDiscard, t],
  )

  const focusHeading = (): void => {
    requestAnimationFrame(() => headingEl.current?.focus())
  }

  const openStep = (stepId: string, acc?: InspectorAccelerator, viaKeyboard = false): void => {
    if (stepId === selection.stepId && (acc?.id ?? null) === selection.acceleratorId) {
      if (viaKeyboard) focusHeading()
      return
    }
    const go = (): void => {
      setMatchedField(fieldOf(stepId))
      open({ stepId, ...(acc !== undefined ? { acceleratorId: acc.id } : {}) })
      // From the keyboard, focus follows into the panel; a pointer keeps it on the cell.
      if (viaKeyboard) focusHeading()
    }
    // Same step on another accelerator keeps the draft; another step asks first.
    if (stepId === selection.stepId) go()
    else void leaveDraft(go)
  }

  const closePanel = (): void => {
    const stepId = selection.stepId
    void leaveDraft(() => {
      close()
      if (stepId !== null) {
        const key =
          selectedAcc !== null
            ? agentColumnKey({ agentNodeId: selectedAcc.nodeId, deviceKey: selectedAcc.deviceKey })
            : null
        requestAnimationFrame(() => matrixRef.current?.focusCell(stepId, key))
      }
    })
  }

  const onSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') {
      const first = hits[0]
      if (first === undefined) return
      e.preventDefault()
      openStep(first.addonId, undefined, true)
    } else if (e.key === 'Escape') {
      setQuery('')
    }
  }

  const closeButton = isMobile ? (
    <BackToStepsButton onClick={closePanel} />
  ) : (
    <IconButton
      icon={X}
      variant="ghost"
      size="sm"
      aria-label={t('common.close', 'Close')}
      onClick={closePanel}
    />
  )

  return (
    <div
      ref={anchorRef}
      className="space-y-2"
      onKeyDown={(e) => {
        const inMatrix = e.target instanceof HTMLElement && e.target.dataset.r !== undefined
        // `/` from anywhere in the matrix jumps to the filter.
        if (e.key === '/' && inMatrix) {
          e.preventDefault()
          searchRef.current?.focus()
        }
        // Escape on the matrix closes the open panel too (focus stays on the cell).
        if (e.key === 'Escape' && inMatrix && isOpen) {
          e.preventDefault()
          closePanel()
        }
      }}
    >
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <div className="min-w-0 basis-full sm:basis-auto">{summary}</div>
        <Input
          ref={searchRef}
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onSearchKeyDown}
          placeholder={t(
            'stepInspector.stepMatrixFrame.filterStepsOrSettings',
            'Filter steps or settings  /',
          )}
          aria-label={t(
            'stepInspector.stepMatrixFrame.filterStepsOrSettings2',
            'Filter steps or settings',
          )}
          className="h-9 w-56 rounded-md border border-border bg-background px-2 text-xs text-foreground outline-none focus:border-primary focus:ring-1 focus:ring-primary/30 md:h-7"
        />
        {disabledCount > 0 && (
          <label className="inline-flex items-center gap-1.5 text-[11px] text-foreground-subtle">
            <Checkbox
              checked={showDisabled}
              onChange={(e) => onShowDisabledChange(e.target.checked)}
            />
            {t('stepInspector.stepMatrixFrame.showDisabled', { count: disabledCount })}
          </label>
        )}
        {toolbar}
      </div>
      {selection.staleStepId !== null && (
        <p className="rounded-md border border-warning/40 bg-warning/10 px-3 py-1.5 text-[11px] text-warning">
          {t('stepInspector.stepMatrixFrame.staleStep', { id: selection.staleStepId })}
        </p>
      )}
      {shownTree.length === 0 ? (
        <p
          className={`${TEXT_HINT} rounded-md border border-dashed border-border px-3 py-4 text-center`}
        >
          {t('stepInspector.stepMatrixFrame.noStepMatches', { query })}
        </p>
      ) : (
        <DeviceStepMatrix
          ref={matrixRef}
          tree={shownTree}
          agents={columns}
          label={label}
          getCellState={(addonId, agent) => {
            const acc = accOf(agent)
            return acc !== undefined ? cellState(addonId, acc) : { kind: 'na' }
          }}
          onCellClick={(addonId, agent, viaKeyboard) =>
            openStep(addonId, accOf(agent), viaKeyboard)
          }
          onStepClick={(addonId, viaKeyboard) => openStep(addonId, undefined, viaKeyboard)}
          {...(stepBadge !== undefined ? { stepBadge } : {})}
          selectedCell={
            isOpen && selection.stepId !== null && selectedAcc !== null
              ? {
                  addonId: selection.stepId,
                  agentNodeId: selectedAcc.nodeId,
                  deviceKey: selectedAcc.deviceKey,
                }
              : null
          }
          fallbackNodeId={fallbackNodeId}
          onFallbackNodeChange={setFallbackNodeId}
          reserveRightPx={isOpen && !isMobile ? STEP_DOCK_WIDTH_PX : 0}
        />
      )}
      <StepDetailDock
        open={isOpen}
        anchor={anchorRef}
        onClose={closePanel}
        label={t('stepInspector.stepMatrixFrame.stepSettings', 'Step settings')}
      >
        {selection.stepId !== null &&
          renderDetail({
            stepId: selection.stepId,
            accelerator: selectedAcc,
            matchedField,
            closeButton,
            onEscape: closePanel,
            headingRef: (el) => {
              headingEl.current = el
            },
          })}
      </StepDetailDock>
    </div>
  )
}
