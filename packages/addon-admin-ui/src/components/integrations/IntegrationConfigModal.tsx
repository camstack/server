import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2 } from 'lucide-react'
import { hydrateSchema, type ConfigUISchema } from '@camstack/types'
import {
  Button,
  ConfigFormBuilder,
  Dialog,
  DialogBody,
  DialogContent,
  DialogHeader,
  DialogTitle,
  useSystem,
} from '@camstack/ui-library'

import { pushToast } from '../ui/toast-bus'
import { diffInstanceValues } from '../instances/instances-model'

type IntegrationWizardMode = 'standalone' | 'account' | 'broker'

interface IntegrationConfigModalProps {
  readonly integrationId: string
  readonly addonId: string
  readonly name: string
  /**
   * Cap kind from available-types. Kept for callers; the form is the instance
   * schema, not this kind.
   */
  readonly kind: 'device-adoption' | 'device-provider'
  /** Locked wizard mode — kept for callers. The form does not branch on it. */
  readonly mode: IntegrationWizardMode
  /** Broker kind for a `broker` integration. Kept for callers. */
  readonly brokerKind: string | null
  readonly canTest?: boolean
  readonly onClose: () => void
}

function isConfigSchema(value: unknown): value is ConfigUISchema {
  if (typeof value !== 'object' || value === null || !('sections' in value)) return false
  return Array.isArray(Reflect.get(value, 'sections'))
}

function formValuesOf(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || !('formValues' in value)) return {}
  const raw: unknown = Reflect.get(value, 'formValues')
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  return { ...raw }
}

/**
 * Edit one integration. The only form is that instance's `formSchema(id)`
 * (`integration-instances.instanceFormSchema`); a save writes the instance record.
 */
export function IntegrationConfigModal({
  integrationId,
  addonId,
  name,
  kind: _kind,
  mode: _mode,
  brokerKind: _brokerKind,
  canTest: _canTest = false,
  onClose,
}: IntegrationConfigModalProps) {
  void _kind
  void _mode
  void _brokerKind
  void _canTest
  const { t } = useTranslation()
  const system = useSystem()
  const queryClient = useQueryClient()
  const schemaQuery = useQuery({
    queryKey: ['integration-instance-form', addonId, integrationId],
    queryFn: () =>
      system.trpcClient.integrationInstances.instanceFormSchema.query({
        addonId,
        id: integrationId,
      }),
  })
  const instanceQuery = useQuery({
    queryKey: ['integration-instance', addonId, integrationId],
    queryFn: () =>
      system.trpcClient.integrationInstances.getInstance.query({
        addonId,
        id: integrationId,
      }),
  })
  const stored = formValuesOf(instanceQuery.data)
  const schema = isConfigSchema(schemaQuery.data) ? schemaQuery.data : null
  const loaded = schemaQuery.isSuccess && instanceQuery.isSuccess

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent width="lg" placement="sheet-on-mobile" scroll="body">
        <DialogHeader>
          <DialogTitle>
            {t('integrations.editConfig', { defaultValue: 'Edit configuration' })} — {name}
          </DialogTitle>
        </DialogHeader>
        <DialogBody>
          {schemaQuery.isError || instanceQuery.isError ? (
            <p className="text-[11px] text-danger">
              {t('integrations.loadFailed', {
                defaultValue: 'Could not load this integration.',
              })}
            </p>
          ) : !loaded ? (
            <div className="flex items-center gap-2 text-[11px] text-foreground-subtle">
              <Loader2 className="h-3 w-3 animate-spin" />
              {t('integrations.loading', { defaultValue: 'Loading…' })}
            </div>
          ) : schema === null ? (
            <p className="text-[11px] text-foreground-muted">
              {t('integrations.noInstanceForm', {
                defaultValue: 'This integration has no configuration form.',
              })}
            </p>
          ) : (
            <InstanceConfigFields
              addonId={addonId}
              integrationId={integrationId}
              name={name}
              schema={schema}
              stored={stored}
              onClose={onClose}
              onSaved={() => {
                void queryClient.invalidateQueries()
              }}
            />
          )}
        </DialogBody>
      </DialogContent>
    </Dialog>
  )
}

interface InstanceConfigFieldsProps {
  readonly addonId: string
  readonly integrationId: string
  readonly name: string
  readonly schema: ConfigUISchema
  readonly stored: Readonly<Record<string, unknown>>
  readonly onClose: () => void
  readonly onSaved: () => void
}

function InstanceConfigFields({
  addonId,
  integrationId,
  name,
  schema,
  stored,
  onClose,
  onSaved,
}: InstanceConfigFieldsProps) {
  const { t } = useTranslation()
  const system = useSystem()
  const [values, setValues] = useState<Record<string, unknown>>({ ...stored })
  const hydrated = hydrateSchema(schema, { ...stored })
  const save = useMutation({
    mutationFn: async () => {
      const patch = diffInstanceValues(stored, values)
      await system.trpcClient.integrationInstances.updateInstance.mutate({
        addonId,
        id: integrationId,
        values: patch,
      })
    },
    onSuccess: () => {
      onSaved()
      pushToast({
        title: t('integrations.saved', { defaultValue: 'Configuration saved' }),
        message: name,
        severity: 'info',
      })
      onClose()
    },
    onError: (err: Error) => {
      pushToast({
        title: t('integrations.saveFailed', {
          defaultValue: 'Could not save the configuration',
        }),
        message: `${name}: ${err.message}`,
        severity: 'critical',
      })
    },
  })

  return (
    <div className="space-y-3">
      <ConfigFormBuilder schema={hydrated} values={values} onChange={setValues} />
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="outline" type="button" onClick={onClose}>
          {t('common.cancel', { defaultValue: 'Cancel' })}
        </Button>
        <Button size="sm" type="button" disabled={save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
          {t('integrations.save', { defaultValue: 'Save' })}
        </Button>
      </div>
    </div>
  )
}
