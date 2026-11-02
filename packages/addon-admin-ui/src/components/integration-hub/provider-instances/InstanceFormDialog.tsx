/**
 * Create or edit one `integration-instances` record. The form is the provider's own
 * `instanceFormSchema`, drawn by the controlled `ConfigFormBuilder`; the values start as the
 * record's view, so a stored secret is a "set" view and never text.
 *
 * Save sends only what the operator changed (`diffInstanceValues`): an untouched secret is not in
 * the patch, a typed one replaces the stored value and a cleared one travels as the field's own
 * clear marker. A new record is created under its id first, then patched with the typed keys.
 */
import {
  hydrateSchema,
  type IntegrationInstance,
  type IntegrationInstanceDescription,
} from '@camstack/types'
import { Button, ConfigFormBuilder, Input, ItemFormDialog, useSystem } from '@camstack/ui-library'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2 } from 'lucide-react'
import { useMemo, useState, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import {
  TestVerdictBanner,
  toTestVerdict,
  type TestVerdict,
} from '../../integrations/connection-test-verdict'
import { pushToast } from '../../ui/toast-bus'
import { HOLDER_QUERY_KEY } from './use-provider-instances-data'
import { diffInstanceValues, mintInstanceId, randomHex8 } from './provider-instances-model'

export interface InstanceFormDialogProps {
  readonly addonId: string
  readonly providerName: string
  readonly description: IntegrationInstanceDescription
  /** The record being edited, or null for a new one. */
  readonly instance: IntegrationInstance | null
  readonly onClose: () => void
}

const NO_VALUES: Readonly<Record<string, unknown>> = {}

export function InstanceFormDialog({
  addonId,
  providerName,
  description,
  instance,
  onClose,
}: InstanceFormDialogProps): ReactElement {
  const { t } = useTranslation()
  const system = useSystem()
  const queryClient = useQueryClient()
  const stored = instance?.formValues ?? NO_VALUES
  const instanceId = instance?.id ?? null

  const [name, setName] = useState(instance?.name ?? providerName)
  const [values, setValues] = useState<Record<string, unknown>>({ ...stored })
  const [error, setError] = useState<string | null>(null)
  const [verdict, setVerdict] = useState<TestVerdict | null>(null)

  const schemaQuery = useQuery({
    queryKey: ['provider-instance-form', addonId, instanceId],
    queryFn: () =>
      system.trpcClient.integrationInstances.instanceFormSchema.query({ addonId, id: instanceId }),
  })
  const hydrated = useMemo(
    () => (schemaQuery.data ? hydrateSchema(schemaQuery.data, { ...stored }) : null),
    [schemaQuery.data, stored],
  )

  const save = useMutation({
    mutationFn: async (): Promise<void> => {
      const client = system.trpcClient.integrationInstances
      const patch = diffInstanceValues(stored, values)
      if (instance === null) {
        const id = mintInstanceId(description.instanceMode, addonId, randomHex8)
        await client.createInstance.mutate({ addonId, id, name: name.trim() })
        if (Object.keys(patch).length > 0) {
          await client.updateInstance.mutate({ addonId, id, values: patch })
        }
        return
      }
      await client.updateInstance.mutate({
        addonId,
        id: instance.id,
        name: name.trim(),
        values: patch,
      })
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [HOLDER_QUERY_KEY] })
      pushToast({
        title: t('providerInstances.saved', 'Saved'),
        message: name.trim(),
        severity: 'info',
      })
      onClose()
    },
    onError: (err: Error) => setError(err.message),
  })

  const test = useMutation({
    mutationFn: () =>
      system.trpcClient.integrationInstances.testInstance.mutate({
        addonId,
        id: instanceId,
        values: diffInstanceValues(stored, values),
      }),
    onSuccess: (result) => setVerdict(toTestVerdict(result)),
    // A transport failure of the CALL is not a verdict on the credentials.
    onError: (err: Error) => setVerdict({ status: 'inconclusive', error: err.message }),
  })

  const title =
    instance === null
      ? t('providerInstances.createTitle', 'Add {{provider}}', { provider: providerName })
      : t('providerInstances.editTitle', 'Edit {{name}}', { name: instance.name })

  return (
    <ItemFormDialog
      open
      onClose={onClose}
      title={title}
      error={error ?? (schemaQuery.isError ? schemaQuery.error.message : null)}
      width="lg"
      footer={
        <>
          {description.canTest && (
            <Button
              size="sm"
              variant="outline"
              type="button"
              disabled={test.isPending || hydrated === null}
              onClick={() => {
                setVerdict(null)
                test.mutate()
              }}
            >
              {test.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              {t('providerInstances.test', 'Test connection')}
            </Button>
          )}
          <Button
            size="sm"
            type="button"
            disabled={save.isPending || hydrated === null || name.trim().length === 0}
            onClick={() => {
              setError(null)
              save.mutate()
            }}
          >
            {save.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            {instance === null
              ? t('providerInstances.create', 'Create')
              : t('providerInstances.saveChanges', 'Save changes')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div>
          <label
            htmlFor="provider-instance-name"
            className="mb-1 block text-[11px] font-medium text-foreground"
          >
            {t('providerInstances.colName', 'Name')}
          </label>
          <Input
            id="provider-instance-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        {hydrated === null ? (
          schemaQuery.isError ? null : (
            <div className="flex items-center gap-2 text-xs text-foreground-subtle">
              <Loader2 className="h-3 w-3 animate-spin" />
              {t('providerInstances.loading', 'Loading…')}
            </div>
          )
        ) : (
          <ConfigFormBuilder schema={hydrated} values={values} onChange={setValues} />
        )}
        {verdict !== null && <TestVerdictBanner verdict={verdict} />}
      </div>
    </ItemFormDialog>
  )
}
