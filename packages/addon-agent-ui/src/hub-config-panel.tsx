/**
 * "Hub Connection": who this agent is paired with and how a pairing is made
 * (D857). There is no secret to paste and no hub to choose here: the HUB starts
 * a pairing, and this panel is where the operator confirms it on the agent's
 * side - see `pairing-requests.tsx`. The only setting left on the page is the
 * agent's name.
 */
import {
  Badge,
  Button,
  ErrorBox,
  Input,
  Label,
  SECTION_BODY,
  SectionCard,
  SettingRow,
} from '@camstack/ui-library'
import { Save, Settings } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import {
  type AgentStatus,
  type HubConnectionState,
  discoveredLabel,
  resolveConnectionState,
} from './agent-status'
import { postJson } from './api-client'
import { PairedHubCard } from './paired-hub'
import { type PairingStatusView, isLoopbackView, pageIsLocal } from './pairing-api'
import { PairingRequests } from './pairing-requests'
import { PairingReset } from './pairing-reset'
import { usePairingStatus } from './use-pairing-status'
import { type AgentUiT, useT } from './i18n'

function ConnectionBadge({ connectionState }: { readonly connectionState: HubConnectionState }) {
  const { t } = useT()
  switch (connectionState) {
    case 'connected':
      return <Badge variant="success">{t('hubConfig.connection.connected')}</Badge>
    case 'unpaired':
      return <Badge variant="warning">{t('hubConfig.connection.unpaired')}</Badge>
    case 'unconfigured':
      return <Badge variant="default">{t('hubConfig.connection.unconfigured')}</Badge>
    case 'certificate-rejected':
      return <Badge variant="danger">{t('hubConfig.connection.certificateRejected')}</Badge>
    case 'disconnected':
      return <Badge variant="danger">{t('hubConfig.connection.disconnected')}</Badge>
  }
}

function pairingLabel(t: AgentUiT, view: PairingStatusView | null, paired: boolean): string {
  if (view?.state === 'paired' || (view === null && paired))
    return t('hubConfig.pairingState.paired')
  if (view?.state === 'pending') return t('hubConfig.pairingState.requested')
  return t('hubConfig.pairingState.unpaired')
}

interface HubConfigPanelProps {
  readonly status: AgentStatus | null
  readonly onStatusRefresh: () => Promise<void>
}

function NameEditor({
  status,
  onSaved,
}: {
  readonly status: AgentStatus | null
  readonly onSaved: () => Promise<void>
}) {
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState('')
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const { t } = useT()

  useEffect(() => {
    if (!editing) setName(status?.name ?? '')
  }, [status?.name, editing])

  const save = useCallback(async () => {
    const next = name.trim()
    if (next.length === 0 || next === status?.name) {
      setEditing(false)
      return
    }
    setSaving(true)
    setMessage(null)
    try {
      const res = await postJson<{ success: boolean; error?: string }>('/api/agent/config', {
        name: next,
      })
      if (res.success === false) {
        setMessage(res.error ?? t('hubConfig.name.saveFailed'))
        return
      }
      setEditing(false)
      setMessage(t('hubConfig.name.saved'))
      await onSaved()
    } catch (err) {
      setMessage(
        t('hubConfig.name.saveFailedWith', {
          error: err instanceof Error ? err.message : t('common.unknownError'),
        }),
      )
    } finally {
      setSaving(false)
    }
  }, [name, status?.name, onSaved, t])

  return (
    <div className="border-t border-border pt-3 space-y-2">
      {editing ? (
        <div className="space-y-2">
          <Label htmlFor="agent-name" className="text-[10px] text-foreground-subtle">
            {t('hubConfig.name.label')}
          </Label>
          <Input
            id="agent-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('hubConfig.name.placeholder')}
          />
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="primary"
              size="sm"
              onClick={() => void save()}
              disabled={saving}
            >
              <Save className="h-3 w-3" />
              {saving ? t('common.saving') : t('common.save')}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setEditing(false)}
              disabled={saving}
            >
              {t('common.cancel')}
            </Button>
          </div>
        </div>
      ) : (
        <Button type="button" variant="outline" size="sm" onClick={() => setEditing(true)}>
          {t('hubConfig.name.rename')}
        </Button>
      )}
      {message !== null && <p className="text-[11px] text-foreground-subtle">{message}</p>}
    </div>
  )
}

