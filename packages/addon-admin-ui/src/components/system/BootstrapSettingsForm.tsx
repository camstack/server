/**
 * BootstrapSettingsForm - the `system-config` form (server name, sign-in
 * policy), drawn from the hub's `getBootstrapForm` action and saved through
 * `saveBootstrapForm`.
 *
 * A surface picks the sections it draws (`sectionIds`) or the ones it leaves to
 * another surface (`omitSectionIds`). With neither, this is System → Settings:
 * the sign-in policy stays on Identity → Authentication, every other section
 * stays here. Edits are held until Save; a refused save (a bad CIDR or origin)
 * writes nothing and says why.
 */
import { useCallback, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ConfigUISchemaWithValues } from '@camstack/types'
import { FormBuilder } from '../form-builder/FormBuilder'
import { FormSaveBar } from '../form-builder/FormSaveBar'
import { useBootstrapForm, useSaveBootstrapForm } from '../../hooks/use-bootstrap-form'
import { useFormSaveController } from '../../hooks/useFormSaveController'
import { flatFormValues } from '../../lib/config-schema-values'
import { shapeSections } from '../../lib/settings-section-shape'
import { SIGN_IN_POLICY_SECTION_ID } from '../../lib/sign-in-policy-section'

interface BootstrapSettingsFormProps {
  /** Draw only these sections. */
  readonly sectionIds?: readonly string[]
  /** Leave these sections to another surface. */
  readonly omitSectionIds?: readonly string[]
  /** Strip the section titles (the host draws a card title). */
  readonly hideSectionChrome?: boolean
  /** Shown when the hub did not answer. */
  readonly emptyMessage: string
}

export function BootstrapSettingsForm({
  sectionIds,
  omitSectionIds,
  hideSectionChrome,
  emptyMessage,
}: BootstrapSettingsFormProps): React.ReactElement | null {
  const form = useBootstrapForm()
  const shown = useMemo((): ConfigUISchemaWithValues | null => {
    if (form.data === undefined) return null
    const sections = form.data.sections.filter((s) => {
      if (sectionIds !== undefined && !sectionIds.includes(s.id)) return false
      if (omitSectionIds?.includes(s.id) === true) return false
      // Unscoped: the sign-in policy's owner is the Authentication page.
      if (sectionIds === undefined && s.id === SIGN_IN_POLICY_SECTION_ID) return false
      return true
    })
    return {
      ...form.data,
      sections: shapeSections(sections, {
        ...(hideSectionChrome === true ? { hideSectionChrome } : {}),
      }),
    }
  }, [form.data, sectionIds, omitSectionIds, hideSectionChrome])

  if (form.isPending) return null
  if (shown === null || form.isError) {
    return <p className="text-sm text-foreground-muted">{emptyMessage}</p>
  }
  if (shown.sections.length === 0) return null
  return <BootstrapFormBody schema={shown} />
}

function BootstrapFormBody({
  schema,
}: {
  readonly schema: ConfigUISchemaWithValues
}): React.ReactElement {
  const { t } = useTranslation()
  const save = useSaveBootstrapForm()
  const [error, setError] = useState<string | null>(null)
  const serverValues = useMemo(() => flatFormValues(schema), [schema])

  const onDeferredSave = useCallback(
    async (patch: Record<string, unknown>): Promise<void> => {
      setError(null)
      try {
        await save.mutateAsync({ patch })
      } catch (err: unknown) {
        setError(
          err instanceof Error && err.message.length > 0
            ? err.message
            : t('system.bootstrapForm.saveFailed', 'Could not save'),
        )
        throw err
      }
    },
    [save, t],
  )
  const controller = useFormSaveController({
    schema,
    serverValues,
    onImmediateSave: (patch) => void onDeferredSave(patch).catch(() => undefined),
    onDeferredSave,
  })

  return (
    <div className="flex flex-col gap-3">
      {error !== null && (
        <div
          role="alert"
          className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger"
        >
          {error}
        </div>
      )}
      <FormBuilder
        schema={schema}
        values={controller.values}
        onChange={controller.handleChange}
        disabled={save.isPending}
      />
      <FormSaveBar
        pendingCount={controller.pendingKeys.length}
        onSave={() => controller.handleSave(controller.pendingKeys)}
        onDiscard={() => controller.handleDiscard(controller.pendingKeys)}
        saving={save.isPending}
      />
    </div>
  )
}
