/**
 * Create or edit one `integration-instances` record. The form is the provider's own
 * `instanceFormSchema`, drawn by the controlled `ConfigFormBuilder`; the values start as the
 * record's view, so a stored secret is a "set" view and never text.
 *
 * A provider that declares kinds adds a kind picker on create (only when there is a choice), a
 * kind with `signIn` offers the interactive sign-in panel (the same one a broker uses), and a
 * kind with `connectPath` a Connect button on an existing record. When the provider allows it,
 * Add can restore a removed instance under its old id.
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
import { Button, ConfigFormBuilder, ItemFormDialog, useSystem } from '@camstack/ui-library'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link2, Loader2 } from 'lucide-react'
import { useMemo, useState, type ReactElement, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { fillBrokerConnectPath, startServerNavigation } from '../../lib/broker-oauth-popup'
import type { ConfigUISchema } from '../../types/config-ui'
import { BrokerSignInPanel } from '../brokers/BrokerSignInPanel'
import { FormBuilder } from '../form-builder/FormBuilder'
import {
  TestVerdictBanner,
  toTestVerdict,
  type TestVerdict,
} from '../integrations/connection-test-verdict'
import { pushToast } from '../ui/toast-bus'
import { HOLDER_QUERY_KEY } from './use-instances-data'
import {
  diffInstanceValues,
  effectiveInstanceValues,
  findKind,
  mintInstanceId,
  needsKindPicker,
  randomHex8,
} from './instances-model'

const IDENTITY_NAME = 'name'
const IDENTITY_KIND = 'kind'
const IDENTITY_RESTORE = 'restore'
const IDENTITY_RESTORE_ID = 'restoreId'

export interface InstanceEditorDialogProps {
  readonly addonId: string
  readonly providerName: string
  readonly description: IntegrationInstanceDescription
  /** The record being edited, or null for a new one. */
  readonly instance: IntegrationInstance | null
  readonly onClose: () => void
  /** The record exists: created, edited or signed in. A wizard that needs the id uses this. */
  readonly onSaved?: (id: string) => void
  /** A block shown above the form (setup, pairing) — only for a record that exists. */
  readonly lead?: ReactNode
}

const NO_VALUES: Readonly<Record<string, unknown>> = {}