export function HubConfigPanel({ status, onStatusRefresh }: HubConfigPanelProps) {
  const { t } = useT()
  const pairing = usePairingStatus()
  const view = pairing.view
  // No status at all = the locked page of an agent the network may only pair (D857).
  const connectionState = status === null ? 'unpaired' : resolveConnectionState(status)
  const discoveredNodes = status?.discoveredNodes ?? []
  const hubAddressLabel = status?.hubAddress ?? status?.resolvedHubAddress ?? null
  const hubNode = discoveredNodes.find((n) => n.isHub)
  const hubName =
    hubNode === undefined
      ? null
      : discoveredLabel(hubNode, hubAddressLabel).replace(/ \(hub\)$/, '')

  const paired = view?.state === 'paired' || (view === null && status?.paired === true)
  const pending = view?.pending ?? []
  const loopback = isLoopbackView(pending) || pageIsLocal(window.location.hostname)
  const unsupported = view === null && pairing.error !== null && pairing.error.includes('404')

  const afterChange = useCallback(async () => {
    await pairing.refresh()
    await onStatusRefresh().catch(() => undefined)
  }, [pairing, onStatusRefresh])

  return (
    <SectionCard
      headingId="agent-hub-connection"
      title={t('hubConfig.title')}
      icon={Settings}
      actions={<ConnectionBadge connectionState={connectionState} />}
    >
      <div className={`${SECTION_BODY} space-y-3`}>
        {connectionState === 'certificate-rejected' && (
          <ErrorBox
            variant="warning"
            title={t('hubConfig.certRejected.title')}
            message={t('hubConfig.certRejected.message')}
          />
        )}
        {connectionState === 'disconnected' && paired && (
          <ErrorBox
            variant="warning"
            title={t('hubConfig.unreachable.title')}
            message={t('hubConfig.unreachable.message')}
          />
        )}

        <div className="space-y-0">
          <SettingRow label={t('hubConfig.hubAddress')} valueClassName="font-mono">
            {hubAddressLabel ?? t('hubConfig.connection.unpaired')}
          </SettingRow>
          <SettingRow label={t('hubConfig.pairing')}>
            {pairingLabel(t, view, status?.paired === true)}
          </SettingRow>
          {discoveredNodes.length > 0 && (
            <SettingRow label={t('hubConfig.clusterNodes')}>
              <span className="flex flex-wrap gap-1">
                {discoveredNodes
                  .filter((n) => !n.id.includes('/'))
                  .map((n) => (
                    <Badge
                      key={n.id}
                      variant={n.isHub ? 'info' : 'default'}
                      className="text-[9px] font-mono"
                      title={n.id}
                    >
                      {discoveredLabel(n, hubAddressLabel)}
                    </Badge>
                  ))}
              </span>
            </SettingRow>
          )}
        </div>

        {unsupported && <ErrorBox variant="warning" message={t('hubConfig.unsupported')} />}
        {!unsupported && view === null && pairing.error !== null && (
          <ErrorBox
            variant="warning"
            title={t('hubConfig.statusUnavailable')}
            message={pairing.error}
            onRetry={() => void pairing.refresh()}
          />
        )}

        {view !== null && paired && (
          <PairedHubCard
            hub={status?.pairedHub ?? null}
            hubName={hubName}
            onForgotten={afterChange}
          />
        )}
        {view !== null && !paired && pending.length > 0 && (
          <PairingRequests pending={pending} onChanged={afterChange} />
        )}
        {view !== null && !paired && pending.length === 0 && (
          <p className="text-xs text-foreground-subtle">{t('hubConfig.emptyPairing')}</p>
        )}
        {view !== null && !paired && <PairingReset local={loopback} onReset={afterChange} />}

        <NameEditor status={status} onSaved={onStatusRefresh} />
      </div>
    </SectionCard>
  )
}
