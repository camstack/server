/**
 * The quick modal of a Build row — the ONE shell every section (automation,
 * action, scheduler, script, composed device, template) opens on a row click,
 * modelled on the device quick-detail: a header with the name and the tags
 * edited in place, an enable switch where the kind has one, and the button to
 * the full editor; the section's own body (facts, exporters, last runs) sits
 * below as children.
 *
 * The shell only collects the two header values and reports them; the save is
 * the section's own (`quick-edit-inputs.ts`), so a rename never drops a step, a
 * point, a file or a placement.
 */
import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogHeader,
  DialogTitle,
  ErrorBox,
  Input,
  Switch,
  TagInput,
} from '@camstack/ui-library'
import { type ReactNode, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { QuickEditValues } from './QuickEditDialog'

export interface BuildQuickModalProps {
  /** Identifies the item, so switching items resets the header fields. */
  readonly subjectKey: string
  readonly name: string
  readonly tags: readonly string[]
  /** Read-only items (an addon's action, a built-in template) show name and tags without inputs. */
  readonly readOnly?: boolean
  /** The kind's switch; undefined = the kind has none (an action, a template). */
  readonly enabled?: boolean
  readonly enabledBusy?: boolean
  readonly onEnabledChange?: (enabled: boolean) => void
  readonly saving: boolean
  readonly error: string | null
  readonly onSave: (next: QuickEditValues) => void
  /** The label of the button to the full editor: "Open automation". */
  readonly openLabel: string
  readonly onOpen: () => void
  readonly onClose: () => void
  /** Exporter shortcuts (Alexa / HomeKit / HA), drawn as their own section by the caller; absent when the kind is not exportable. */
  readonly exporters?: ReactNode
  readonly children: ReactNode
}

export function BuildQuickModal(props: BuildQuickModalProps): ReactNode {
  return (
    <Dialog open onOpenChange={(open) => !open && props.onClose()}>
      <DialogContent
        width="lg"
        placement="sheet-on-mobile"
        scroll="body"
        data-testid="build-quick-modal"
      >
        <QuickModalContent key={props.subjectKey} {...props} />
      </DialogContent>
    </Dialog>
  )
}

function QuickModalContent({
  name,
  tags,
  readOnly = false,
  enabled,
  enabledBusy = false,
  onEnabledChange,
  saving,
  error,
  onSave,
  openLabel,
  onOpen,
  exporters,
  children,
}: BuildQuickModalProps): ReactNode {
  const { t } = useTranslation()
  const [draft, setDraft] = useState(name)

  /** A name left blank is not saved: the field falls back to the stored one. */
  const commitName = (): void => {
    const next = draft.trim()
    if (next === '') {
      setDraft(name)
      return
    }
    if (next !== name) onSave({ name: next, tags })
  }
  const commitTags = (next: readonly string[]): void => {
    const shown = draft.trim()
    onSave({ name: shown === '' ? name : shown, tags: next })
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle className="sr-only">{name}</DialogTitle>
        <div className="flex flex-wrap items-center gap-2 pr-8">
          {readOnly ? (
            <span className="min-w-0 flex-1 truncate text-base font-semibold">{name}</span>
          ) : (
            <Input
              className="min-w-0 flex-1 font-semibold"
              value={draft}
              maxLength={120}
              disabled={saving}
              aria-label={t('build.quickModal.name', 'Name')}
              data-testid="quick-modal-name"
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commitName}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitName()
              }}
            />
          )}
          {enabled !== undefined && onEnabledChange !== undefined && (
            <Switch
              checked={enabled}
              disabled={enabledBusy}
              onCheckedChange={onEnabledChange}
              aria-label={t('build.quickModal.enabled', 'Enabled')}
              data-testid="quick-modal-enabled"
            />
          )}
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onOpen}
            data-testid="quick-modal-open"
          >
            {openLabel}
          </Button>
        </div>
        <div className="mt-2 text-sm">
          {readOnly ? (
            <span className="text-foreground-muted">{tags.join(', ')}</span>
          ) : (
            <TagInput
              value={tags}
              onChange={commitTags}
              label={t('common.tags', 'Tags')}
              disabled={saving}
            />
          )}
        </div>
        {error !== null && <ErrorBox className="mt-2" message={error} />}
      </DialogHeader>
      <DialogBody className="space-y-3">
        {exporters}
        {children}
      </DialogBody>
    </>
  )
}
