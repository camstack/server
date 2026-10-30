/**
 * DetectionResultTree — displays detection results as a hierarchical tree.
 *
 * Adapted to the Phase 6 output rework: the tree consumes flat
 * `ObjectDetection[]` and correlates details (face / plate) with
 * their parents via `parentId`. First-level entries are top-level
 * nodes; their details render as indented children. Each node shows:
 *   - bbox (rectangle)
 *   - macroClass + score badge
 *   - `labels[]` (ScoredLabel — own + inherited)
 *   - `debug.alternateLabels` (top-N per source) when present
 */
import { useUiText } from '../contexts/ui-text'
import { DisclosureChevron } from '../primitives/disclosure-chevron'
import { useState, type JSX } from 'react'
import type { ObjectDetection, ScoredLabel } from '@camstack/types'
import { useClassPainter } from './display-palette-context'

export interface DetectionResultTreeProps {
  readonly detections: readonly ObjectDetection[]
  readonly classColors?: Readonly<Record<string, string>>
  readonly className?: string
  /** Set of detection ids that are hidden */
  readonly hiddenKeys?: ReadonlySet<string>
  /** Callback when a detection's visibility is toggled */
  readonly onToggleVisibility?: (key: string, visible: boolean) => void
}

export function DetectionResultTree({
  detections,
  classColors,
  className,
  hiddenKeys,
  onToggleVisibility,
}: DetectionResultTreeProps): JSX.Element | null {
  const t = useUiText()
  const colors = classColors

  if (detections.length === 0) {
    return (
      <div className="text-sm text-foreground-subtle italic text-center py-4">
        {t('uiLibrary.detectionResultTree.none', 'No detections')}
      </div>
    )
  }

  const firstLevel = detections.filter((d) => d.kind === 'first-level')
  const details = detections.filter((d) => d.kind === 'detail')
  const detailsByParent = new Map<string, ObjectDetection[]>()
  for (const d of details) {
    if (!d.parentId) continue
    const arr = detailsByParent.get(d.parentId) ?? []
    arr.push(d)
    detailsByParent.set(d.parentId, arr)
  }
  const orphanDetails = details.filter(
    (d) => !d.parentId || !firstLevel.some((p) => p.id === d.parentId),
  )

  return (
    <div className={className}>
      <div className="text-xs font-medium text-foreground-subtle uppercase tracking-wide mb-2">
        {t('uiLibrary.detectionResultTree.title', 'Detections ({{count}})', {
          count: detections.length,
        })}
      </div>
      <div className="space-y-2">
        {firstLevel.map((d) => (
          <DetectionNode
            key={d.id}
            detection={d}
            children_={detailsByParent.get(d.id) ?? []}
            colors={colors}
            hiddenKeys={hiddenKeys}
            onToggleVisibility={onToggleVisibility}
          />
        ))}
        {orphanDetails.map((d) => (
          <DetectionNode
            key={d.id}
            detection={d}
            children_={[]}
            colors={colors}
            hiddenKeys={hiddenKeys}
            onToggleVisibility={onToggleVisibility}
          />
        ))}
      </div>
    </div>
  )
}

function DetectionNode({
  detection,
  children_,
  colors,
  hiddenKeys,
  onToggleVisibility,
}: {
  detection: ObjectDetection
  children_: readonly ObjectDetection[]
  colors?: Record<string, string>
  hiddenKeys?: ReadonlySet<string>
  onToggleVisibility?: (key: string, visible: boolean) => void
}) {
  const paint = useClassPainter()
  const color = paint(detection.macroClass, colors)
  const isVisible = !hiddenKeys?.has(detection.id)
  const mask = detection.debug?.mask
  const maskWidth = detection.debug?.maskWidth
  const maskHeight = detection.debug?.maskHeight
  const alternateLabels = detection.debug?.alternateLabels

  return (
    <div
      className={`rounded-md border border-border bg-surface p-3 space-y-1 ${isVisible ? '' : 'opacity-40'}`}
    >
      <div className="flex justify-between items-center">
        <div className="flex items-center gap-2">
          {onToggleVisibility && (
            <input
              type="checkbox"
              checked={isVisible}
              onChange={() => onToggleVisibility(detection.id, !isVisible)}
              className="h-3.5 w-3.5 rounded border-border accent-primary cursor-pointer shrink-0"
            />
          )}
          <span className="h-2.5 w-2.5 rounded-full shrink-0" style={{ backgroundColor: color }} />
          <span className="text-sm font-medium text-foreground">{detection.macroClass}</span>
          {detection.kind === 'detail' && (
            <span className="text-[9px] font-mono px-1 py-0.5 rounded bg-primary/10 text-primary">
              {/* i18n-ignore: model-output tag, shown verbatim */}
              detail
            </span>
          )}
          {mask && maskWidth && maskHeight && (
            <span className="text-[9px] font-mono px-1 py-0.5 rounded bg-primary/10 text-primary">
              {/* i18n-ignore: model-output tag, shown verbatim */}
              mask {maskWidth}x{maskHeight}
            </span>
          )}
        </div>
        <ConfidenceBadge confidence={detection.score} />
      </div>

      <div className="text-[10px] text-foreground-subtle font-mono">
        bbox: [{Math.round(detection.bbox.x)}, {Math.round(detection.bbox.y)},{' '}
        {Math.round(detection.bbox.x + detection.bbox.width)},{' '}
        {Math.round(detection.bbox.y + detection.bbox.height)}]
      </div>

      {/* Labels — own + inherited from children details */}
      {detection.labels.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-1">
          {detection.labels.map((l: ScoredLabel, k: number) => (
            <span
              key={k}
              className="inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded-full"
              style={{
                backgroundColor: paint(l.label, colors) + '20',
                color: paint(l.label, colors),
              }}
            >
              {l.label}
              <span className="opacity-60">{(l.score * 100).toFixed(0)}%</span>
              {l.detectionId && <span className="opacity-40 text-[8px]">→ {l.detectionId}</span>}
            </span>
          ))}
        </div>
      )}

      {/* Alternate labels — full ranked list per source (debug/benchmark) */}
      {alternateLabels && Object.keys(alternateLabels).length > 0 && (
        <AlternateLabelsSection alternateLabels={alternateLabels} colors={colors} />
      )}

      {/* Detail children — face, plate, etc. */}
      {children_.length > 0 && (
        <ChildrenTree
          items={children_}
          colors={colors}
          hiddenKeys={hiddenKeys}
          onToggleVisibility={onToggleVisibility}
        />
      )}
    </div>
  )
}

