/**
 * Phase 1a templates, grouped Readings / Binary sensors. One line says
 * what exclusion does. Math, integral and statistics stay hidden.
 */
import { type GroupTemplateId, groupTemplate } from '@camstack/types'
import { Button } from '@camstack/ui-library'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { helperTemplateGroups } from './helper-form-model'

export interface HelperTemplatePickerProps {
  readonly onPick: (templateId: GroupTemplateId) => void
}

export function HelperTemplatePicker({ onPick }: HelperTemplatePickerProps): ReactNode {
  const { t } = useTranslation()
  return (
    <div className="flex flex-col gap-4" data-testid="helper-template-picker">
      {helperTemplateGroups().map((group) => (
        <section key={group.id} aria-label={t(`helper.group.${group.id}`)}>
          <h3 className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-foreground-subtle">
            {t(`helper.group.${group.id}`)}
          </h3>
          <ul className="flex flex-col gap-1.5">
            {group.templateIds.map((id) => {
              const template = groupTemplate(id)
              if (template === null) return null
              return (
                <li key={id}>
                  <Button
                    type="button"
                    variant="outline"
                    className="h-auto w-full justify-start px-3 py-2 text-left"
                    data-testid={`helper-template-${id}`}
                    onClick={() => onPick(id)}
                  >
                    <span className="flex min-w-0 flex-col items-start gap-0.5">
                      <span className="text-xs font-medium text-foreground">
                        {t(`helper.template.${id}`)}
                      </span>
                      <span className="text-[11px] font-normal whitespace-normal text-foreground-muted">
                        {t(`helper.template.${id}Summary`)}
                      </span>
                    </span>
                  </Button>
                </li>
              )
            })}
          </ul>
        </section>
      ))}
    </div>
  )
}
