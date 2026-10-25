/**
 * Who proposed a box, as a small icon — on the canvas label and in the list
 * row. The review diff owns the colour; the source is only a glyph, so the two
 * never compete for the same signal.
 */
import { Bot, PenLine, ScanSearch, Workflow, type LucideIcon } from 'lucide-react'
import type { JSX } from 'react'
import { useT } from '../../i18n/index.js'
import type { EditorBox } from './lib/retrain-editor.js'

export type BoxSource = EditorBox['source']

const ICONS: Readonly<Record<BoxSource, LucideIcon>> = {
  operator: PenLine,
  pipeline: Workflow,
  assist: ScanSearch,
  llm: Bot,
}

export interface RetrainSourceIconProps {
  readonly source: BoxSource
  /** Pixels. The canvas label uses 11, the list row 14. */
  readonly size?: number
  readonly className?: string
}

export function RetrainSourceIcon({
  source,
  size = 14,
  className,
}: RetrainSourceIconProps): JSX.Element {
  const { t } = useT()
  const Icon = ICONS[source]
  return (
    <Icon
      width={size}
      height={size}
      className={className}
      data-testid={`retrain-source-${source}`}
      aria-label={t(`source.${source}`)}
      role="img"
    />
  )
}
