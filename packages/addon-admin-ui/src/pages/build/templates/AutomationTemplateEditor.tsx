/**
 * The automation template editor (#527), inline in the Templates tab: name,
 * description, the body — edited with the SAME WHEN / THEN editors as an
 * automation — and the Inputs panel with "Mark as input". A shipped (built-in)
 * template opens read-only with Duplicate; Export JSON downloads the versioned
 * file of any template.
 */
import {
  AutomationTemplatePayloadSchema,
  type AutomationRecipe,
  type AutomationTemplatePayload,
  exportAutomationTemplate,
} from '@camstack/types'
import { Badge, Button, FormField, Input, SectionCard, Textarea } from '@camstack/ui-library'
import { Copy, Download, Loader2 } from 'lucide-react'
import { type ReactNode, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TemplateDraft } from '../../../components/remote/TemplateEditorDialog'
import { ActionList } from '../automation/ActionList'
import { useAutomationDevices } from '../automation/automation-data'
import { withActions } from '../automation/recipe-parts'
import { RunModeSelector, runModeOf, withRunMode } from '../automation/RunModeSelector'
import { TriggerRowsProvider } from '../automation/trigger-rows-context'
import { ensureTriggerIds } from '../automation/triggered-by-model'
import { WhenTree } from '../automation/WhenTree'
import { bodyOfRecipe, recipeOfBody } from './body-recipe'
import { InputsPanel } from './InputsPanel'

export interface AutomationTemplateTarget {
  /** `null` for a template that does not exist yet. */
  readonly id: string | null
  readonly name: string
  readonly payload: AutomationTemplatePayload
  readonly builtIn: boolean
}

export interface AutomationTemplateEditorProps {
  readonly template: AutomationTemplateTarget
  readonly saving: boolean
  readonly error: string | null
  readonly onSave: (draft: TemplateDraft) => void
  readonly onDuplicate: (draft: TemplateDraft) => void
  readonly onClose: () => void
}

/** Downloads `text` as a file — the browser's own save, no library for it. */
function download(filename: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }))
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  URL.revokeObjectURL(url)
}

function fileNameOf(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return `${slug === '' ? 'automation-template' : slug}.json`
}