export function InstanceEditorDialog({
  addonId,
  providerName,
  description,
  instance,
  onClose,
  onSaved,
  lead,
}: InstanceEditorDialogProps): ReactElement {
  const { t } = useTranslation()
  const system = useSystem()
  const queryClient = useQueryClient()
  const stored = instance?.formValues ?? NO_VALUES
  const instanceId = instance?.id ?? null

  const kinds = description.kinds ?? []
  const [identity, setIdentity] = useState<Record<string, unknown>>({
    [IDENTITY_NAME]: instance?.name ?? providerName,
    [IDENTITY_KIND]: instance?.kind ?? kinds[0]?.id ?? '',
    [IDENTITY_RESTORE]: false,
    [IDENTITY_RESTORE_ID]: '',
  })
  const textOf = (key: string): string => {
    const v = identity[key]
    return typeof v === 'string' ? v.trim() : ''
  }
  const name = textOf(IDENTITY_NAME)
  const kindId = textOf(IDENTITY_KIND)
  const kind = findKind(description, kindId === '' ? undefined : kindId)
  const restoring = identity[IDENTITY_RESTORE] === true
  const restoreId = textOf(IDENTITY_RESTORE_ID)
  // A sign-in mints the record under a fresh id, so "restore under its old id" does not apply.
  const canRestore =
    instance === null && description.allowRestoreId === true && kind?.signIn === undefined
  const restoreMissing = canRestore && restoring && restoreId === ''
  const [values, setValues] = useState<Record<string, unknown>>({ ...stored })
  const [error, setError] = useState<string | null>(null)
  const identitySchema = useMemo<ConfigUISchema>(
    () => ({
      sections: [
        {
          id: 'instance-identity',
          title: t('providerInstances.identity', 'Identity'),
          columns: 1,
          fields: [
            ...(instance === null && needsKindPicker(description)
              ? [
                  {
                    type: 'select' as const,
                    key: IDENTITY_KIND,
                    label: t('providerInstances.colKind', 'Kind'),
                    options: kinds.map((k) => ({
                      value: k.id,
                      label: k.label,
                    })),
                  },
                ]
              : []),
            {
              type: 'text' as const,
              key: IDENTITY_NAME,
              label: t('providerInstances.colName', 'Name'),
              required: true,
            },
            ...(canRestore
              ? [
                  {
                    type: 'boolean' as const,
                    key: IDENTITY_RESTORE,
                    label: t('providerInstances.restore', 'Restore under its old id'),
                    description: t(
                      'providerInstances.restoreHint',
                      'Re-adding something that was removed under its original id keeps everything that points at it working.',
                    ),
                  },
                  {
                    type: 'text' as const,
                    key: IDENTITY_RESTORE_ID,
                    label: t('providerInstances.originalId', 'Original id'),
                    required: true,
                    showWhen: { field: IDENTITY_RESTORE, equals: true },
                  },
                ]
              : []),
          ],
        },
      ],
    }),
    [canRestore, description, instance, kinds, t],
  )
  const [verdict, setVerdict] = useState<TestVerdict | null>(null)

  const schemaQuery = useQuery({
    queryKey: ['provider-instance-form', addonId, instanceId],
    queryFn: () =>
      system.trpcClient.integrationInstances.instanceFormSchema.query({
        addonId,
        id: instanceId,
      }),
  })
  const hydrated = useMemo(
    () => (schemaQuery.data ? hydrateSchema(schemaQuery.data, { ...stored }) : null),
    [schemaQuery.data, stored],
  )

  const save = useMutation({
    mutationFn: async (): Promise<string> => {
      const client = system.trpcClient.integrationInstances
      const patch = diffInstanceValues(stored, values)
      if (instance === null) {
        // The old id wins; else the provider mints one when it can; else the UI mints an opaque id.
        const chosen =
          canRestore && restoring
            ? restoreId
            : description.mintsId === true
              ? undefined
              : mintInstanceId(description.instanceMode, addonId, randomHex8)
        const created = await client.createInstance.mutate({
          addonId,
          name,
          ...(chosen !== undefined ? { id: chosen } : {}),
          ...(kindId !== '' ? { kind: kindId } : {}),
        })
        if (Object.keys(patch).length > 0) {
          await client.updateInstance.mutate({
            addonId,
            id: created.id,
            values: patch,
          })
        }
        return created.id
      }
      await client.updateInstance.mutate({
        addonId,
        id: instance.id,
        name,
        values: patch,
      })
      return instance.id
    },
    onSuccess: (savedId) => {
      void queryClient.invalidateQueries({ queryKey: [HOLDER_QUERY_KEY] })
      pushToast({
        title: t('providerInstances.saved', 'Saved'),
        message: name,
        severity: 'info',
      })
      onSaved?.(savedId)
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
      ? t('providerInstances.createTitle', 'Add {{provider}}', {
          provider: providerName,
        })
      : t('providerInstances.editTitle', 'Edit {{name}}', {
          name: instance.name,
        })

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
            disabled={save.isPending || hydrated === null || name.length === 0 || restoreMissing}
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
        {instance !== null ? lead : null}
        <FormBuilder schema={identitySchema} values={identity} onChange={setIdentity} />
        {kind?.signIn !== undefined && (
          <BrokerSignInPanel
            basePath={kind.signIn.basePath}
            {...(kind.signIn.methods !== undefined ? { methods: kind.signIn.methods } : {})}
            name={name}
            {...(instance !== null ? { brokerId: instance.id } : {})}
            getSettings={() => effectiveInstanceValues(stored, values)}
            disabled={name.length === 0}
            onSignedIn={(signedInId) => {
              void queryClient.invalidateQueries({
                queryKey: [HOLDER_QUERY_KEY],
              })
              onSaved?.(signedInId)
              onClose()
            }}
          />
        )}
        {instance !== null && kind?.connectPath !== undefined && (
          <Button
            size="sm"
            variant="outline"
            type="button"
            onClick={() =>
              startServerNavigation(
                fillBrokerConnectPath(kind.connectPath ?? '', instance.id),
                () =>
                  void queryClient.invalidateQueries({
                    queryKey: [HOLDER_QUERY_KEY],
                  }),
              )
            }
          >
            <Link2 className="h-3.5 w-3.5" />
            {t('providerInstances.connect', 'Connect account')}
          </Button>
        )}
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
