/**
 * System → Secrets — the keychain, as the operator sees it (D787, D788).
 *
 * Top to bottom:
 *   1. ONE notice region (`KeychainNotices`): every condition that needs the
 *      operator as a single ordered line — locked, the reset's re-enter list,
 *      the key sharing the backup, no recovery copy, a pending rotation,
 *      orphans. It replaced a stack of banners that overlapped on a phone.
 *   2. The status card: state, key source and path, fingerprint, recovery copy,
 *      and the key actions.
 *   3. Two views, `?view=values` (default) and `?view=audit`: the stored values
 *      table (filter by usage, bulk-delete orphans) and the paginated audit.
 *
 * A value is revealed in a dialog that hides itself after SECRET_REVEAL_MS
 * (audited on the hub) — never inside the table, which kept re-flowing around a
 * PEM. "Unknown" usage is never offered for deletion: absence is claimed only
 * from a read that answered.
 */
import type { KeychainAdminSecret } from '@camstack/types'
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  useAlert,
  useKeychainAdminListAudit,
  useKeychainAdminListSecrets,
  useKeychainAdminResetReport,
  useKeychainAdminReveal,
  useKeychainAdminStatus,
} from '@camstack/ui-library'
import { KeyRound } from 'lucide-react'
import { useCallback, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { AdminPage } from '../../components/AdminPage'
import { revealErrorMessage } from '../../components/system/KeychainRevealHost'
import { buildKeychainNotices } from '../../components/system/secrets/keychain-notices'
import {
  KEYCHAIN_AUDIT_FETCH,
  KeychainAuditTable,
} from '../../components/system/secrets/KeychainAuditTable'
import {
  type NoticeContext,
  noticeAction,
  noticeDetail,
} from '../../components/system/secrets/KeychainNoticeContent'
import { KeychainNotices } from '../../components/system/secrets/KeychainNotices'
import { KeychainStatusCard } from '../../components/system/secrets/KeychainStatusCard'
import { RevealDialog, type RevealedSecret } from '../../components/system/secrets/RevealDialog'
import { type SecretsFilter, SecretsTable } from '../../components/system/secrets/SecretsTable'
import { useKeychainActions } from '../../components/system/secrets/use-keychain-actions'
import { useTranslation } from 'react-i18next'

/** `?view=` — its own param, so the page can sit under a host's `?tab=`. */
const VIEW_PARAM = 'view'
type SecretsView = 'values' | 'audit'

function useSecretsView(): [SecretsView, (v: SecretsView) => void] {
  const [params, setParams] = useSearchParams()
  const view: SecretsView = params.get(VIEW_PARAM) === 'audit' ? 'audit' : 'values'
  const setView = (v: SecretsView): void => {
    const next = new URLSearchParams(params)
    if (v === 'values') next.delete(VIEW_PARAM)
    else next.set(VIEW_PARAM, v)
    setParams(next, { replace: true })
  }
  return [view, setView]
}

export function SecretsPage() {
  const { t } = useTranslation()
  const status = useKeychainAdminStatus({})
  const secrets = useKeychainAdminListSecrets({})
  const audit = useKeychainAdminListAudit({ limit: KEYCHAIN_AUDIT_FETCH })
  const report = useKeychainAdminResetReport({})
  const reveal = useKeychainAdminReveal()
  const alert = useAlert()
  const [view, setView] = useSecretsView()
  const [filter, setFilter] = useState<SecretsFilter>('all')
  const [revealed, setRevealed] = useState<RevealedSecret | null>(null)

  const refresh = (): void => {
    void status.refetch()
    void secrets.refetch()
    void audit.refetch()
    void report.refetch()
  }
  const actions = useKeychainActions(refresh)
  const locked = status.data?.keychain.state === 'locked'
  const orphans = useMemo(
    () => (secrets.data ?? []).filter((s) => s.usage === 'orphan').length,
    [secrets.data],
  )

  const notices = useMemo(
    () =>
      status.data === undefined
        ? []
        : buildKeychainNotices({
            status: status.data,
            reset: report.data?.reset ?? null,
            pendingReentry: report.data?.pendingReentry.length ?? 0,
            orphans,
          }),
    [status.data, report.data, orphans],
  )

  const ctx: NoticeContext = {
    reset: report.data?.reset ?? null,
    pendingReentry: report.data?.pendingReentry ?? [],
    busy: actions.busy,
    onReset: () => void actions.reset(),
    onAcknowledgeReset: () => void actions.acknowledgeReset(),
    onDownload: () => void actions.download(),
    onRotate: () => void actions.rotate(),
    onShowOrphans: () => {
      setFilter('orphan')
      setView('values')
    },
  }

  const onReveal = async (entry: KeychainAdminSecret): Promise<void> => {
    try {
      const result = await reveal.mutateAsync({ ref: entry.ref })
      setRevealed({ entry, value: result.value })
      void secrets.refetch()
    } catch (err: unknown) {
      await alert({
        title: t('admin.system.secrets.revealRefused', 'Reveal refused'),
        message: revealErrorMessage(err),
        variant: 'danger',
      })
    }
  }
  const hide = useCallback(() => setRevealed(null), [])

  return (
    <AdminPage
      embedded
      icon={KeyRound}
      title={t('admin.system.secrets.secrets', 'Secrets')}
      subtitle={t(
        'admin.system.secrets.passwordsTokensAndKeysEncrypted',
        'Passwords, tokens and keys, encrypted in the hub keychain. Values leave the hub only through an audited reveal.',
      )}
    >
      <KeychainNotices
        notices={notices}
        renderAction={(id) => noticeAction(id, ctx)}
        renderDetail={(id) => noticeDetail(id, ctx)}
      />

      {status.data !== undefined && (
        <KeychainStatusCard
          status={status.data}
          busy={actions.busy}
          onDownload={ctx.onDownload}
          onRotate={ctx.onRotate}
          onPurge={() => void actions.purge()}
        />
      )}

      <Tabs value={view} onValueChange={(v) => setView(v === 'audit' ? 'audit' : 'values')}>
        <TabsList>
          <TabsTrigger value="values">
            {t('admin.system.secrets.storedValues', 'Stored values')}
          </TabsTrigger>
          <TabsTrigger value="audit">{t('admin.system.secrets.audit', 'Audit')}</TabsTrigger>
        </TabsList>
        <TabsContent value="values">
          <SecretsTable
            secrets={secrets.data}
            locked={locked}
            filter={filter}
            onFilterChange={setFilter}
            onReveal={(entry) => void onReveal(entry)}
            revealing={reveal.isPending}
            onDeleteOrphans={(refs) => void actions.deleteOrphans(refs)}
            deleting={actions.deleting}
          />
        </TabsContent>
        <TabsContent value="audit">
          <KeychainAuditTable entries={audit.data} />
        </TabsContent>
      </Tabs>

      <RevealDialog revealed={revealed} onClose={hide} />
    </AdminPage>
  )
}
