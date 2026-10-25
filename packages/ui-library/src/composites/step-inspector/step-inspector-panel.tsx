/**
 * StepInspectorPanel — the detail pane of the step inspector: a pinned header
 * (the clicked step and accelerator, the gate), ONE scrolling body, and a
 * pinned save bar (with the "applies to" choice, when there is one). Nothing in it depends on the page's scroll position — the slide-over
 * it replaced was anchored to the matrix block and scrolled away with it.
 */
import { useUiText } from '../../contexts/ui-text'
import {
  forwardRef,
  type KeyboardEvent,
  type ReactNode,
  useId,
  type ForwardRefExoticComponent,
  type RefAttributes,
} from 'react'
import { cn } from '../../lib/cn'
import { Button } from '../../primitives/button'

export interface SaveBarState {
  readonly dirtyCount: number
  readonly saving: boolean
  /** The last save's outcome, cleared by the next edit. */
  readonly status: 'saved' | 'error' | null
  readonly error?: string
  readonly onSave: () => void
  readonly onDiscard: () => void
  /**
   * A control that decides WHAT Save writes, drawn on its own row right above
   * the buttons — on a camera, "Applies to: this accelerator / all
   * accelerators". Next to Save, so it is read at the moment of saving.
   */
  readonly scope?: ReactNode
}

export interface StepInspectorPanelProps {
  readonly title: string
  readonly subtitle?: ReactNode
  /** Right of the title (the gate). */
  readonly headerActions?: ReactNode
  /** Under the title. */
  readonly headerExtra?: ReactNode
  /** Left of the title (the phone's "‹ Steps"). */
  readonly leading?: ReactNode
  readonly saveBar?: SaveBarState
  /** Escape inside the panel — the host returns focus to the step list. */
  readonly onEscape?: () => void
  readonly children: ReactNode
  readonly className?: string
}

function SaveBar({ dirtyCount, saving, status, error, onSave, onDiscard, scope }: SaveBarState) {
  const t = useUiText()
  const dirty = dirtyCount > 0
  const message = saving
    ? t('uiLibrary.stepInspector.saving', 'Saving…')
    : dirty
      ? t(
          'uiLibrary.stepInspector.unsaved',
          { one: '{{count}} unsaved change', other: '{{count}} unsaved changes' },
          { count: dirtyCount },
        )
      : status === 'saved'
        ? t('uiLibrary.stepInspector.saved', 'Saved')
        : status === 'error'
          ? (error ?? t('uiLibrary.stepInspector.saveFailed', 'Save failed'))
          : t('uiLibrary.stepInspector.noChanges', 'No unsaved changes')
  return (
    <footer className="shrink-0 space-y-2 border-t border-border bg-surface px-4 py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] md:pb-2">
      {scope !== undefined && <div data-save-scope>{scope}</div>}
      <div className="flex items-center gap-2">
        <span
          role="status"
          className={cn(
            'min-w-0 flex-1 truncate text-[11px]',
            status === 'error' && !dirty
              ? 'text-danger'
              : dirty
                ? 'text-amber-500'
                : 'text-foreground-subtle',
          )}
        >
          {message}
        </span>
        <Button variant="outline" size="md" disabled={!dirty || saving} onClick={onDiscard}>
          {t('uiLibrary.stepInspector.discard', 'Discard')}
        </Button>
        <Button variant="primary" size="md" disabled={!dirty || saving} onClick={onSave}>
          {t('uiLibrary.stepInspector.save', 'Save')}
        </Button>
      </div>
    </footer>
  )
}

export const StepInspectorPanel: ForwardRefExoticComponent<
  StepInspectorPanelProps & RefAttributes<HTMLHeadingElement>
> = forwardRef<HTMLHeadingElement, StepInspectorPanelProps>(function StepInspectorPanel(
  { title, subtitle, headerActions, headerExtra, leading, saveBar, onEscape, children, className },
  headingRef,
) {
  const headingId = useId()
  const onKeyDown = (e: KeyboardEvent<HTMLElement>): void => {
    if (e.key !== 'Escape' || onEscape === undefined) return
    e.stopPropagation()
    onEscape()
  }
  return (
    <section
      aria-labelledby={headingId}
      onKeyDown={onKeyDown}
      className={cn('flex min-h-0 flex-1 flex-col overflow-hidden bg-surface', className)}
    >
      <header className="shrink-0 space-y-2 border-b border-border px-4 py-2.5">
        <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
          {leading}
          <div className="min-w-[9rem] flex-1">
            <h2
              id={headingId}
              ref={headingRef}
              tabIndex={-1}
              title={title}
              // Two lines, not one: the title names the step, the node AND the
              // accelerator, and the gate sits beside it on a camera.
              className="line-clamp-2 break-words text-sm font-semibold leading-snug text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary rounded"
            >
              {title}
            </h2>
            {subtitle !== undefined && (
              <div className="mt-0.5 text-[11px] text-foreground-subtle">{subtitle}</div>
            )}
          </div>
          {headerActions}
        </div>
        {headerExtra}
      </header>
      <div
        data-inspector-body
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-3"
      >
        {children}
      </div>
      {saveBar !== undefined && <SaveBar {...saveBar} />}
    </section>
  )
})
