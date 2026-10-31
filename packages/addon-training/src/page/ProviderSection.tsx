/**
 * Providers tab — managed list: DataTable + one ItemFormDialog per entry
 * (type → ConfigFormBuilder from type.configSchema). Save = createEntry+updateEntry
 * (new) or updateEntry (edit). Delete is only on the table via deleteEntry.
 * Secrets: keychain views in formValues (D787/D789), not NC D634 plaintext.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react'
import type {
  ConfigUISchema,
  TrainingCredentialCheck,
  TrainingProviderDescriptor,
  TrainingProviderType,
} from '@camstack/types'
import { addonCatalogHref, isSecretClear, isSecretFieldView, SECRET_CLEAR } from '@camstack/types'
import {
  Badge,
  Button,
  ConfigFormBuilder,
  DataTable,
  EmptyState,
  Input,
  ItemFormDialog,
  Label,
  Select,
  Skeleton,
  useCapabilityPresence,
  useConfirm,
  useItemFormUrl,
  type AddonPageProps,
  type DataColumn,
} from '@camstack/ui-library'
import { Cloud, Trash2 } from 'lucide-react'
import { useT } from '../i18n/index.js'
import { MODAL_ENTRY_CREATE_VALUES } from '../providers/modal/modal-entry-schema.js'
import { providerIconUrl } from './provider-icon-url.js'
import { errorText, useAsync } from './use-async.js'

export interface ProviderSectionProps {
  readonly trpc: AddonPageProps['trpc']
  readonly navigate: AddonPageProps['navigate']
  /** Pulse from page header Add — open create once, then clear. */
  readonly createRequested?: boolean
  readonly onCreateConsumed?: () => void
}

type CheckState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'running' }
  | { readonly kind: 'done'; readonly check: TrainingCredentialCheck }
  | { readonly kind: 'error'; readonly message: string }

function typesIdentityKey(
  types: readonly {
    readonly typeId: string
    readonly label: string
    readonly addonId: string
    readonly iconAsset: string
  }[],
): string {
  return types.map((t) => `${t.typeId}\0${t.label}\0${t.addonId}\0${t.iconAsset}`).join('\n')
}

/** Wire schema is `unknown`; tighten to ConfigUISchema for ConfigFormBuilder. */
function coerceProviderType(raw: {
  readonly typeId: string
  readonly label: string
  readonly iconAsset: string
  readonly addonId: string
  readonly configSchema?: unknown
}): TrainingProviderType {
  const schema = raw.configSchema
  if (schema === undefined || schema === null || typeof schema !== 'object') {
    return {
      typeId: raw.typeId,
      label: raw.label,
      iconAsset: raw.iconAsset,
      addonId: raw.addonId,
    }
  }
  return {
    typeId: raw.typeId,
    label: raw.label,
    iconAsset: raw.iconAsset,
    addonId: raw.addonId,
    configSchema: schema as ConfigUISchema,
  }
}

function CheckLine({ state }: { readonly state: CheckState }): JSX.Element | null {
  const { t } = useT()
  if (state.kind === 'idle') return null
  if (state.kind === 'running') {
    return <span className="text-xs text-foreground-subtle">{t('providers.check.asking')}</span>
  }
  if (state.kind === 'error') {
    return <span className="text-xs text-danger">{state.message}</span>
  }
  const { check } = state
  return check.ok ? (
    <span className="text-xs text-success">
      {check.account !== undefined
        ? t('providers.check.signedInAs', { account: check.account })
        : t('providers.check.signedIn')}
    </span>
  ) : (
    <span className="text-xs text-danger">
      {check.reason ?? t('providers.check.refused')}
      {check.detail !== undefined ? `: ${check.detail}` : ''}
    </span>
  )
}

function createValuesForType(typeId: string): Record<string, unknown> {
  if (typeId === 'modal') return { ...MODAL_ENTRY_CREATE_VALUES }
  return {}
}

