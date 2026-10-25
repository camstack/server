/**
 * OIDC Settings body — DataTable of IdP connections + ItemFormDialog create/edit.
 * Replaces the former editable-array in auth-oidc settings (D828 sibling).
 */
import type { ConfigUISchema, OidcConnection } from '@camstack/types'
import { isSecretClear, isSecretFieldView, SECRET_CLEAR } from '@camstack/types'
import {
  Badge,
  Button,
  ConfigFormBuilder,
  DataTable,
  Input,
  ItemFormDialog,
  Label,
  Skeleton,
  useConfirm,
  useItemFormUrl,
  useSystem,
  type DataColumn,
} from '@camstack/ui-library'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus, ShieldCheck, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react'
import { useTranslation } from 'react-i18next'

const CONNECTIONS_KEY = ['oidcConnections', 'listConnections'] as const
const SCHEMA_KEY = ['oidcConnections', 'connectionFormSchema'] as const

const CREATE_DEFAULTS: Record<string, unknown> = {
  displayName: 'OpenID Connect',
  icon: 'shield-check',
  issuerUrl: '',
  clientId: '',
  clientSecret: '',
  redirectUri: '',
  scopes: 'openid profile email',
  usernameClaim: 'preferred_username',
}

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

function readClientSecretWire(
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

function isConfigSchema(value: unknown): value is ConfigUISchema {
  if (typeof value !== 'object' || value === null) return false
  return Array.isArray(Reflect.get(value, 'sections'))
}

export interface OidcSettingsConnectionsProps {
  readonly addonId: string
}

export function OidcSettingsConnections({ addonId }: OidcSettingsConnectionsProps): JSX.Element {
  const { t } = useTranslation()
  const system = useSystem()
  const queryClient = useQueryClient()
  const confirm = useConfirm()
  const formUrl = useItemFormUrl({ editKey: 'oidcEdit', newKey: 'oidcNew' })
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [connectionId, setConnectionId] = useState('')
  const [formValues, setFormValues] = useState<Record<string, unknown>>({ ...CREATE_DEFAULTS })
  const seededKey = useRef<string | null>(null)

  const listQuery = useQuery({
    queryKey: [...CONNECTIONS_KEY, addonId],
    queryFn: async () => system.trpcClient.oidcConnections.listConnections.query({}),
  })
  const schemaQuery = useQuery({
    queryKey: SCHEMA_KEY,
    queryFn: async () => system.trpcClient.oidcConnections.connectionFormSchema.query({}),
  })

  const rows = listQuery.data ?? []
  const configSchema = isConfigSchema(schemaQuery.data) ? schemaQuery.data : undefined

  const formState = formUrl.state
  const editing =
    formState.mode === 'edit' ? (rows.find((r) => r.id === formState.id) ?? null) : null

  useEffect(() => {
    if (formUrl.state.mode === 'edit' && editing !== null) {
      const key = `edit:${editing.id}`
      if (seededKey.current === key) return
      seededKey.current = key
      setFormError(null)
      setConnectionId(editing.id)
      setFormValues(
        editing.formValues !== undefined ? { ...editing.formValues } : { ...CREATE_DEFAULTS },
      )
      return
    }
    if (formUrl.state.mode === 'new') {
      if (seededKey.current === 'new') return
      seededKey.current = 'new'
      setFormError(null)
      setConnectionId('')
      setFormValues({ ...CREATE_DEFAULTS })
    }
  }, [editing, formUrl.state])

  const invalidate = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: CONNECTIONS_KEY })
  }, [queryClient])

  const deleteMutation = useMutation({
    mutationFn: async (id: string) =>
      system.trpcClient.oidcConnections.deleteConnection.mutate({ id }),
    onSuccess: async () => invalidate(),
  })

  const onDelete = useCallback(
    async (row: OidcConnection) => {
      const ok = await confirm({
        title: t('system.oidcSettingsConnections.deleteOidcConnection', 'Delete OIDC connection?'),
        message: t(
          'system.oidcSettingsConnections.removeTheLoginButtonAnd',
          'Remove “{{displayName}}” ({{id}}). The login button and IdP credentials for this id are dropped.',
          { displayName: row.displayName, id: row.id },
        ),
        confirmLabel: t('common.delete', 'Delete'),
        cancelLabel: t('common.cancel', 'Cancel'),
        variant: 'danger',
      })
      if (!ok) return
      await deleteMutation.mutateAsync(row.id)
      if (formUrl.state.mode === 'edit' && formUrl.state.id === row.id) {
        formUrl.close()
        seededKey.current = null
      }
    },
    [confirm, deleteMutation, formUrl, t],
  )

  const onSave = useCallback(async () => {
    const displayNameRaw = formValues['displayName']
    const displayName =
      typeof displayNameRaw === 'string' && displayNameRaw.trim() !== ''
        ? displayNameRaw.trim()
        : ''
    if (displayName === '') {
      setFormError('Display name is required.')
      return
    }

    const isNew = formUrl.state.mode === 'new'
    const id = isNew ? connectionId.trim() : (editing?.id ?? '')
    if (isNew && !ID_PATTERN.test(id)) {
      setFormError('Instance id must be a lowercase slug (e.g. authentik, google).')
      return
    }
    if (id === '') {
      setFormError('That connection is no longer available.')
      return
    }

    const clientSecret = readClientSecretWire(formValues['clientSecret'], isNew)
    const iconRaw = formValues['icon']
    const issuerUrlRaw = formValues['issuerUrl']
    const clientIdRaw = formValues['clientId']
    const redirectUriRaw = formValues['redirectUri']
    const scopesRaw = formValues['scopes']
    const usernameClaimRaw = formValues['usernameClaim']
    const usernameClaim =
      usernameClaimRaw === 'email' || usernameClaimRaw === 'sub'
        ? usernameClaimRaw
        : 'preferred_username'

    setSubmitting(true)
    setFormError(null)
    try {
      if (isNew) {
        await system.trpcClient.oidcConnections.createConnection.mutate({ id, displayName })
      }
      await system.trpcClient.oidcConnections.updateConnection.mutate({
        id,
        displayName,
        icon: typeof iconRaw === 'string' ? iconRaw : 'shield-check',
        issuerUrl: typeof issuerUrlRaw === 'string' ? issuerUrlRaw : '',
        clientId: typeof clientIdRaw === 'string' ? clientIdRaw : '',
        ...(clientSecret !== undefined ? { clientSecret } : {}),
        redirectUri: typeof redirectUriRaw === 'string' ? redirectUriRaw : '',
        scopes: typeof scopesRaw === 'string' ? scopesRaw : 'openid profile email',
        usernameClaim,
      })
      await invalidate()
      formUrl.close()
      seededKey.current = null
    } catch (err: unknown) {
      setFormError(errorText(err))
    } finally {
      setSubmitting(false)
    }
  }, [connectionId, editing?.id, formUrl, formValues, invalidate, system])

  const columns: DataColumn<OidcConnection>[] = useMemo(
    () => [
      {
        key: 'id',
        header: t('system.oidcSettingsConnections.id', 'Id'),
        sortValue: (row) => row.id,
        render: (row) => <span className="font-mono text-xs text-foreground">{row.id}</span>,
      },
      {
        key: 'name',
        header: t('system.oidcSettingsConnections.name', 'Name'),
        sortValue: (row) => row.displayName,
        render: (row) => (
          <span className="truncate font-medium text-foreground">{row.displayName}</span>
        ),
      },
      {
        key: 'issuer',
        header: t('system.oidcSettingsConnections.issuer', 'Issuer'),
        sortValue: (row) => row.issuerUrl,
        render: (row) => (
          <span className="truncate text-xs text-foreground-muted">
            {row.issuerUrl === '' ? '—' : row.issuerUrl}
          </span>
        ),
      },
      {
        key: 'status',
        header: t('system.oidcSettingsConnections.status', 'Status'),
        notSortableReason: 'Badge',
        render: (row) => (
          <Badge variant={row.configured ? 'success' : 'warning'}>
            {row.configured
              ? t('system.oidcSettingsConnections.configured', 'Configured')
              : t('system.oidcSettingsConnections.notConfigured', 'Not configured')}
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
                formUrl.openEdit(row.id)
              }}
            >
              {t('common.edit', 'Edit')}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              aria-label={t('system.oidcSettingsConnections.delete', 'Delete {{displayName}}', {
                displayName: row.displayName,
              })}
              title={t('common.delete', 'Delete')}
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

  const isNew = formUrl.state.mode === 'new'
  const dialogOpen = isNew || editing !== null
  const builderKey = isNew
    ? 'new'
    : editing !== null
      ? `edit:${editing.id}:${editing.configured ? 'cfg' : 'empty'}`
      : 'closed'
  const callbackPathHint = `/addon/${addonId}/<id>/callback` // hub-path-ok: displayed to copy into the IdP form, never requested

  return (
    <div className="flex min-h-0 flex-col gap-3" data-testid="oidc-settings-connections">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-foreground-muted">
          {t(
            'system.oidcSettingsConnections.eachRowIsOneIdp',
            'Each row is one IdP. Redirect URI:',
          )}{' '}
          <span className="font-mono text-xs">{callbackPathHint}</span>
        </p>
        <Button
          type="button"
          size="sm"
          data-testid="oidc-connections-add"
          onClick={() => formUrl.openNew()}
        >
          <Plus className="h-3.5 w-3.5" />
          {t('system.oidcSettingsConnections.addConnection', 'Add connection')}
        </Button>
      </div>

      {listQuery.isError ? (
        <p className="text-sm text-danger">
          {t(
            'system.oidcSettingsConnections.couldNotLoadConnections',
            'Could not load connections.',
          )}
        </p>
      ) : null}

      {listQuery.isPending ? (
        <Skeleton className="h-32 w-full" />
      ) : (
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(row) => row.id}
          pageSize={25}
          emptyMessage={t(
            'system.oidcSettingsConnections.noOidcConnectionsYetAdd',
            'No OIDC connections yet. Add one to register an IdP.',
          )}
          onRowClick={(row) => formUrl.openEdit(row.id)}
          defaultSort={{ columnKey: 'name', dir: 'asc' }}
        />
      )}

      <ItemFormDialog
        open={dialogOpen}
        onClose={() => {
          formUrl.close()
          setFormError(null)
          seededKey.current = null
        }}
        title={
          isNew
            ? t('system.oidcSettingsConnections.addOidcConnection', 'Add OIDC connection')
            : t('system.oidcSettingsConnections.edit', 'Edit {{value1}}', {
                value1: editing?.displayName ?? 'connection',
              })
        }
        icon={ShieldCheck}
        width="xl"
        testId="oidc-connection-editor"
        error={formError}
        footer={
          <Button
            type="button"
            size="sm"
            disabled={submitting || (isNew && connectionId.trim() === '')}
            onClick={() => void onSave()}
          >
            {submitting
              ? t('system.oidcSettingsConnections.saving', 'Saving…')
              : t('common.save', 'Save')}
          </Button>
        }
      >
        {dialogOpen ? (
          <>
            {isNew ? (
              <div>
                <Label htmlFor="oidc-connection-id">
                  {t('system.oidcSettingsConnections.instanceId', 'Instance id')}
                </Label>
                <Input
                  id="oidc-connection-id"
                  value={connectionId}
                  onChange={(e) => setConnectionId(e.target.value)}
                  placeholder="authentik" // i18n-ignore: example identity-provider id
                  autoComplete="off"
                />
                <p className="mt-1 text-xs text-foreground-muted">
                  {t(
                    'system.oidcSettingsConnections.urlSlugAppearsInAddon',
                    'URL slug — appears in /addon/{{addonId}}/<id>/callback. Stable; renaming is not supported after save.',
                    { addonId },
                  )}
                </p>
              </div>
            ) : (
              <p className="text-sm text-foreground-muted">
                {t('system.oidcSettingsConnections.instanceId2', 'Instance id:')}{' '}
                <span className="font-mono">{editing?.id}</span>
              </p>
            )}
            {configSchema !== undefined ? (
              <ConfigFormBuilder
                key={builderKey}
                schema={configSchema}
                values={formValues}
                onChange={setFormValues}
                bare
              />
            ) : (
              <p className="text-sm text-foreground-muted">
                {t('system.oidcSettingsConnections.loadingForm', 'Loading form…')}
              </p>
            )}
          </>
        ) : null}
      </ItemFormDialog>
    </div>
  )
}
