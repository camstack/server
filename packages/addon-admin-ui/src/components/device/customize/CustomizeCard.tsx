/**
 * The ONE card chrome of the Customize tab — the shared `SectionCard` (the
 * device page's section card), with the tab's `customize-<id>` heading ids so
 * every card on the tab reads at the size and case of the rest of the page.
 * A card owns no data.
 */
import { SectionCard } from '@camstack/ui-library'
import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'

export interface CustomizeCardProps {
  /** Suffix of the heading id (`customize-<id>`); the section is labelled by it. */
  readonly id: string
  readonly title: string
  readonly icon?: LucideIcon
  /** Controls at the right of the header (a switch, "+ Add"). */
  readonly actions?: ReactNode
  readonly testId?: string
  readonly children: ReactNode
}

export function CustomizeCard({ id, ...rest }: CustomizeCardProps): ReactNode {
  return <SectionCard headingId={`customize-${id}`} {...rest} />
}