function readTokenSecretWire(
  value: unknown,
  isCreate: boolean,
): string | typeof SECRET_CLEAR | undefined {
  if (isCreate) {
    return typeof value === 'string' && value.length > 0 ? value : undefined
  }
  if (isSecretClear(value)) return SECRET_CLEAR
  if (typeof value === 'string' && value.length > 0) return value
  if (isSecretFieldView(value) || value === null || value === '') return undefined
  return undefined
}

export function ProviderSection({
  trpc,
  navigate,
  createRequested = false,
  onCreateConsumed,
}: ProviderSectionProps): JSX.Element {
  const { t } = useT()
  const presence = useCapabilityPresence('training-provider')
  const confirm = useConfirm()
  const formUrl = useItemFormUrl({ editKey: 'edit', newKey: 'new' })
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [typeId, setTypeId] = useState('')
  const [name, setName] = useState('')
  const [formValues, setFormValues] = useState<Record<string, unknown>>({})
  const [check, setCheck] = useState<CheckState>({ kind: 'idle' })
  const seededKey = useRef<string | null>(null)
  /**
   * Set between the create-request effect seeding the form and the URL state
   * reaching `new`: the seed-sync effect also runs in that gap (mode still
   * idle) and must not clear `seededKey`, or it re-seeds the blank form after
   * the operator has already typed into it.
   */
  const openingNew = useRef(false)

  const descriptors = useAsync(() => trpc.trainingProvider.describe.query({}), [])
  const typesQuery = useAsync(() => trpc.trainingProvider.describeTypes.query({}), [])

  const typesData = typesQuery.state.status === 'ok' ? typesQuery.state.data : null
  const typesKey = typesData === null ? '' : typesIdentityKey(typesData)
  const typesDataRef = useRef(typesData)
  typesDataRef.current = typesData

  const typeById = useMemo(() => {
    const map = new Map<string, TrainingProviderType>()
    const data = typesDataRef.current
    if (data !== null) {
      for (const t of data) {
        const coerced = coerceProviderType(t)
        map.set(coerced.typeId, coerced)
      }
    }
    return map
  }, [typesKey])

  const typeOptions = useMemo(() => {
    const data = typesDataRef.current
    if (data === null) return []
    return data.map((t) => {
      const coerced = coerceProviderType(t)
      return {
        value: coerced.typeId,
        label: coerced.label,
      }
    })
  }, [typesKey])

  const rows =
    descriptors.state.status === 'ok'
      ? descriptors.state.data
      : ([] as TrainingProviderDescriptor[])

  useEffect(() => {
    if (!createRequested) return
    if (typesQuery.state.status !== 'ok') return
    const initialType = typeOptions[0]?.value ?? ''
    setFormError(null)
    setCheck({ kind: 'idle' })
    setTypeId(initialType)
    setName('')
    setFormValues(createValuesForType(initialType))
    seededKey.current = 'new'
    openingNew.current = true
    formUrl.openNew()
    onCreateConsumed?.()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [createRequested, typesQuery.state.status])

  const formState = formUrl.state
  const editing =
    formState.mode === 'edit' ? (rows.find((r) => r.entryId === formState.id) ?? null) : null

  useEffect(() => {
    if (formUrl.state.mode === 'edit' && editing !== null) {
      const key = `edit:${editing.entryId}`
      if (seededKey.current === key) return
      seededKey.current = key
      setFormError(null)
      setCheck({ kind: 'idle' })
      setTypeId(editing.typeId)
      setName(editing.name)
      setFormValues(editing.formValues !== undefined ? { ...editing.formValues } : {})
      return
    }
    if (formUrl.state.mode === 'new') {
      openingNew.current = false
      if (seededKey.current === 'new') return
      seededKey.current = 'new'
      const initialType = typeOptions[0]?.value ?? ''
      setFormError(null)
      setCheck({ kind: 'idle' })
      setTypeId(initialType)
      setName('')
      setFormValues(createValuesForType(initialType))
      return
    }
    if (openingNew.current) return
    seededKey.current = null
  }, [editing, formUrl.state.mode, typeOptions])

  const activeType =
    typeById.get(typeId) ?? (editing !== null ? typeById.get(editing.typeId) : undefined)
  const configSchema: ConfigUISchema | undefined = activeType?.configSchema

  /**
   * KeychainOr locks SecretFieldControl vs PasswordField on mount. Seed from
   * the descriptor on the first edit paint before useEffect copies into state,
   * otherwise the control mounts on `''` and stays plain.
   */
  const builderValues: Record<string, unknown> =
    formUrl.state.mode === 'edit' &&
    editing !== null &&
    seededKey.current !== `edit:${editing.entryId}`
      ? editing.formValues !== undefined
        ? { ...editing.formValues }
        : {}
      : formValues

  const builderKey =
    formUrl.state.mode === 'edit' && editing !== null ? `edit:${editing.entryId}` : `new:${typeId}`

  const onTypeChange = useCallback((next: string) => {
    setTypeId(next)
    setFormValues(createValuesForType(next))
  }, [])

  const onTest = useCallback(async () => {
    if (editing === null) return
    setCheck({ kind: 'running' })
    try {
      setCheck({
        kind: 'done',
        check: await trpc.trainingProvider.validateCredentials.mutate({
          entryId: editing.entryId,
          addonId: editing.addonId,
        }),
      })
    } catch (err: unknown) {
      setCheck({ kind: 'error', message: errorText(err) })
    }
  }, [editing, trpc])

  const parseUpdateFields = useCallback(():
    | {
        readonly ok: true
        readonly fields: {
          readonly name: string
          readonly tokenId?: string
          readonly tokenSecret?: string | typeof SECRET_CLEAR
          readonly environment?: string
          readonly gpuType?: string
          readonly region?: string
          readonly costCapUsd?: number
          readonly maxRuntimeSec?: number
          readonly failedDatasetGraceHours?: number
        }
      }
    | { readonly ok: false; readonly message: string } => {
    const trimmedName = name.trim()
    if (trimmedName === '') return { ok: false, message: t('providers.validation.nameRequired') }

    if (typeId === 'modal' || editing?.typeId === 'modal') {
      const costCapUsd = Number(formValues['costCapUsd'])
      const maxRuntimeHours = Number(formValues['maxRuntimeHours'])
      const failedDatasetGraceHours = Number(formValues['failedDatasetGraceHours'])
      if (!Number.isFinite(costCapUsd) || costCapUsd < 0) {
        return { ok: false, message: t('providers.validation.costCap') }
      }
      if (!Number.isFinite(maxRuntimeHours) || maxRuntimeHours <= 0) {
        return { ok: false, message: t('providers.validation.maxRuntime') }
      }
      if (!Number.isFinite(failedDatasetGraceHours) || failedDatasetGraceHours < 0) {
        return { ok: false, message: t('providers.validation.graceHours') }
      }

      const isCreate = formUrl.state.mode === 'new'
      const tokenSecret = readTokenSecretWire(formValues['tokenSecret'], isCreate)
      const tokenIdRaw = formValues['tokenId']
      const environmentRaw = formValues['environment']
      const gpuTypeRaw = formValues['gpuType']
      const regionRaw = formValues['region']

      return {
        ok: true,
        fields: {
          name: trimmedName,
          tokenId: typeof tokenIdRaw === 'string' ? tokenIdRaw.trim() : '',
          ...(tokenSecret !== undefined ? { tokenSecret } : {}),
          environment: typeof environmentRaw === 'string' ? environmentRaw.trim() : '',
          gpuType: typeof gpuTypeRaw === 'string' ? gpuTypeRaw : 'L4',
          region: typeof regionRaw === 'string' ? regionRaw : '',
          costCapUsd,
          maxRuntimeSec: Math.round(maxRuntimeHours * 3600),
          failedDatasetGraceHours,
        },
      }
    }

    return { ok: true, fields: { name: trimmedName } }
  }, [editing?.typeId, formUrl.state.mode, formValues, name, t, typeId])

  const onSave = useCallback(async () => {
    const parsed = parseUpdateFields()
    if (!parsed.ok) {
      setFormError(parsed.message)
      return
    }

    setSubmitting(true)
    setFormError(null)
    try {
      if (formUrl.state.mode === 'new') {
        const type = typeById.get(typeId)
        if (type === undefined) {
          setFormError(t('providers.typeGone'))
          return
        }
        const created = await trpc.trainingProvider.createEntry.mutate({
          typeId,
          name: parsed.fields.name,
          addonId: type.addonId,
        })
        await trpc.trainingProvider.updateEntry.mutate({
          entryId: created.entryId,
          addonId: type.addonId,
          ...parsed.fields,
        })
      } else if (editing !== null) {
        await trpc.trainingProvider.updateEntry.mutate({
          entryId: editing.entryId,
          addonId: editing.addonId,
          ...parsed.fields,
        })
      } else {
        setFormError(t('providers.entryGone'))
        return
      }
      descriptors.reload()
      typesQuery.reload()
      formUrl.close()
      seededKey.current = null
    } catch (err: unknown) {
      setFormError(errorText(err))
    } finally {
      setSubmitting(false)
    }
  }, [descriptors, editing, formUrl, parseUpdateFields, t, trpc, typeById, typeId, typesQuery])

  const onDelete = useCallback(
    async (entry: TrainingProviderDescriptor) => {
      const ok = await confirm({
        title: t('providers.deleteConfirm.title'),
        message: t('providers.deleteConfirm.message', { name: entry.name, type: entry.label }),
        confirmLabel: t('common.delete'),
        cancelLabel: t('common.cancel'),
        variant: 'danger',
      })
      if (!ok) return
      await trpc.trainingProvider.deleteEntry.mutate({
        entryId: entry.entryId,
        addonId: entry.addonId,
      })
      if (formUrl.state.mode === 'edit' && formUrl.state.id === entry.entryId) {
        formUrl.close()
        seededKey.current = null
      }
      descriptors.reload()
    },
    [confirm, descriptors, formUrl, t, trpc],
  )

  const columns: DataColumn<TrainingProviderDescriptor>[] = useMemo(
    () => [
      {
        key: 'name',
        header: t('common.name'),
        sortValue: (row) => row.name,
        render: (row) => (
          <div className="flex min-w-0 items-center gap-2">
            <img
              src={providerIconUrl(row.addonId, row.iconAsset) ?? undefined}
              alt=""
              className="h-4 w-4 shrink-0"
            />
            <span className="truncate font-medium text-foreground">{row.name}</span>
          </div>
        ),
      },
      {
        key: 'type',
        header: t('common.type'),
        sortValue: (row) => row.label,
        render: (row) => <span className="text-xs text-foreground-muted">{row.label}</span>,
      },
      {
        key: 'status',
        header: t('common.status'),
        notSortableReason: 'Badge',
        render: (row) => (
          <Badge variant={row.configured ? 'success' : 'warning'}>
            {row.configured ? t('providers.configured') : t('providers.notConfigured')}
          </Badge>
        ),
      },
      {
        key: 'actions',
        header: '',
        align: 'right',
        notSortableReason: 'Row actions',
        nowrap: true,
        render: (row) => (
          <div className="flex justify-end gap-1">
            <Button
              type="button"
              size="sm"
              variant="secondary"
              onClick={(e) => {
                e.stopPropagation()
                formUrl.openEdit(row.entryId)
              }}
            >
              {t('common.edit')}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              aria-label={t('providers.deleteEntry', { name: row.name })}
              title={t('common.delete')}
              onClick={(e) => {
                e.stopPropagation()
                void onDelete(row)
              }}
            >
              <Trash2 className="h-3.5 w-3.5 text-danger" />
            </Button>
          </div>
        ),
      },
    ],
    [formUrl, onDelete, t],
  )

  if (presence === 'pending') {
    return <Skeleton className="h-16 w-full" data-testid="training-providers" />
  }

  if (presence === 'unknown') {
    return (
      <p className="text-sm text-danger" data-testid="training-providers">
        {t('providers.registryUnreachable')}
      </p>
    )
  }

  if (presence === 'absent') {
    return (
      <EmptyState
        title={t('providers.absent.title')}
        description={t('providers.absent.description')}
        action={
          <Button variant="outline" onClick={() => navigate(addonCatalogHref('training-provider'))}>
            {t('providers.absent.addons')}
          </Button>
        }
      />
    )
  }

  const typesAnswered = typesQuery.state.status === 'ok'
  const isNew = formUrl.state.mode === 'new'
  const dialogOpen = isNew || editing !== null

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3" data-testid="training-providers">
      {descriptors.state.status === 'error' ? (
        <p className="text-sm text-danger">
          {t('providers.couldNotLoadEntries')} {descriptors.state.error}
        </p>
      ) : null}
      {typesQuery.state.status === 'error' ? (
        <p className="text-sm text-danger">
          {t('providers.couldNotLoadTypes')} {typesQuery.state.error}
        </p>
      ) : null}

      {descriptors.state.status === 'pending' ? (
        <Skeleton className="h-32 w-full" />
      ) : (
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(row) => row.entryId}
          pageSize={25}
          fill
          emptyMessage={t('providers.empty')}
          onRowClick={(row) => formUrl.openEdit(row.entryId)}
          defaultSort={{ columnKey: 'name', dir: 'asc' }}
        />
      )}

      <ItemFormDialog
        open={dialogOpen}
        onClose={() => {
          formUrl.close()
          setFormError(null)
          setCheck({ kind: 'idle' })
          seededKey.current = null
        }}
        title={
          isNew
            ? t('page.addProvider')
            : t('providers.editTitle', { name: editing?.name ?? t('providers.fallbackName') })
        }
        icon={Cloud}
        width="xl"
        testId="provider-entry-editor"
        error={formError}
        footer={
          <Button
            type="button"
            size="sm"
            disabled={submitting || (isNew && (!typesAnswered || typeId === ''))}
            onClick={() => void onSave()}
          >
            {submitting ? t('common.saving') : t('common.save')}
          </Button>
        }
      >
        {dialogOpen ? (
          <>
            {isNew ? (
              <div>
                <Label htmlFor="training-provider-type">{t('providers.providerType')}</Label>
                <Select
                  id="training-provider-type"
                  aria-label={t('providers.providerType')}
                  value={typeId}
                  options={[{ value: '', label: t('providers.selectType') }, ...typeOptions]}
                  onChange={(e) => onTypeChange(e.target.value)}
                  disabled={!typesAnswered}
                />
              </div>
            ) : (
              <p className="text-sm text-foreground-muted">
                {t('providers.typeLine', { type: editing?.label ?? typeId })}
              </p>
            )}
            <div>
              <Label htmlFor="training-provider-name">{t('common.name')}</Label>
              <Input
                id="training-provider-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t('providers.namePlaceholder')}
              />
            </div>
            {configSchema !== undefined ? (
              <>
                <ConfigFormBuilder
                  key={builderKey}
                  schema={configSchema}
                  values={builderValues}
                  onChange={setFormValues}
                  bare
                />
                {editing !== null ? (
                  <div className="flex flex-wrap items-center gap-2 pt-1">
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      disabled={!editing.configured || check.kind === 'running'}
                      onClick={() => void onTest()}
                    >
                      {t('providers.testCredentials')}
                    </Button>
                    <CheckLine state={check} />
                  </div>
                ) : null}
                {editing !== null ? (
                  <p className="text-xs text-foreground-muted">{editing.dataResidencyNote}</p>
                ) : null}
              </>
            ) : typeId !== '' ? (
              <p className="text-xs text-foreground-muted">{t('providers.nameOnlyHint')}</p>
            ) : null}
          </>
        ) : null}
      </ItemFormDialog>
    </div>
  )
}
