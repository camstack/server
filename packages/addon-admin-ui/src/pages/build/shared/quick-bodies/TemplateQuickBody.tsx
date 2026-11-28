/**
 * Template quick body: the inputs the template declares and the automations
 * that use it. A remote template declares no inputs and the server has no
 * "who uses this remote template" read, so it shows the kind and what exists.
 */
import { AutomationTemplatePayloadSchema, type TemplateRecord } from '@dominevo/types'
import { Badge, Skeleton, useCoreBlocksList } from '@dominevo/ui-library'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { templateKindView } from '../../../../components/remote/template-kinds'
import { parseRecipeFromCode } from '../../automation/recipe-from-code'
import { QuickSection } from '../QuickParts'

export interface TemplateQuickBodyProps {
  readonly row: TemplateRecord
}

/** The automation blocks whose recipe was made from template `templateId`. */
export function useTemplateInstances(
  templateId: string,
  enabled: boolean,
): {
  readonly pending: boolean
  readonly failed: boolean
  readonly blocks: readonly { id: string; name: string }[]
} {
  const list = useCoreBlocksList({}, { enabled })
  const blocks = (list.data?.blocks ?? [])
    .filter((block) => {
      const parsed = parseRecipeFromCode(block.code)
      return parsed.ok && parsed.recipe.template?.templateId === templateId
    })
    .map((block) => ({ id: block.id, name: block.name }))
  return {
    pending: enabled && list.data === undefined && !list.error,
    failed: list.error !== null && list.error !== undefined,
    blocks,
  }
}

export function TemplateQuickBody({ row }: TemplateQuickBodyProps): ReactNode {
  const { t } = useTranslation()
  const isAutomation = row.kind === 'automation'
  const parsed = AutomationTemplatePayloadSchema.safeParse(row.payload)
  const inputs = isAutomation && parsed.success ? parsed.data.inputs : []
  const instances = useTemplateInstances(row.id, isAutomation)
  return (
    <>
      <QuickSection title={t('build.quickModal.summary', 'Summary')}>
        <p className="text-sm">
          <Badge variant="neutral">{templateKindView(row.kind).label(t)}</Badge>
        </p>
        {!isAutomation && (
          <p className="mt-2 text-xs text-foreground-subtle">
            {templateKindView(row.kind).summary(row.payload, t)}
          </p>
        )}
      </QuickSection>
      {isAutomation && (
        <QuickSection title={t('build.quickModal.declaredInputs', 'Declared inputs')}>
          {inputs.length === 0 ? (
            <p className="text-xs text-foreground-subtle">
              {t('build.quickModal.noInputs', 'No inputs declared')}
            </p>
          ) : (
            <ul className="space-y-1 text-sm">
              {inputs.map((input) => (
                <li key={input.key} className="flex items-center gap-2">
                  <span className="font-medium">{input.label}</span>
                  <Badge variant="neutral">{input.kind}</Badge>
                </li>
              ))}
            </ul>
          )}
        </QuickSection>
      )}
      {isAutomation && (
        <QuickSection title={t('build.quickModal.instances', 'Used by')}>
          {instances.pending ? (
            <Skeleton className="h-8 w-full" />
          ) : instances.failed ? (
            <p className="text-xs text-foreground-subtle">
              {t('build.quickModal.instancesUnknown', 'The automations could not be read.')}
            </p>
          ) : instances.blocks.length === 0 ? (
            <p className="text-xs text-foreground-subtle">
              {t('build.quickModal.noInstances', 'No automation uses it yet')}
            </p>
          ) : (
            <ul className="space-y-1 text-sm">
              {instances.blocks.map((block) => (
                <li key={block.id}>
                  <Link
                    to={`/build?tab=automations&block=${encodeURIComponent(block.id)}`}
                    className="hover:underline"
                  >
                    {block.name}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </QuickSection>
      )}
    </>
  )
}
