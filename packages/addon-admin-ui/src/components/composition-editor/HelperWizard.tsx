/**
 * New or edit a group helper as its template (D944). Three steps: template,
 * reducer / name / room, members via the common source selector.
 */
import { type GroupTemplateId, groupTemplate } from '@camstack/types'
import { Button, Input, Select } from '@camstack/ui-library'
import { type ReactNode, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { SourceSelector } from '../device/customize/source-selector/SourceSelector'
import { HelperTemplatePicker } from './HelperTemplatePicker'
import {
  canSaveDraft,
  draftForTemplate,
  type HelperFormDraft,
  memberRequest,
  type RefusalLine,
  withAggregate,
  withName,
  withRoom,
  withTemplate,
} from './helper-form-model'

type WizardStep = 'template' | 'parameters' | 'members'

export interface HelperWizardProps {
  readonly initial: HelperFormDraft | null
  readonly start: WizardStep
  readonly saving: boolean
  readonly onSave: (draft: HelperFormDraft) => Promise<readonly RefusalLine[]>
}

export function HelperWizard({ initial, start, saving, onSave }: HelperWizardProps): ReactNode {
  const { t } = useTranslation()
  const [step, setStep] = useState<WizardStep>(initial === null ? 'template' : start)
  const [draft, setDraft] = useState<HelperFormDraft | null>(initial)
  const [refusals, setRefusals] = useState<readonly RefusalLine[]>([])

  const pickTemplate = (templateId: GroupTemplateId): void => {
    setDraft((current) =>
      current === null ? draftForTemplate(templateId) : withTemplate(current, templateId),
    )
    setRefusals([])
    setStep('parameters')
  }

  const request = draft === null ? null : memberRequest(draft)
  const template = draft === null ? null : groupTemplate(draft.templateId)

  return (
    <div className="flex flex-col gap-3" data-testid="helper-wizard">
      <p className="text-[11px] text-foreground-muted">{t(`helper.step.${step}`)}</p>
      {step === 'template' && <HelperTemplatePicker onPick={pickTemplate} />}
      {step === 'parameters' && draft !== null && template !== null && (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-[11px]">
            {t('helper.reducer')}
            <Select
              aria-label={t('helper.reducer')}
              value={draft.aggregate}
              onChange={(event) => {
                const next = template.aggregates.find((item) => item === event.target.value)
                if (next !== undefined) setDraft(withAggregate(draft, next))
              }}
              options={template.aggregates.map((item) => ({
                value: item,
                label: t(`helper.aggregate.${item}`),
              }))}
            />
          </label>
          <label className="flex flex-col gap-1 text-[11px]">
            {t('helper.name')}
            <Input
              aria-label={t('helper.name')}
              data-testid="helper-name"
              value={draft.name}
              onChange={(event) => setDraft(withName(draft, event.target.value))}
            />
          </label>
          <label className="flex flex-col gap-1 text-[11px]">
            {t('helper.room')}
            <Input
              aria-label={t('helper.room')}
              value={draft.room}
              onChange={(event) => setDraft(withRoom(draft, event.target.value))}
            />
          </label>
        </div>
      )}
      {step === 'members' && draft !== null && request !== null && (
        <SourceSelector
          kind="members"
          request={request}
          enabled
          members={draft.members}
          onMembersChange={(members) => setDraft({ ...draft, members })}
          onRefuse={(reason) =>
            setRefusals(
              reason === null
                ? []
                : [
                    {
                      path: 'helper.members',
                      code: 'member-constraint',
                      message: t('helper.maxMembers', { max: reason.max }),
                    },
                  ],
            )
          }
        />
      )}
      <RefusalList lines={refusals} />
      <div className="flex flex-wrap gap-2">
        {step !== 'template' && (
          <Button
            variant="ghost"
            onClick={() => setStep(step === 'members' ? 'parameters' : 'template')}
          >
            {t('helper.back')}
          </Button>
        )}
        {step === 'parameters' && draft !== null && (
          <Button
            data-testid="helper-to-members"
            disabled={draft.name.trim() === ''}
            onClick={() => {
              setRefusals([])
              setStep('members')
            }}
          >
            {t('helper.next')}
          </Button>
        )}
        {step === 'members' && draft !== null && (
          <Button
            data-testid="helper-save"
            disabled={!canSaveDraft(draft) || saving}
            onClick={() => {
              void (async () => {
                setRefusals(await onSave(draft))
              })()
            }}
          >
            {t('helper.save')}
          </Button>
        )}
      </div>
    </div>
  )
}

function RefusalList({ lines }: { readonly lines: readonly RefusalLine[] }): ReactNode {
  if (lines.length === 0) return null
  return (
    <ul role="alert" className="flex flex-col gap-1" data-testid="helper-refusals">
      {lines.map((line) => (
        <li key={`${line.path}:${line.code}:${line.message}`} className="text-xs text-danger">
          <span className="font-medium">{line.code}</span>
          {line.message === '' ? '' : ` — ${line.message}`}
        </li>
      ))}
    </ul>
  )
}