function ChildrenTree({
  items,
  colors,
  hiddenKeys,
  onToggleVisibility,
}: {
  items: readonly ObjectDetection[]
  colors?: Record<string, string>
  hiddenKeys?: ReadonlySet<string>
  onToggleVisibility?: (key: string, visible: boolean) => void
}) {
  const paint = useClassPainter()
  return (
    <div className="ml-4 mt-1.5 space-y-1.5 border-l-2 border-border pl-3">
      {items.map((child) => {
        const childColor = paint(child.macroClass, colors)
        const isVisible = !hiddenKeys?.has(child.id)
        const mask = child.debug?.mask
        const maskWidth = child.debug?.maskWidth
        const maskHeight = child.debug?.maskHeight

        return (
          <div key={child.id} className={`text-xs space-y-0.5 ${isVisible ? '' : 'opacity-40'}`}>
            <div className="flex items-center gap-1.5">
              {onToggleVisibility && (
                <input
                  type="checkbox"
                  checked={isVisible}
                  onChange={() => onToggleVisibility(child.id, !isVisible)}
                  className="h-3 w-3 rounded border-border accent-primary cursor-pointer shrink-0"
                />
              )}
              <span
                className="h-1.5 w-1.5 rounded-full shrink-0"
                style={{ backgroundColor: childColor }}
              />
              <span className="font-medium" style={{ color: childColor }}>
                {child.macroClass}
              </span>
              <span className="text-foreground-subtle">{(child.score * 100).toFixed(0)}%</span>
              {mask && maskWidth && maskHeight && (
                <span className="text-[9px] font-mono px-1 py-0.5 rounded bg-primary/10 text-primary">
                  {/* i18n-ignore: model-output tag, shown verbatim */}
                  mask {maskWidth}x{maskHeight}
                </span>
              )}
            </div>
            {child.labels.length > 0 && (
              <div className="flex flex-wrap gap-1 ml-5 mt-0.5">
                {child.labels.map((l: ScoredLabel, k: number) => (
                  <span
                    key={k}
                    className="inline-flex items-center gap-0.5 text-[9px] font-medium px-1 py-0.5 rounded-full"
                    style={{
                      backgroundColor: paint(l.label, colors) + '20',
                      color: paint(l.label, colors),
                    }}
                  >
                    {l.label} <span className="opacity-60">{(l.score * 100).toFixed(0)}%</span>
                  </span>
                ))}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

function AlternateLabelsSection({
  alternateLabels,
  colors,
}: {
  readonly alternateLabels: Readonly<Record<string, readonly ScoredLabel[]>>
  readonly colors?: Record<string, string>
}) {
  const [expanded, setExpanded] = useState(false)
  const paint = useClassPainter()
  const t = useUiText()
  const sources = Object.keys(alternateLabels)

  return (
    <div className="mt-1">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
        className="text-[9px] text-foreground-subtle hover:text-foreground transition-colors flex items-center gap-1"
      >
        <DisclosureChevron expanded={expanded} />
        {t(
          'uiLibrary.detectionResultTree.alternates',
          { one: 'Alternates ({{count}} source)', other: 'Alternates ({{count}} sources)' },
          { count: sources.length },
        )}
      </button>
      {expanded && (
        <div className="mt-1 ml-3 space-y-1.5">
          {sources.map((source) => {
            const labels = alternateLabels[source]
            if (!labels || labels.length === 0) return null
            return (
              <div key={source}>
                <div className="text-[9px] font-medium text-foreground-subtle mb-0.5">{source}</div>
                <div className="flex flex-wrap gap-1">
                  {labels.map((l, k) => (
                    <span
                      key={k}
                      className="inline-flex items-center gap-0.5 text-[9px] px-1 py-0.5 rounded-full"
                      style={{
                        backgroundColor: paint(source, colors) + '10',
                        color: paint(source, colors),
                        opacity: Math.max(0.4, l.score),
                      }}
                    >
                      {l.label}
                      <span className="opacity-60">{(l.score * 100).toFixed(1)}%</span>
                    </span>
                  ))}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function ConfidenceBadge({ confidence }: { confidence: number }) {
  const level =
    confidence >= 0.8
      ? 'bg-success/10 text-success'
      : confidence >= 0.5
        ? 'bg-warning/10 text-warning'
        : 'bg-danger/10 text-danger'

  return (
    <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${level}`}>
      {(confidence * 100).toFixed(1)}%
    </span>
  )
}
