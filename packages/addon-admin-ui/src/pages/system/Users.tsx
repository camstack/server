import { useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import {
  Plus,
  Trash2,
  Key,
  Loader2,
  ShieldCheck,
  Smartphone,
  Link2,
  MonitorSmartphone,
  Pencil,
  Users,
} from 'lucide-react'
import type { SafeUser } from '@camstack/types'

import {
  useUserManagementCreateUser,
  useUserManagementListUsers,
  useUserManagementDeleteUser,
  useUserManagementUpdateUser,
  useUserManagementResetPassword,
  useUserManagementSetUserScopes,
  useConfirm,
  usePrompt,
  useItemFormUrl,
  Button,
  DataTable,
  EmptyState,
  ErrorBox,
  FormField,
  Input,
  ItemFormDialog,
  PasswordInput,
  TABLE_SCROLL_MAX_H,
  type DataColumn,
} from '@camstack/ui-library'
import { useAuth } from '../../contexts/auth-context'
import { AdminPage } from '../../components/AdminPage'
import { ExternalIdentitiesModal } from '../../components/users/ExternalIdentitiesModal'
import { TotpModal } from '../../components/users/TotpModal'
import { UserSessionsModal } from '../../components/users/UserSessionsModal'
import { UserAccessModal } from '../../components/users/UserAccessModal'
import { draftFromUser, type RoleSaveRequest } from '../../components/users/user-role-model'
import { useTranslation } from 'react-i18next'
import i18n from '../../i18n/index'

/** Shortest password the hub accepts on create / reset. */
const MIN_PASSWORD_LENGTH = 8

interface UserDraft {
  readonly id?: string
  readonly username: string
  readonly password: string
  readonly isAdmin: boolean
}

function emptyDraft(): UserDraft {
  return { username: '', password: '', isAdmin: false }
}

function fromUser(user: SafeUser): UserDraft {
  return { id: user.id, username: user.username, password: '', isAdmin: user.isAdmin }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : i18n.t('admin.system.users.genericError')
}

export function UsersPage() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const { user: currentUser } = useAuth()
  const { state: formUrl, openNew, openEdit, close: closeForm } = useItemFormUrl()
  const [draft, setDraft] = useState<UserDraft | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [passwordShown, setPasswordShown] = useState(false)

  const { data: users, isLoading, isError, error, refetch } = useUserManagementListUsers()

  const confirm = useConfirm()
  const showPrompt = usePrompt()

  const invalidateUsers = () =>
    queryClient.invalidateQueries({ queryKey: [['userManagement', 'listUsers']] })

  const createMutation = useUserManagementCreateUser()
  const deleteMutation = useUserManagementDeleteUser({ onSuccess: invalidateUsers })
  const updateMutation = useUserManagementUpdateUser({ onSuccess: invalidateUsers })
  const resetPasswordMutation = useUserManagementResetPassword({ onSuccess: invalidateUsers })
  const setScopesMutation = useUserManagementSetUserScopes()

  // Active role modal (one user at a time). `null` = closed.
  const [scopesEditor, setScopesEditor] = useState<SafeUser | null>(null)
  const [roleSaving, setRoleSaving] = useState(false)
  const [roleError, setRoleError] = useState<string | null>(null)
  // Active TOTP-enrollment modal (one user at a time).
  const [totpUser, setTotpUser] = useState<SafeUser | null>(null)
  // Active linked-sign-ins modal (D782) — admins see and remove, never create.
  const [linksUser, setLinksUser] = useState<SafeUser | null>(null)
  // Active login-sessions modal — list a user's sessions, sign one or all out.
  const [sessionsUser, setSessionsUser] = useState<SafeUser | null>(null)

  const userList: readonly SafeUser[] = users ?? []

  const editingUser =
    formUrl.mode === 'edit' ? (userList.find((u) => u.id === formUrl.id) ?? null) : null

  const closeEditor = (): void => {
    setDraft(null)
    setFormError(null)
    setPasswordShown(false)
    createMutation.reset()
    updateMutation.reset()
    closeForm()
  }

  useEffect(() => {
    if (formUrl.mode === 'closed') {
      setDraft(null)
      setFormError(null)
      setPasswordShown(false)
      return
    }
    if (formUrl.mode === 'new') {
      setDraft((prev) => (prev !== null && prev.id === undefined ? prev : emptyDraft()))
      return
    }
    if (editingUser === null) {
      if (!isLoading) closeForm()
      return
    }
    setDraft((prev) => (prev?.id === editingUser.id ? prev : fromUser(editingUser)))
  }, [formUrl, editingUser, isLoading, closeForm])

  const formOpen =
    (formUrl.mode === 'new' && draft !== null && draft.id === undefined) ||
    (formUrl.mode === 'edit' && draft !== null && editingUser !== null)

  async function handleDelete(user: SafeUser) {
    const ok = await confirm({
      title: t('admin.system.users.deleteUser', 'Delete user'),
      message: t(
        'admin.system.users.permanentlyDeleteUserThisCannot',
        'Permanently delete user "{{username}}"? This cannot be undone — any active sessions will be revoked on next request.',
        { username: user.username },
      ),
      confirmLabel: t('common.delete', 'Delete'),
      variant: 'danger',
    })
    if (!ok) return
    deleteMutation.mutate({ id: user.id })
    if (formUrl.mode === 'edit' && formUrl.id === user.id) closeEditor()
  }

  async function handleResetPassword(user: SafeUser) {
    // The field is MASKED (`inputType: 'password'`): the previous
    // `window.prompt` showed the new password in clear text in a box the
    // browser may offer to remember. The length rule is enforced by the dialog
    // itself, so a too-short password is refused in place instead of bouncing
    // the operator through a second modal.
    const newPassword = await showPrompt({
      title: t('admin.system.users.resetPassword', 'Reset password'),
      message: t(
        'admin.system.users.setANewPasswordFor',
        'Set a new password for "{{username}}".',
        { username: user.username },
      ),
      label: t('admin.system.users.newPassword', 'New password'),
      inputType: 'password',
      placeholder: t('admin.system.users.atLeast8Characters', 'At least 8 characters'),
      confirmLabel: t('admin.system.users.continue', 'Continue'),
      validate: (value) =>
        value.length < MIN_PASSWORD_LENGTH
          ? i18n.t('admin.system.users.passwordTooShort', { min: MIN_PASSWORD_LENGTH })
          : null,
    })
    if (newPassword === null || newPassword.length === 0) return
    const ok = await confirm({
      title: t('admin.system.users.resetPassword', 'Reset password'),
      message: t(
        'admin.system.users.resetThePasswordForThey',
        'Reset the password for "{{username}}"? They will need to use the new password on their next login.',
        { username: user.username },
      ),
      confirmLabel: t('common.reset', 'Reset'),
    })
    if (!ok) return
    resetPasswordMutation.mutate({ id: user.id, newPassword })
  }

  function openRoleEditor(user: SafeUser): void {
    setRoleError(null)
    setScopesEditor(user)
  }

  /**
   * The admin flag first, then the scope set (D921): a viewer is
   * `isAdmin: false` + `[viewerRow]`, an admin `isAdmin: true` + `[]`.
   */
  async function handleRoleSave(user: SafeUser, request: RoleSaveRequest): Promise<void> {
    setRoleSaving(true)
    setRoleError(null)
    try {
      if (request.isAdmin !== user.isAdmin) {
        await updateMutation.mutateAsync({ id: user.id, isAdmin: request.isAdmin })
      }
      await setScopesMutation.mutateAsync({ userId: user.id, scopes: [...request.scopes] })
      setScopesEditor(null)
    } catch (err: unknown) {
      setRoleError(errorMessage(err))
    } finally {
      setRoleSaving(false)
      void invalidateUsers()
    }
  }

  async function handleSave(): Promise<void> {
    if (draft === null) return
    setFormError(null)
    try {
      if (draft.id === undefined) {
        const username = draft.username.trim()
        if (username === '' || draft.password.length < MIN_PASSWORD_LENGTH) return
        await createMutation.mutateAsync({
          username,
          password: draft.password,
          isAdmin: draft.isAdmin,
        })
      } else {
        await updateMutation.mutateAsync({ id: draft.id, isAdmin: draft.isAdmin })
      }
      invalidateUsers()
      closeEditor()
    } catch (err: unknown) {
      setFormError(errorMessage(err))
    }
  }

  function formatDate(ts: unknown): string {
    if (!ts) return '—'
    const d = new Date(typeof ts === 'number' ? ts : String(ts))
    return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
  }

  const saving = createMutation.isPending || updateMutation.isPending
  const createReady =
    draft !== null &&
    draft.id === undefined &&
    draft.username.trim() !== '' &&
    draft.password.length >= MIN_PASSWORD_LENGTH
  const editReady = draft !== null && draft.id !== undefined
  const saveDisabled = saving || (draft?.id === undefined ? !createReady : !editReady)

  const isRowBusy = (user: SafeUser): boolean =>
    (deleteMutation.isPending && deleteMutation.variables?.id === user.id) ||
    (updateMutation.isPending && updateMutation.variables?.id === user.id) ||
    (resetPasswordMutation.isPending && resetPasswordMutation.variables?.id === user.id)

  const columns: DataColumn<SafeUser>[] = [
    {
      key: 'username',
      header: t('admin.system.users.username', 'Username'),
      sortValue: (u) => u.username,
      render: (u) => (
        <span className="font-medium text-foreground" data-testid={`user-open-${u.id}`}>
          {u.username}
        </span>
      ),
    },
    {
      key: 'scopes',
      header: t('admin.system.users.access', 'Access'),
      sortValue: (u) => roleSortValue(u),
      render: (u) => (
        <span onClick={(e) => e.stopPropagation()}>
          <Button
            size="sm"
            variant="ghost"
            type="button"
            onClick={() => openRoleEditor(u)}
            disabled={isRowBusy(u)}
            title={t('admin.system.users.configureAccess', 'Configure access')}
            data-testid={`user-access-${u.id}`}
          >
            <ShieldCheck className="h-3 w-3 shrink-0 text-foreground-subtle" />
            <AccessSummary user={u} />
          </Button>
        </span>
      ),
    },
    {
      key: 'createdAt',
      header: t('admin.system.users.created', 'Created'),
      nowrap: true,
      sortValue: (u) => u.createdAt,
      render: (u) => <span className="text-foreground-subtle">{formatDate(u.createdAt)}</span>,
    },
    {
      key: 'actions',
      header: t('admin.system.users.actions', 'Actions'),
      align: 'right',
      nowrap: true,
      notSortableReason: 'Row actions',
      render: (u) => {
        const busy = isRowBusy(u)
        // Hide 2FA controls for the operator's OWN row — they manage
        // their own enrollment from their profile page (/system/my-access),
        // NOT from the Users table. Operators acting on OTHER users
        // can only REMOVE an active enrollment (lost device etc) —
        // never set one up — so the action is hidden unless 2FA is
        // currently active for that user.
        const showTotp = u.id !== currentUser?.id && u.totpEnabled
        return (
          <div className="flex items-center justify-end gap-1" onClick={(e) => e.stopPropagation()}>
            <Button
              size="sm"
              variant="ghost"
              type="button"
              onClick={() => openEdit(u.id)}
              disabled={busy}
              title={t('admin.system.users.editUser', 'Edit user')}
            >
              <Pencil className="h-3 w-3" />
              {t('common.edit', 'Edit')}
            </Button>
            {showTotp && (
              <Button
                size="sm"
                variant="ghost"
                type="button"
                onClick={() => setTotpUser(u)}
                disabled={busy}
                title={t(
                  'admin.system.users.removeTwoFactorAuthentication',
                  'Remove two-factor authentication',
                )}
              >
                <Smartphone className="h-3 w-3" />
                {t('admin.system.users.remove2fa', 'Remove 2FA')}
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              type="button"
              onClick={() => setLinksUser(u)}
              disabled={busy}
              title={t('admin.system.users.linkedSignInAccounts', 'Linked sign-in accounts')}
            >
              <Link2 className="h-3 w-3" />
              {t('admin.system.users.signInLinks', 'Sign-in links')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              type="button"
              onClick={() => setSessionsUser(u)}
              disabled={busy}
              title={t('admin.system.users.activeSessions', 'Active sessions')}
            >
              <MonitorSmartphone className="h-3 w-3" />
              {t('admin.system.users.sessions', 'Sessions')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              type="button"
              onClick={() => void handleResetPassword(u)}
              disabled={busy}
              title={t('admin.system.users.resetPassword', 'Reset password')}
            >
              <Key className="h-3 w-3" />
              {t('admin.system.users.resetPassword', 'Reset password')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              type="button"
              onClick={() => void handleDelete(u)}
              disabled={busy}
              title={t('admin.system.users.deleteUser', 'Delete user')}
              className="text-danger hover:bg-danger/10"
            >
              {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
              {t('common.delete', 'Delete')}
            </Button>
          </div>
        )
      },
    },
  ]

  return (
    <AdminPage
      embedded
      icon={Users}
      title={t('admin.system.users.users', 'Users')}
      subtitle={t(
        'admin.system.users.hubAccountsAdminFlagAccess',
        'Hub accounts, admin flag, access scopes, sessions and sign-in links.',
      )}
      actions={
        <Button
          size="sm"
          type="button"
          onClick={() => {
            setFormError(null)
            openNew()
          }}
        >
          <Plus className="h-3.5 w-3.5" />
          {t('admin.system.users.createUser', 'Create User')}
        </Button>
      }
    >
      {isError && (
        <ErrorBox
          title={t('admin.system.users.couldNotLoadUsers', 'Could not load users')}
          message={errorMessage(error)}
          onRetry={() => void refetch()}
        />
      )}

      {isLoading && (
        <div className="flex items-center gap-2 text-xs text-foreground-subtle">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          {t('common.loading', 'Loading…')}
        </div>
      )}

      {!isLoading && !isError && userList.length === 0 && (
        <EmptyState
          icon={Users}
          title={t('admin.system.users.noUsersYet', 'No users yet')}
          description={t(
            'admin.system.users.createAUserToGrant',
            'Create a user to grant hub access.',
          )}
        />
      )}

      {!isLoading && !isError && userList.length > 0 && (
        <DataTable<SafeUser>
          columns={columns}
          rows={userList}
          rowKey={(u) => u.id}
          minWidthPx={560}
          maxBodyHeight={TABLE_SCROLL_MAX_H}
          onRowClick={(u) => openEdit(u.id)}
        />
      )}

      <ItemFormDialog
        open={formOpen}
        onClose={closeEditor}
        title={
          draft?.id !== undefined
            ? t('admin.system.users.edit', 'Edit {{value1}}', { value1: draft.username || 'user' })
            : t('admin.system.users.createUser', 'Create User')
        }
        icon={Users}
        error={formError}
        testId="user-form-dialog"
        footer={
          <Button size="sm" type="button" disabled={saveDisabled} onClick={() => void handleSave()}>
            {saving ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                {t('admin.system.users.saving', 'Saving…')}
              </>
            ) : draft?.id !== undefined ? (
              t('common.save', 'Save')
            ) : (
              t('admin.system.users.create', 'Create')
            )}
          </Button>
        }
      >
        {draft !== null && (
          <div className="space-y-3">
            <FormField
              label={t('admin.system.users.username', 'Username')}
              required={draft.id === undefined}
            >
              <Input
                value={draft.username}
                onChange={(e) => setDraft({ ...draft, username: e.target.value })}
                placeholder="john" // i18n-ignore: example username
                autoFocus={draft.id === undefined}
                disabled={draft.id !== undefined}
                data-testid="user-form-username"
              />
            </FormField>
            {draft.id === undefined && (
              <FormField
                label={t('admin.system.users.password', 'Password')}
                required
                description={t(
                  'admin.system.users.atLeastCharacters',
                  'At least {{value1}} characters.',
                  { value1: String(MIN_PASSWORD_LENGTH) },
                )}
              >
                <PasswordInput
                  value={draft.password}
                  onValueChange={(password) => setDraft({ ...draft, password })}
                  shown={passwordShown}
                  onToggleShown={() => setPasswordShown((shown) => !shown)}
                  placeholder="••••••••"
                  data-testid="user-form-password"
                />
              </FormField>
            )}
            <FormField
              label={t('admin.system.users.admin', 'Admin')}
              description={t(
                'admin.system.users.unrestrictedAccessToEveryCapability',
                'Unrestricted access to every capability and device.',
              )}
            >
              <label className="inline-flex items-center gap-2 text-xs text-foreground cursor-pointer">
                <input
                  type="checkbox"
                  checked={draft.isAdmin}
                  onChange={(e) => setDraft({ ...draft, isAdmin: e.target.checked })}
                  className="rounded border-border focus:ring-primary"
                  data-testid="user-form-admin"
                />
                <span>{t('admin.system.users.admin', 'Admin')}</span>
              </label>
            </FormField>
            {draft.id !== undefined && (
              <p className="text-[11px] text-foreground-subtle">
                {t(
                  'admin.system.users.toChangeThePasswordUse',
                  "To change the password, use Reset password on the user's row. Access scopes are configured from the Access column.",
                )}
              </p>
            )}
          </div>
        )}
      </ItemFormDialog>

      {totpUser && (
        <TotpModal
          userId={totpUser.id}
          username={totpUser.username}
          onClose={() => setTotpUser(null)}
        />
      )}

      {linksUser && (
        <ExternalIdentitiesModal
          userId={linksUser.id}
          username={linksUser.username}
          onClose={() => setLinksUser(null)}
        />
      )}

      {sessionsUser && (
        <UserSessionsModal
          userId={sessionsUser.id}
          username={sessionsUser.username}
          onClose={() => setSessionsUser(null)}
        />
      )}

      {scopesEditor && (
        <UserAccessModal
          user={scopesEditor}
          isSelf={scopesEditor.id === currentUser?.id}
          onClose={() => setScopesEditor(null)}
          onSubmit={(request) => void handleRoleSave(scopesEditor, request)}
          submitting={roleSaving}
          error={roleError}
        />
      )}
    </AdminPage>
  )
}

/** Sort order of the Access column: admins, viewers, then nobody configured. */
function roleSortValue(user: SafeUser): number {
  const draft = draftFromUser(user)
  if (draft.role === 'admin') return 0
  return draft.unconfigured ? 2 : 1
}

/**
 * One-line answer to "what does this person have", in the table (D921).
 *
 * A non-admin nobody configured reads "No access" in warning colour — a dash
 * would read as "fine".
 */
function AccessSummary({ user }: { readonly user: SafeUser }): React.ReactElement {
  const { t } = useTranslation()
  const draft = draftFromUser(user)
  if (draft.role === 'admin') {
    return <span className="font-medium text-foreground">{t('users.accessSummary.admin')}</span>
  }
  if (draft.unconfigured) {
    return (
      <span className="font-medium text-warning">
        {t('admin.system.users.noAccess', 'No access')}
      </span>
    )
  }
  const { allow, block, features } = draft.viewer
  const devices =
    allow === '*'
      ? t('users.accessSummary.allDevices')
      : t('users.accessSummary.devices', { count: allow.length })
  return (
    <span className="text-foreground-subtle">
      <span className="font-medium text-foreground">{t('users.accessSummary.viewer')}</span> ·{' '}
      {devices}
      {block.length > 0 && <> · {t('users.accessSummary.blocked', { count: block.length })}</>}
      {features.length > 0 && (
        <> · {t('users.accessSummary.features', { count: features.length })}</>
      )}
    </span>
  )
}
