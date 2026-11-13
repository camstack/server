/**
 * An automation made from a template (#527): its name and the inputs form — no
 * trigger, no steps. New instances start from the template's defaults; an
 * existing one opens with the values it was saved with. Save expands the values
 * client-side into the block the hub stores. An instance the template has since
 * outgrown is flagged with the reason; "Convert to a free automation" drops the
 * link and keeps the automation as it last ran. A template that is gone leaves
 * only that choice.
 */
import type {
  AutomationRecipe,
  AutomationTemplatePayload,
  CoreBlock,
  CoreBlockInput,
  TemplateInputValues,
  TemplateInstanceProblem,
} from '@camstack/types'
import { Badge, Button, Input, useConfirm } from '@camstack/ui-library'
import { Loader2 } from 'lucide-react'
import { type ReactNode, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { TemplateInputsForm } from './TemplateInputsForm'
import { convertInstance, expandInstance, wholeProblems } from './template-values'

export interface TemplateInstanceEditorProps {
  readonly templateId: string
  readonly templateName: string | null
  /** `null` when the template the instance points at no longer exists. */
  readonly payload: AutomationTemplatePayload | null
  /** `null` while creating. */
  readonly existing: CoreBlock | null
  /** The stored recipe of an existing instance — what "convert" keeps. */
  readonly currentRecipe: AutomationRecipe | null
  readonly initialName: string
  readonly initialValues: TemplateInputValues
  /** What the last re-expansion reported; shown until the values are saved again. */
  readonly storedProblems: readonly TemplateInstanceProblem[]
  readonly saving: boolean
  readonly saveError: string | null
  readonly onSave: (input: CoreBlockInput) => void
  readonly onCancel: () => void
}

export function TemplateInstanceEditor({
  templateId,
  templateName,
  payload,
  existing,
  currentRecipe,
  initialName,
  initialValues,
  storedProblems,
  saving,
  saveError,
  onSave,
  onCancel,
}: TemplateInstanceEditorProps): ReactNode {
  const { t } = useTranslation()
  const confirm = useConfirm()
  const [name, setName] = useState(initialName)
  const [values, setValues] = useState<TemplateInputValues>(initialValues)
  const [attempted, setAttempted] = useState(false)
  const enabled = existing?.enabled ?? true
  const flagged = storedProblems.length > 0

  const expansion = useMemo(
    () =>
      payload === null ? null : expandInstance(templateId, payload, values, name.trim(), enabled),
    [payload, templateId, values, name, enabled],
  )
  const shownProblems = attempted && expansion !== null && !expansion.ok ? expansion.problems : []
  const nameMissing = name.trim() === ''

  const save = (): void => {
    setAttempted(true)
    if (expansion === null || !expansion.ok || nameMissing) return
    onSave(expansion.input)
  }

  const convert = async (): Promise<void> => {
    if (currentRecipe === null) return
    const accepted = await confirm({
      title: t('build.templates.convertTitle', 'Convert to a free automation?'),
      message: t(
        'build.templates.convertMessage',
        '{{name}} keeps running as it is, but stops following the template.',
        { name: name.trim() === '' ? initialName : name.trim() },
      ),
      confirmLabel: t('build.templates.convert', 'Convert to a free automation'),
    })
    if (!accepted) return
    const converted = convertInstance(
      currentRecipe,
      name.trim() === '' ? initialName : name.trim(),
      enabled,
    )
    if (converted.ok) onSave(converted.input)
  }

  return (
    <div className="space-y-4" data-testid="template-instance-editor">
      <div className="flex flex-wrap items-center gap-2 text-xs text-foreground-subtle">
        <span>
          {templateName === null
            ? t('build.templates.templateGone', 'The template of this automation no longer exists.')
            : t('build.templates.fromTemplate', 'From the template {{name}}', {
                name: templateName,
              })}
        </span>
        {flagged && (
          <Badge variant="warning" data-testid="template-flagged-badge">
            {t('build.templates.flagged', 'Flagged')}
          </Badge>
        )}
      </div>

      {flagged && (
        <div
          className="space-y-1 rounded border border-warning/40 bg-warning/10 p-3 text-xs text-warning"
          data-testid="template-flagged-problems"
        >
          <p className="font-medium">
            {t(
              'build.templates.flaggedExplain',
              'The template changed and these values no longer fit. The automation keeps running as it last did.',
            )}
          </p>
          <ul className="list-disc space-y-0.5 pl-4">
            {storedProblems.map((p) => (
              <li key={`${p.input ?? ''}:${p.detail}`}>{p.detail}</li>
            ))}
          </ul>
        </div>
      )}

      <label className="block max-w-md text-sm">
        <span className="text-foreground-subtle">
          {t('automation.automationEditor.name', 'Name')}
        </span>
        <Input
          className="mt-1"
          value={name}
          onChange={(e) => setName(e.target.value)}
          data-testid="template-instance-name"
        />
      </label>

      {payload !== null && (
        <TemplateInputsForm
          payload={payload}
          values={values}
          problems={shownProblems}
          disabled={saving}
          onChange={setValues}
        />
      )}

      {payload !== null &&
        wholeProblems(shownProblems, payload.inputs).map((p) => (
          <p
            key={p.detail}
            role="alert"
            className="rounded border border-warning/40 bg-warning/10 p-3 text-xs text-warning"
          >
            {p.detail}
          </p>
        ))}

      {saveError !== null && (
        <p className="rounded border border-danger/40 bg-danger/10 p-3 text-xs text-danger">
          {saveError}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {payload !== null && (
          <Button
            onClick={save}
            disabled={saving || nameMissing}
            data-testid="template-instance-save"
          >
            {saving && <Loader2 className="h-4 w-4 animate-spin" />} {t('common.save', 'Save')}
          </Button>
        )}
        {existing !== null && currentRecipe !== null && (
          <Button
            variant="outline"
            onClick={() => void convert()}
            disabled={saving}
            data-testid="template-instance-convert"
          >
            {t('build.templates.convert', 'Convert to a free automation')}
          </Button>
        )}
        <Button variant="ghost" onClick={onCancel} disabled={saving}>
          {t('common.close', 'Close')}
        </Button>
        {nameMissing && (
          <Badge variant="warning">
            {t('automation.automationEditor.nameRequired', 'Name required')}
          </Badge>
        )}
      </div>
    </div>
  )
}
