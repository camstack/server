/**
 * The one New token dialog (D892/D895). A token is its scopes, so the dialog
 * asks for exactly three things: what it may do, a label, and when it ends.
 *
 * "What it may do" is one of:
 *   - Scopes — the capability / addon / device grants of the scope picker;
 *   - View link — watch a few cameras (grid or events, optionally talk-back):
 *     the token a share link carries;
 *   - All permissions — `'*'`, admins only, after a fresh re-authentication.
 *
 * Lifetimes are presets up to 90 days; "Never" exists only for a view link
 * (the permanent link pinned to a wall display is a deliberate choice;
 * revoking it is the kill switch).
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Eye, KeyRound, Loader2, ShieldAlert, ShieldCheck } from 'lucide-react'
import {
  Button,
  DeviceMultiSelectField,
  Input,
  ItemFormDialog,
  Label,
  ScopePicker,
  Select,
  Tabs,
  TabsList,
  TabsTrigger,
  validateScopes,
  useUiText,
} from '@camstack/ui-library'
import type { ConfigDeviceMultiSelectField, CredentialScope, TokenScope } from '@camstack/types'

import { useAuth } from '../../contexts/auth-context'
import { Trans, useTranslation } from 'react-i18next'

const NAME_MAX = 80
const DAY_SEC = 86_400

/** What the token may do. */
export type TokenReachChoice = 'scopes' | 'view-link' | 'all'

/** A lifetime preset: seconds, or a permanent view link. */
export type TokenLifetime = number | 'never'

const LIFETIMES: readonly { readonly value: string; readonly seconds: TokenLifetime }[] = [
  { value: '1', seconds: DAY_SEC },
  { value: '7', seconds: 7 * DAY_SEC },
  { value: '30', seconds: 30 * DAY_SEC },
  { value: '90', seconds: 90 * DAY_SEC },
  { value: 'never', seconds: 'never' },
]

/** What the dialog hands back: the `auth.mintToken` input, minus the re-auth proof. */
export interface CreateTokenInput {
  readonly scopes: readonly CredentialScope[]
  readonly expiresIn: TokenLifetime
  readonly label: string
  /** An admin minting on behalf of another user. */
  readonly subjectId?: string
}

export interface CreateTokenModalProps {
  readonly open: boolean
  readonly users: readonly { id: string; username: string }[]
  readonly onClose: () => void
  /** `'*'` in `scopes` means the caller asks for a re-authentication first. */
  readonly onSubmit: (input: CreateTokenInput) => void
  readonly submitting: boolean
  readonly formError: string | null
  /** True while the re-auth dialog is up for an all-permissions token. */
  readonly awaitingProof: boolean
}

/** The camera picker's field; its translated `label` is added where it renders. */
const CAMERA_FIELD: Omit<ConfigDeviceMultiSelectField, 'label'> = {
  type: 'device-multiselect',
  key: 'cameras',
  deviceFilter: { types: ['camera'] },
  maxItems: 64,
}

const DEFAULT_SCOPE: TokenScope = { type: 'capability', target: '', access: ['view', 'create'] }

