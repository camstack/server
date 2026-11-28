/**
 * The quick modal of a Build row — the ONE shell every section (automation,
 * action, scheduler, script, composed device, template) opens on a row click,
 * modelled on the device quick-detail: a header with the name and the tags
 * edited in place, an enable switch where the kind has one, and the button to
 * the full editor; the section's own body sits below as children, with the Exporters and
 * Last runs panels as lazy tabs where the kind has them.
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
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@dominevo/ui-library'
import { type ReactNode, useEffect, useRef, useState } from 'react'
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
  /**
   * The Exporters tab (Alexa / HomeKit / HA): the caller's panel, mounted only
   * while that tab is open, so its queries do not fire at modal open. Absent
   * when the kind is not exportable (no tab).
   */
  readonly exporters?: ReactNode
  /** The Last runs tab, mounted only while open for the same reason; absent when the kind keeps no run ledger. */
  readonly lastRuns?: ReactNode
  readonly children: ReactNode
}

type QuickTabId = 'settings' | 'exporters' | 'runs'

function asQuickTab(value: string): QuickTabId {
  return value === 'exporters' || value === 'runs' ? value : 'settings'
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
  lastRuns,
  children,
}: BuildQuickModalProps): ReactNode {
  const { t } = useTranslation()
  const [tab, setTab] = useState<QuickTabId>('settings')
  const [draft, setDraft] = useState(name)

  /** What the stored item holds, or what was last submitted: every save is built
   *  from it, so a second edit landing before the first answer carries the first. */
  const saved = useRef<QuickEditValues>({ name, tags })
  const tagsKey = tags.join('\u0000')
  // biome-ignore lint/correctness/useExhaustiveDependencies: tagsKey stands for tags, whose identity changes on every parent render
  useEffect(() => {
    saved.current = { name, tags }
  }, [name, tagsKey])

  const submit = (next: QuickEditValues): void => {
    const last = saved.current
    const same =
      next.name === last.name &&
      next.tags.length === last.tags.length &&
      next.tags.every((tag, i) => tag === last.tags[i])
    if (same) return
    saved.current = next
    onSave(next)
  }
  /** A name left blank is not saved: the field falls back to the stored one. */
  const commitName = (): void => {
    const next = draft.trim()
    if (next === '') {
      setDraft(saved.current.name)
      return
    }
    submit({ name: next, tags: saved.current.tags })
  }
  const commitTags = (next: readonly string[]): void => {
    const shown = draft.trim()
    submit({ name: shown === '' ? saved.current.name : shown, tags: next })
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
        {exporters === undefined && lastRuns === undefined ? (
          children
        ) : (
          <Tabs value={tab} onValueChange={(next) => setTab(asQuickTab(next))}>
            <TabsList>
              <TabsTrigger value="settings" data-testid="quick-tab-settings">
                {t('build.quickModal.tabSettings', 'Settings')}
              </TabsTrigger>
              {exporters !== undefined && (
                <TabsTrigger value="exporters" data-testid="quick-tab-exporters">
                  {t('build.quickModal.exporters', 'Exporters')}
                </TabsTrigger>
              )}
              {lastRuns !== undefined && (
                <TabsTrigger value="runs" data-testid="quick-tab-runs">
                  {t('build.quickModal.lastRuns', 'Last runs')}
                </TabsTrigger>
              )}
            </TabsList>
            {/* An inactive panel is not mounted: its queries start when its tab opens. */}
            <TabsContent value="settings" className="space-y-3">
              {children}
            </TabsContent>
            <TabsContent value="exporters">{exporters}</TabsContent>
            <TabsContent value="runs">{lastRuns}</TabsContent>
          </Tabs>
        )}
      </DialogBody>
    </>
  )
}
