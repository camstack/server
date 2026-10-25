/**
 * Dialog to edit one composition field as a formula (expression + bindings).
 */
import {
  compositionSourceKey,
  type CompositionExpressionSource,
  type CompositionFieldSource,
  type CompositionSourceRef,
} from '@camstack/types'
import { formulaProblem } from '@camstack/types'
import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@camstack/ui-library'
import { type ReactNode, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { nextBindingName } from '../../../composition-editor/draft-reducer'
import { ExpressionInput } from '../../../composition-editor/ExpressionInput'
import { LivePreview } from '../../../composition-editor/LivePreview'
import { vocabularyFieldLabel } from '../vocabulary-field-label'
import { SourcePicker } from '../SourcePicker'

const NO_NAMES: ReadonlyMap<string, string> = new Map()

function bindingLine(
  binding: CompositionFieldSource,
  names: ReadonlyMap<string, string>,
  language: string,
  unknownDevice: string,
): string {
  if (binding.kind !== 'from') return ''
  const name = names.get(compositionSourceKey(binding.source)) ?? unknownDevice
  return `${name} · ${vocabularyFieldLabel(binding.cap, binding.fieldPath, language)}`
}

export interface FormulaSelfNative {
  readonly source: CompositionSourceRef
  readonly cap: string
  readonly fieldPath: string
}

export interface FormulaFieldDialogProps {
  readonly open: boolean
  readonly title: string
  readonly fieldPath: string
  readonly fieldLabel?: string
  readonly sourceNames?: ReadonlyMap<string, string>
  readonly initial: CompositionFieldSource
  /** Bind a name to this device's own native value of the field. */
  readonly selfNative?: FormulaSelfNative | null
  readonly onClose: () => void
  readonly onSave: (source: CompositionFieldSource) => void
}

type PickerMode = 'idle' | 'add-binding'

export function FormulaFieldDialog({
  open,
  title,
  fieldPath,
  fieldLabel,
  sourceNames = NO_NAMES,
  initial,
  selfNative = null,
  onClose,
  onSave,
}: FormulaFieldDialogProps): ReactNode {
  const { t, i18n } = useTranslation()
  const seed: CompositionExpressionSource =
    initial.kind === 'expression' ? initial : { kind: 'expression', expr: 'null', bindings: {} }
  const [draft, setDraft] = useState(seed)
  const [picker, setPicker] = useState<PickerMode>('idle')
  const problem = formulaProblem(draft.expr, draft.bindings)
  const bindingNames = Object.keys(draft.bindings)

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
    >
      <DialogContent
        width="lg"
        scroll="body"
        placement="sheet-on-mobile"
        data-testid="formula-dialog"
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-2">
          <span className="text-xs text-foreground">
            {fieldLabel ?? vocabularyFieldLabel('', fieldPath, i18n.language)}
          </span>
          <ExpressionInput
            label={t('compositionEditor.formulaFor', { path: fieldLabel ?? fieldPath })}
            value={draft.expr}
            bindings={bindingNames}
            onChange={(expr) => setDraft({ ...draft, expr })}
          />
          <ul className="flex flex-col gap-0.5 text-[11px]">
            {Object.entries(draft.bindings).map(([name, binding]) => (
              <li key={name} className="flex flex-wrap items-center gap-2">
                <span className="font-mono">{name}</span>
                <span>
                  {binding.kind === 'from'
                    ? bindingLine(
                        binding,
                        sourceNames,
                        i18n.language,
                        t('customize.fieldsCard.unknownDevice'),
                      )
                    : JSON.stringify(binding.value)}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={t('compositionEditor.removeBinding', { name })}
                  onClick={() => {
                    const { [name]: _, ...rest } = draft.bindings
                    setDraft({ ...draft, bindings: rest })
                  }}
                >
                  ×
                </Button>
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap gap-2">
            {selfNative !== null && (
              <Button
                size="sm"
                variant="outline"
                data-testid="formula-self-native"
                onClick={() => {
                  const existing = Object.keys(draft.bindings)
                  const name = draft.bindings.v === undefined ? 'v' : nextBindingName(existing)
                  setDraft({
                    ...draft,
                    bindings: {
                      ...draft.bindings,
                      [name]: {
                        kind: 'from',
                        source: selfNative.source,
                        cap: selfNative.cap,
                        fieldPath: selfNative.fieldPath,
                      },
                    },
                  })
                }}
              >
                {t('customize.override.selfNative')}
              </Button>
            )}
            <Button size="sm" variant="outline" onClick={() => setPicker('add-binding')}>
              {t('compositionEditor.addSource')}
            </Button>
          </div>
          {problem !== null && (
            <p role="alert" className="text-xs text-danger">
              {problem}
            </p>
          )}
          <LivePreview source={draft} />
          {picker === 'add-binding' && (
            <SourcePicker
              title={t('compositionEditor.addSource')}
              targetKind={null}
              onCancel={() => setPicker('idle')}
              onPick={(pick) => {
                const name = nextBindingName(bindingNames)
                setDraft({
                  ...draft,
                  bindings: {
                    ...draft.bindings,
                    [name]: {
                      kind: 'from',
                      source: pick.ref,
                      cap: pick.cap,
                      fieldPath: pick.path,
                    },
                  },
                })
                setPicker('idle')
              }}
            />
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            {t('compositionEditor.cancel')}
          </Button>
          <Button
            data-testid="formula-dialog-save"
            disabled={problem !== null}
            onClick={() => {
              onSave(draft)
              onClose()
            }}
          >
            {t('compositionEditor.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