export function CreateTokenModal({
  open,
  users,
  onClose,
  onSubmit,
  submitting,
  formError,
  awaitingProof,
}: CreateTokenModalProps): ReactNode {
  const { t } = useTranslation()
  const uiText = useUiText()
  const { user: caller } = useAuth()
  const isAdminCaller = caller?.isAdmin === true
  const callerScopes: readonly TokenScope[] | null = isAdminCaller ? null : (caller?.scopes ?? [])

  const [reach, setReach] = useState<TokenReachChoice>('scopes')
  const [userId, setUserId] = useState(caller?.id ?? '')
  const [label, setLabel] = useState('')
  const [scopes, setScopes] = useState<TokenScope[]>([DEFAULT_SCOPE])
  const [cameras, setCameras] = useState<readonly string[]>([])
  const [viewKind, setViewKind] = useState<'grid-view' | 'events-view'>('grid-view')
  const [talk, setTalk] = useState(false)
  const [lifetime, setLifetime] = useState('30')

  useEffect(() => {
    if (!open) {
      setReach('scopes')
      setUserId(caller?.id ?? '')
      setLabel('')
      setScopes([DEFAULT_SCOPE])
      setCameras([])
      setViewKind('grid-view')
      setTalk(false)
      setLifetime('30')
    }
  }, [open, caller?.id])

  // `'never'` is offered only for a view link; leaving it selects 30 days.
  useEffect(() => {
    if (reach !== 'view-link' && lifetime === 'never') setLifetime('30')
  }, [reach, lifetime])

  const lifetimeOptions = useMemo(
    () =>
      LIFETIMES.filter((l) => l.seconds !== 'never' || reach === 'view-link').map((l) => ({
        value: l.value,
        label:
          l.seconds === 'never'
            ? t('access.createTokenModal.never', 'Never (until revoked)')
            : t('access.createTokenModal.days', { count: Number(l.value) }),
      })),
    [reach, t],
  )

  const trimmed = label.trim()
  const validationError = reach === 'scopes' ? validateScopes(scopes, uiText) : null
  const deviceIds = cameras.map(Number).filter((n) => Number.isInteger(n) && n >= 0)
  const expiresIn = LIFETIMES.find((l) => l.value === lifetime)?.seconds ?? 30 * DAY_SEC

  const chosenScopes = (): readonly CredentialScope[] => {
    if (reach === 'all') return ['*']
    if (reach === 'view-link') {
      return [
        {
          type: 'share-view',
          grant: { kind: viewKind, deviceIds, ...(talk ? { talk: true } : {}) },
        },
      ]
    }
    return scopes
  }

  const canSubmit =
    trimmed.length > 0 &&
    trimmed.length <= NAME_MAX &&
    !submitting &&
    !awaitingProof &&
    (reach === 'all'
      ? isAdminCaller
      : reach === 'view-link'
        ? deviceIds.length > 0
        : scopes.length > 0 && validationError === null)

  const handleSubmit = (): void => {
    if (!canSubmit) return
    const onBehalf = isAdminCaller && reach !== 'all' && userId !== '' && userId !== caller?.id
    onSubmit({
      scopes: chosenScopes(),
      expiresIn,
      label: trimmed,
      ...(onBehalf ? { subjectId: userId } : {}),
    })
  }

  const danger = reach === 'all'
  const SubmitIcon = danger ? ShieldAlert : ShieldCheck

  return (
    <ItemFormDialog
      open={open}
      onClose={onClose}
      title={t('access.createTokenModal.createToken', 'Create token')}
      icon={danger ? ShieldAlert : KeyRound}
      error={formError}
      width="md"
      testId="create-token-dialog"
      footer={
        <Button
          type="button"
          variant={danger ? 'danger' : 'primary'}
          size="sm"
          onClick={handleSubmit}
          disabled={!canSubmit}
          data-testid="create-token-submit"
        >
          {submitting || awaitingProof ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
          ) : (
            <SubmitIcon className="h-3.5 w-3.5" aria-hidden />
          )}
          {t('access.createTokenModal.issueToken', 'Issue token')}
        </Button>
      }
    >
      <div className="space-y-3">
        <div className="space-y-1">
          <Label>{t('access.createTokenModal.whatItMayDo', 'What it may do')}</Label>
          <Tabs
            appearance="pills"
            value={reach}
            onValueChange={(next) => {
              if (next === 'scopes' || next === 'view-link' || next === 'all') setReach(next)
            }}
          >
            <TabsList aria-label={t('access.createTokenModal.whatItMayDo', 'What it may do')}>
              <TabsTrigger value="scopes" data-testid="token-reach-scopes">
                <ShieldCheck className="h-3.5 w-3.5 shrink-0" aria-hidden />
                {t('access.createTokenModal.reachScopes', 'Scopes')}
              </TabsTrigger>
              <TabsTrigger value="view-link" data-testid="token-reach-view-link">
                <Eye className="h-3.5 w-3.5 shrink-0" aria-hidden />
                {t('access.createTokenModal.reachViewLink', 'View link')}
              </TabsTrigger>
              {isAdminCaller ? (
                <TabsTrigger value="all" data-testid="token-reach-all">
                  <ShieldAlert className="h-3.5 w-3.5 shrink-0" aria-hidden />
                  {t('access.createTokenModal.reachAll', 'All permissions')}
                </TabsTrigger>
              ) : null}
            </TabsList>
          </Tabs>
        </div>

        {danger ? (
          <div
            className="space-y-1 rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-[11px] leading-relaxed text-foreground"
            data-testid="admin-token-warning"
          >
            <p>
              <Trans i18nKey="auth.adminTokenNoticeShort" components={{ strong: <strong /> }} />
            </p>
          </div>
        ) : null}

        {isAdminCaller && reach !== 'all' && users.length > 1 ? (
          <div className="space-y-1">
            <Label htmlFor="token-user">
              {t('access.createTokenModal.onBehalfOfUser', 'On behalf of user')}
            </Label>
            <Select
              id="token-user"
              value={userId}
              onChange={(e) => setUserId(e.target.value)}
              options={users.map((u) => ({ value: u.id, label: u.username }))}
            />
          </div>
        ) : null}

        <div className="space-y-1">
          <Label htmlFor="token-name">{t('access.createTokenModal.label', 'Label')}</Label>
          <Input
            id="token-name"
            value={label}
            maxLength={NAME_MAX}
            required
            onChange={(e) => setLabel(e.target.value)}
            placeholder={reach === 'view-link' ? 'kitchen-wall' : 'nightly-backup'}
            autoFocus
          />
        </div>

        {reach === 'scopes' ? (
          <div className="space-y-1">
            <Label>{t('access.createTokenModal.scopes', 'Scopes')}</Label>
            <ScopePicker value={scopes} onChange={setScopes} clampToParent={callerScopes} />
            {validationError && <p className="text-[10px] text-danger">{validationError}</p>}
            <p className="text-[10px] text-foreground-subtle">
              {t(
                'access.createTokenModal.eachScopePicksACap',
                "Each scope picks a (cap or addon) target + one or more access flavours. The token can access ONLY what's listed.",
              )}
            </p>
          </div>
        ) : null}

        {reach === 'view-link' ? (
          <div className="space-y-2" data-testid="token-view-link">
            <div className="space-y-1">
              <Label>{t('access.createTokenModal.cameras', 'Cameras')}</Label>
              <DeviceMultiSelectField
                field={{ ...CAMERA_FIELD, label: t('access.createTokenModal.cameras', 'Cameras') }}
                value={cameras}
                onChange={(next) =>
                  setCameras(Array.isArray(next) ? next.filter((v) => typeof v === 'string') : [])
                }
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="token-view-kind">
                {t('access.createTokenModal.viewKind', 'Shows')}
              </Label>
              <Select
                id="token-view-kind"
                value={viewKind}
                onChange={(e) =>
                  setViewKind(e.target.value === 'events-view' ? 'events-view' : 'grid-view')
                }
                options={[
                  {
                    value: 'grid-view',
                    label: t('access.createTokenModal.viewGrid', 'Live grid'),
                  },
                  {
                    value: 'events-view',
                    label: t('access.createTokenModal.viewEvents', 'Events'),
                  },
                ]}
              />
            </div>
            {viewKind === 'grid-view' ? (
              <label className="flex items-start gap-2 text-sm text-foreground">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={talk}
                  onChange={(e) => setTalk(e.target.checked)}
                  data-testid="token-view-talk"
                />
                <span>{t('access.createTokenModal.talk', 'Allow talk-back on these cameras')}</span>
              </label>
            ) : null}
          </div>
        ) : null}

        <div className="space-y-1">
          <Label htmlFor="token-lifetime">
            {t('access.createTokenModal.expires', 'Expires after')}
          </Label>
          <Select
            id="token-lifetime"
            value={lifetime}
            onChange={(e) => setLifetime(e.target.value)}
            options={lifetimeOptions}
          />
        </div>
      </div>
    </ItemFormDialog>
  )
}
