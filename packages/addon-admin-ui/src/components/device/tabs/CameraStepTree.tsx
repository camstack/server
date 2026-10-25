/**
 * One camera's detection steps as a tree: name, kind, the classes the step
 * consumes and produces, and On / Off / Auto. No accelerator columns and no
 * model names — a model is chosen where the step runs.
 */
import type { PipelineSlot } from '@camstack/types'
import { Badge, type BadgeVariant, GateControl, type StepGate } from '@camstack/ui-library'
import { suppressedBadgeLabel } from '../../pipeline/step-inspector/detection-source-model'
import { useTranslation } from 'react-i18next'
import { type CameraStepBlock, type CameraStepRow } from './camera-step-tree-model'

const DEPTH_CLASS = ['pl-2', 'pl-6', 'pl-10', 'pl-14'] as const

const KIND_VARIANT: Record<PipelineSlot, BadgeVariant> = {
  detector: 'success',
  cropper: 'info',
  classifier: 'primary',
  refiner: 'warning',
  'audio-classifier': 'neutral',
}

interface CameraStepTreeProps {
  readonly rows: readonly CameraStepRow[]
  readonly label: string
  readonly selectedId: string | null
  readonly busy: boolean
  readonly onOpen: (stepId: string) => void
  readonly onSet: (stepId: string, enabled: boolean | null) => void
}

function depthClass(depth: number): string {
  return DEPTH_CLASS[Math.min(depth, DEPTH_CLASS.length - 1)] ?? 'pl-2'
}

function gateOf(row: CameraStepRow): StepGate {
  if (row.zoneDriven) return { kind: 'zone-driven' }
  return {
    kind: 'gate',
    effectiveOn: row.ownOn,
    defaultOn: row.defaultOn,
    explicit: row.choice !== 'auto',
  }
}

function blockText(blocked: CameraStepBlock, stepId: string, offBecauseParent: string): string {
  if (blocked.kind === 'parent') return offBecauseParent
  return suppressedBadgeLabel(blocked.source, stepId)
}

function ClassFlow({
  inputs,
  outputs,
}: {
  readonly inputs: readonly string[]
  readonly outputs: readonly string[]
}) {
  if (inputs.length === 0 && outputs.length === 0) return null
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {inputs.map((name) => (
        <Badge key={`in-${name}`} size="sm" variant="info">
          {name}
        </Badge>
      ))}
      {inputs.length > 0 && outputs.length > 0 && (
        <span className="text-[10px] text-foreground-subtle" aria-hidden>
          →
        </span>
      )}
      {outputs.map((name) => (
        <Badge key={`out-${name}`} size="sm" variant="success">
          {name}
        </Badge>
      ))}
    </span>
  )
}

export function CameraStepTree({
  rows,
  label,
  selectedId,
  busy,
  onOpen,
  onSet,
}: CameraStepTreeProps) {
  const { t } = useTranslation()
  const kindLabel = (kind: PipelineSlot): string => {
    switch (kind) {
      case 'detector':
        return t('device.cameraStepInspector.kindDetector', 'detector')
      case 'cropper':
        return t('device.cameraStepInspector.kindCropper', 'cropper')
      case 'classifier':
        return t('device.cameraStepInspector.kindClassifier', 'classifier')
      case 'refiner':
        return t('device.cameraStepInspector.kindRefiner', 'refiner')
      case 'audio-classifier':
        return t('device.cameraStepInspector.kindAudio', 'audio')
    }
  }
  const offBecauseParent = t(
    'device.cameraStepInspector.offBecauseParent',
    'Off because its parent is off',
  )
  return (
    <ul aria-label={label} className="divide-y divide-border rounded-md border border-border">
      {rows.map((row) => {
        const selected = row.stepId === selectedId
        const reason =
          row.blocked === null ? null : blockText(row.blocked, row.stepId, offBecauseParent)
        return (
          <li
            key={row.stepId}
            data-step={row.stepId}
            data-runs={row.runs ? 'yes' : 'no'}
            className={`flex flex-wrap items-center gap-x-2 gap-y-1.5 py-2 pr-2 ${depthClass(row.depth)} ${
              selected ? 'bg-primary/10' : row.runs ? '' : 'bg-muted/40'
            }`}
          >
            {/* ui-check-ok: the row itself opens the panel; Button chrome would fight the tree row */}
            <button
              type="button"
              aria-expanded={selected}
              onClick={() => onOpen(row.stepId)}
              className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1 text-left"
            >
              <span
                className={`text-sm font-medium ${row.runs ? 'text-foreground' : 'text-foreground-muted'}`}
              >
                {row.name}
              </span>
              <Badge size="sm" variant={KIND_VARIANT[row.kind]}>
                {kindLabel(row.kind)}
              </Badge>
              <ClassFlow inputs={row.inputs} outputs={row.outputs} />
              {reason !== null && <span className="text-[11px] text-warning">{reason}</span>}
            </button>
            <GateControl
              gate={gateOf(row)}
              busy={busy}
              onSet={(enabled) => onSet(row.stepId, enabled)}
            />
          </li>
        )
      })}
    </ul>
  )
}
