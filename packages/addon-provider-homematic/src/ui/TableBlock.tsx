import type { ReactNode } from 'react'

/**
 * Title and actions for a page table. The table is the only frame — this block
 * adds none, so a `DataTable` is not drawn inside a second card.
 */
export function TableBlock(props: {
  readonly headingId: string
  readonly title: string
  readonly actions?: ReactNode
  readonly children: ReactNode
}): ReactNode {
  const { headingId, title, actions, children } = props
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2">
      <header className="flex min-h-9 flex-wrap items-center gap-2">
        <h2
          id={headingId}
          className="min-w-0 flex-1 text-xs font-semibold uppercase tracking-wider text-foreground"
        >
          {title}
        </h2>
        {actions}
      </header>
      {children}
    </section>
  )
}