export function AutomationTemplateEditor({
  template,
  saving,
  error,
  onSave,
  onDuplicate,
  onClose,
}: AutomationTemplateEditorProps): ReactNode {
  const { t } = useTranslation()
  const readOnly = template.builtIn
  const [name, setName] = useState(template.name)
  const [payload, setPayload] = useState<AutomationTemplatePayload>(template.payload)
  const devices = useAutomationDevices()
  const recipe = useMemo(() => recipeOfBody(payload.body), [payload.body])
  const checked = useMemo(() => AutomationTemplatePayloadSchema.safeParse(payload), [payload])
  const canSave = !readOnly && name.trim() !== '' && checked.success && !saving

  const setRecipe = (next: AutomationRecipe): void =>
    setPayload({ ...payload, body: bodyOfRecipe(ensureTriggerIds(next)) })
  const draft = (): TemplateDraft => ({
    id: template.id,
    kind: 'automation',
    name: name.trim(),
    payload,
  })

  return (
    <div className="space-y-4" data-testid="automation-template-editor">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="min-w-0 flex-1 truncate text-sm font-semibold">
          {template.id === null
            ? t('build.templates.newAutomationTemplate', 'New automation template')
            : name}
        </h3>
        {readOnly && (
          <Badge variant="neutral" data-testid="template-builtin-badge">
            {t('build.templates.builtIn', 'Built-in')}
          </Badge>
        )}
      </div>
      {readOnly && (
        <p className="text-xs text-foreground-muted">
          {t(
            'build.templates.builtInHint',
            'Shipped with CamStack and read-only. Duplicate it to make a copy you can change.',
          )}
        </p>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <FormField label={t('remote.templates.name', 'Name')}>
          <Input
            value={name}
            maxLength={120}
            disabled={readOnly}
            onChange={(e) => setName(e.target.value)}
            data-testid="template-name"
          />
        </FormField>
        <FormField label={t('build.templates.description', 'Description')}>
          <Textarea
            rows={2}
            value={payload.description ?? ''}
            disabled={readOnly}
            maxLength={500}
            onChange={(e) => {
              const { description: _old, ...rest } = payload
              setPayload(e.target.value === '' ? rest : { ...rest, description: e.target.value })
            }}
            data-testid="template-description"
          />
        </FormField>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_24rem]">
        <SectionCard headingId="template-body" title={t('build.templates.body', 'Automation')}>
          <div className="space-y-4 p-3" data-testid="template-body-editor">
            {recipe === null ? (
              <pre className="max-h-96 overflow-auto rounded bg-surface-hover p-3 text-xs">
                {JSON.stringify(payload.body, null, 2)}
              </pre>
            ) : (
              // `inert` makes a shipped template a read-only view of the same editors.
              <div className="space-y-4" inert={readOnly}>
                <TriggerRowsProvider when={recipe.when}>
                  <div>
                    <p className="mb-1 text-xs font-medium uppercase text-foreground-subtle">
                      {t('automation.automationEditor.when', 'When')}
                    </p>
                    <WhenTree recipe={recipe} devices={devices} onChange={setRecipe} />
                  </div>
                  <div>
                    <p className="mb-1 text-xs font-medium uppercase text-foreground-subtle">
                      {t('automation.automationEditor.then', 'Then')}
                    </p>
                    <ActionList
                      flowControl
                      actions={recipe.actions}
                      devices={devices}
                      onChange={(actions) => setRecipe(withActions(recipe, actions))}
                    />
                  </div>
                  <div>
                    <p className="mb-1 text-xs font-medium uppercase text-foreground-subtle">
                      {t('flow.runMode.title', 'Overlap')}
                    </p>
                    <RunModeSelector
                      value={runModeOf(recipe)}
                      onChange={(mode) => setRecipe(withRunMode(recipe, mode))}
                    />
                  </div>
                </TriggerRowsProvider>
              </div>
            )}
          </div>
        </SectionCard>
        <SectionCard headingId="template-inputs" title={t('build.templates.inputs', 'Inputs')}>
          <div className="p-3">
            <InputsPanel payload={payload} readOnly={readOnly} onChange={setPayload} />
          </div>
        </SectionCard>
      </div>

      {!readOnly && !checked.success && (
        <p className="rounded border border-warning/40 bg-warning/10 p-3 text-xs text-warning">
          {checked.error.issues[0]?.message ?? ''}
        </p>
      )}
      {error !== null && (
        <p
          role="alert"
          className="rounded border border-danger/40 bg-danger/10 p-3 text-xs text-danger"
        >
          {error}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {!readOnly && (
          <Button disabled={!canSave} onClick={() => onSave(draft())} data-testid="template-save">
            {saving && <Loader2 className="h-4 w-4 animate-spin" />} {t('common.save', 'Save')}
          </Button>
        )}
        {readOnly && (
          <Button onClick={() => onDuplicate(draft())} data-testid="template-duplicate">
            <Copy className="h-4 w-4" aria-hidden />
            {t('remote.templates.duplicate', 'Duplicate')}
          </Button>
        )}
        <Button
          variant="outline"
          disabled={!checked.success}
          onClick={() => {
            if (!checked.success) return
            download(
              fileNameOf(name),
              JSON.stringify(exportAutomationTemplate(name.trim(), checked.data), null, 2),
            )
          }}
          data-testid="template-export"
        >
          <Download className="h-4 w-4" aria-hidden />
          {t('build.templates.exportJson', 'Export JSON')}
        </Button>
        <Button variant="ghost" onClick={onClose} disabled={saving}>
          {t('common.close', 'Close')}
        </Button>
      </div>
    </div>
  )
}
