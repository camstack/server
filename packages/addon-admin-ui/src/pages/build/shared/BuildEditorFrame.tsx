/**
 * The one frame every Build create / edit flow lives in: a pinned header (back,
 * title, badges, Quick edit), a body that scrolls INSIDE the frame, an optional
 * side column (the runs panel) that scrolls on its own, and a pinned footer
 * (Save, the section's own actions, Close). The frame fills the height the
 * section gives it (`SectionedPage fill`), so the page never grows a second
 * scrollbar and the save bar never leaves the screen.
 */
import { Button, IconButton } from '@dominevo/ui-library'
import { ArrowLeft, Loader2, Pencil, type LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

export interface BuildEditorFrameProps {
  readonly testId: string
  readonly icon: LucideIcon
  readonly title: string
  /** Status badges next to the title. */
  readonly badges?: ReactNode
  /** Leaves the editor. */
  readonly onClose: () => void
  /** Offered once the item exists: opens the shared Quick edit modal. */
  readonly onQuickEdit?: () => void
  /** Undo / redo and the like, at the right of the header. */
  readonly headerActions?: ReactNode
  /** Absent = nothing to save (a read-only item): no Save button. */
  readonly onSave?: () => void
  readonly saveDisabled?: boolean
  readonly saving?: boolean
  readonly saveTestId?: string
  /** The section's own footer buttons, between Save and Close. */
  readonly footerActions?: ReactNode
  /** Right-aligned footer text (error count, "Name required"). */
  readonly footerStatus?: ReactNode
  /** Warnings and errors pinned above the footer, so they stay in view. */
  readonly notices?: ReactNode
  /** A second column on desktop (first on a phone): the runs panel. */
  readonly side?: ReactNode
  /** Hides the footer, for a body that carries its own wizard buttons. */
  readonly bare?: boolean
  readonly children: ReactNode
}

export function BuildEditorFrame({
  testId,
  icon: Icon,
  title,
  badges,
  onClose,
  onQuickEdit,
  headerActions,
  onSave,
  saveDisabled = false,
  saving = false,
  saveTestId,
  footerActions,
  footerStatus,
  notices,
  side,
  bare = false,
  children,
}: BuildEditorFrameProps): ReactNode {
  const { t } = useTranslation()
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3" data-testid={testId}>
      <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border pb-2">
        <Button
          size="sm"
          variant="ghost"
          onClick={onClose}
          aria-label={t('build.editor.back', 'Back to the list')}
          data-testid="build-editor-back"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden />
        </Button>
        <Icon className="h-4 w-4 shrink-0 text-foreground-muted" aria-hidden />
        <h3 className="min-w-0 flex-1 truncate text-sm font-semibold">{title}</h3>
        {badges}
        {onQuickEdit !== undefined && (
          <IconButton
            icon={Pencil}
            size="sm"
            variant="ghost"
            aria-label={t('build.quickEdit.action', 'Quick edit')}
            title={t('build.quickEdit.action', 'Quick edit')}
            onClick={onQuickEdit}
            data-testid="build-editor-quick-edit"
          />
        )}
        {headerActions}
      </header>
      <div
        className={`min-h-0 flex-1 overflow-y-auto lg:grid lg:grid-rows-[minmax(0,1fr)] lg:gap-4 lg:overflow-hidden ${
          side === undefined ? 'lg:grid-cols-1' : 'lg:grid-cols-[minmax(0,1fr)_22rem]'
        }`}
        data-testid="build-editor-body"
      >
        <div className="space-y-4 lg:min-h-0 lg:overflow-y-auto lg:pr-1">{children}</div>
        {side !== undefined && (
          <div className="order-first mb-4 lg:order-last lg:mb-0 lg:flex lg:min-h-0 lg:flex-col lg:overflow-hidden">
            {side}
          </div>
        )}
      </div>
      {notices !== undefined && <div className="shrink-0 space-y-2">{notices}</div>}
      {!bare && (
        <footer className="flex shrink-0 flex-wrap items-center gap-2 border-t border-border pt-2">
          {onSave !== undefined && (
            <Button onClick={onSave} disabled={saving || saveDisabled} data-testid={saveTestId}>
              {saving && <Loader2 className="h-4 w-4 animate-spin" />} {t('common.save', 'Save')}
            </Button>
          )}
          {footerActions}
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            {t('common.close', 'Close')}
          </Button>
          {footerStatus !== undefined && (
            <span className="ml-auto flex items-center gap-2 text-xs text-foreground-subtle">
              {footerStatus}
            </span>
          )}
        </footer>
      )}
    </div>
  )
}
