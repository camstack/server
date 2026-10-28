/**
 * System → Nodes: "Agents found on the network" (D857).
 *
 * Agents advertise themselves over mDNS; the hub lists them with their pairing
 * state and the operator pairs one from here (`PairingDialog`) — an agent holds
 * no shared secret, its identity is the certificate this pairing issues. An
 * agent mDNS cannot reach (Docker bridge, another subnet) is added by address.
 *
 * Every state comes from an ANSWERED query: while the list is loading the table
 * says so, and a failed scan is an error, never "no agents" (D315).
 */
import {
  Button,
  DataTable,
  EmptyState,
  ErrorBox,
  FormField,
  Input,
  SectionCard,
  SECTION_BODY,
  trpc,
  useConfirm,
  type DataColumn,
} from '@camstack/ui-library'
import { Loader2, Plus, Radar, RefreshCw } from 'lucide-react'
import { useMemo, useState, type ReactNode } from 'react'

import {
  formatEndpoint,
  shortFingerprint,
  type AgentPairState,
  type DiscoveredAgent,
} from './pairing-model'
import { PairingDialog, type PairingTarget } from './PairingDialog'
import { AgentStateBadge } from './AgentStateBadge'
import { useTranslation } from 'react-i18next'

export interface AgentsFoundSectionProps {
  /** Show a node on the Nodes page. */
  readonly onOpenNode: (nodeId: string) => void
}

const STATE_RANK: Readonly<Record<AgentPairState, number>> = {
  pending: 0,
  unpaired: 1,
  paired: 2,
}

interface Notice {
  readonly tone: 'success' | 'danger'
  readonly message: string
}

function parsePort(raw: string): number | null | undefined {
  if (raw.trim().length === 0) return undefined
  const port = Number(raw)
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null
}

export function AgentsFoundSection({ onOpenNode }: AgentsFoundSectionProps): ReactNode {
  const { t } = useTranslation()
  const confirm = useConfirm()
  const utils = trpc.useUtils()
  const list = trpc.agentPairing.listDiscoveredAgents.useQuery(undefined, {
    refetchInterval: 15_000,
  })
  const [target, setTarget] = useState<PairingTarget | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [adding, setAdding] = useState(false)
  const [host, setHost] = useState('')
  const [portText, setPortText] = useState('')
  const [addError, setAddError] = useState<string | null>(null)
  const [scanning, setScanning] = useState(false)

  const refresh = (): void => void utils.agentPairing.listDiscoveredAgents.invalidate()

  const add = trpc.agentPairing.addAgentByAddress.useMutation({
    onSuccess: () => {
      setAdding(false)
      setHost('')
      setPortText('')
      setAddError(null)
      refresh()
    },
    onError: (err: { message: string }) => setAddError(err.message),
  })
  const unpair = trpc.agentPairing.unpairAgent.useMutation({
    onSuccess: (result) => {
      setNotice({
        tone: 'success',
        message: `${result.nodeId}: ${result.next}${
          result.agentNotified
            ? ''
            : ' The agent could not be told; forget the hub on its own page.'
        }`,
      })
      refresh()
    },
    onError: (err: { message: string }) =>
      setNotice({
        tone: 'danger',
        message: t('pairing.agentsFoundSection.unpairFailed', 'Unpair failed: {{message}}', {
          message: err.message,
        }),
      }),
  })

  const agents = useMemo(
    () => (list.data?.agents ?? []).toSorted((a, b) => STATE_RANK[a.state] - STATE_RANK[b.state]),
    [list.data],
  )

  const rescan = async (): Promise<void> => {
    setScanning(true)
    try {
      await utils.agentPairing.listDiscoveredAgents.fetch({ refresh: true })
      refresh()
    } finally {
      setScanning(false)
    }
  }

  const submitAdd = (): void => {
    const port = parsePort(portText)
    if (port === null) {
      setAddError('The port must be a whole number between 1 and 65535.')
      return
    }
    setAddError(null)
    add.mutate({ host: host.trim(), ...(port !== undefined ? { port } : {}) })
  }

  const askUnpair = async (agent: DiscoveredAgent): Promise<void> => {
    const ok = await confirm({
      title: t('pairing.agentsFoundSection.unpair', 'Unpair {{nodeId}}', {
        nodeId: agent.nodeId,
      }),
      message: t(
        'pairing.agentsFoundSection.sCertificatesAreRevokedAt',
        "{{nodeId}}'s certificates are revoked at once and it is disconnected from the mesh. It must be paired again before it can rejoin.",
        { nodeId: agent.nodeId },
      ),
      confirmLabel: t('pairing.agentsFoundSection.unpair2', 'Unpair'),
      variant: 'danger',
    })
    if (!ok) return
    setNotice(null)
    unpair.mutate({ nodeId: agent.nodeId })
  }

  const columns = useMemo<readonly DataColumn<DiscoveredAgent>[]>(
    () => [
      {
        key: 'node',
        header: t('pairing.agentsFoundSection.node', 'Node'),
        render: (a) => <span className="font-medium text-foreground">{a.nodeId}</span>,
        sortValue: (a) => a.nodeId,
      },
      {
        key: 'address',
        header: t('pairing.agentsFoundSection.address', 'Address'),
        render: (a) => <span className="font-mono text-xs">{formatEndpoint(a.host, a.port)}</span>,
        sortValue: (a) => a.host,
      },
      {
        key: 'version',
        header: t('pairing.agentsFoundSection.version', 'Version'),
        render: (a) => a.version ?? '—',
        sortValue: (a) => a.version,
      },
      {
        key: 'state',
        header: t('pairing.agentsFoundSection.state', 'State'),
        render: (a) => <AgentStateBadge state={a.state} connected={a.connected} />,
        sortValue: (a) => STATE_RANK[a.state],
      },
      {
        key: 'fingerprint',
        header: t('pairing.agentsFoundSection.certificate', 'Certificate'),
        render: (a) =>
          a.fingerprint === null ? (
            '—'
          ) : (
            <span className="font-mono text-xs" title={a.fingerprint}>
              {shortFingerprint(a.fingerprint)}
            </span>
          ),
        sortValue: (a) => a.fingerprint,
      },
      {
        key: 'actions',
        header: '',
        align: 'right',
        notSortableReason: 'Row actions',
        render: (a) => {
          const open = a.pairing
          return a.state === 'unpaired' ? (
            <Button
              type="button"
              size="sm"
              onClick={() => setTarget({ nodeId: a.nodeId, host: a.host, port: a.port })}
            >
              {t('pairing.agentsFoundSection.pair', 'Pair')}
            </Button>
          ) : a.state === 'paired' ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={unpair.isPending}
              onClick={() => void askUnpair(a)}
            >
              {t('pairing.agentsFoundSection.unpair2', 'Unpair')}
            </Button>
          ) : a.state === 'pending' && open !== null ? (
            <Button
              type="button"
              size="sm"
              onClick={() =>
                setTarget({
                  nodeId: a.nodeId,
                  host: a.host,
                  port: a.port,
                  pairingId: open.pairingId,
                })
              }
            >
              {t('pairing.agentsFoundSection.resume', 'Resume')}
            </Button>
          ) : null
        },
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [unpair.isPending, t],
  )

  return (
    <SectionCard
      headingId="agents-found"
      title={t('pairing.agentsFoundSection.agentsFoundOnTheNetwork', 'Agents found on the network')}
      icon={Radar}
      testId="agents-found"
      actions={
        <>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={scanning}
            onClick={() => void rescan()}
          >
            {scanning ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
            {t('pairing.agentsFoundSection.scan', 'Scan')}
          </Button>
          <Button type="button" size="sm" onClick={() => setAdding((v) => !v)}>
            <Plus className="h-3.5 w-3.5" />
            {t('pairing.agentsFoundSection.addByAddress', 'Add by address')}
          </Button>
        </>
      }
    >
      <div className={`${SECTION_BODY} space-y-3`}>
        <p className="text-[11px] leading-relaxed text-foreground-muted">
          {t(
            'pairing.agentsFoundSection.anAgentHoldsNoSecret',
            'An agent holds no secret: pairing issues it a certificate after you confirm the same six digits on this page and on the agent. Discovery needs the agent on its own IP or host networking; a Docker bridge hides it — add it by address.',
          )}
        </p>
        {adding && (
          <form
            aria-label={t('pairing.agentsFoundSection.addAgentByAddress', 'Add agent by address')}
            className="flex flex-wrap items-start gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              if (host.trim().length > 0 && !add.isPending) submitAdd()
            }}
          >
            <FormField
              label={t('pairing.agentsFoundSection.address', 'Address')}
              description={t(
                'pairing.agentsFoundSection.aPrivateOrLocalAddress',
                'A private or local address only.',
              )}
              {...(addError !== null ? { error: addError } : {})}
            >
              <Input
                value={host}
                onChange={(e) => setHost(e.target.value)}
                placeholder="192.0.2.20"
                aria-label={t('pairing.agentsFoundSection.agentAddress', 'Agent address')}
                autoComplete="off"
              />
            </FormField>
            <FormField
              label={t('pairing.agentsFoundSection.port', 'Port')}
              description={t('pairing.agentsFoundSection.optional', 'Optional.')}
            >
              <Input
                value={portText}
                onChange={(e) => setPortText(e.target.value)}
                placeholder="4444"
                inputMode="numeric"
                aria-label={t('pairing.agentsFoundSection.agentPort', 'Agent port')}
                className="w-24"
              />
            </FormField>
            <Button
              type="submit"
              size="sm"
              className="mt-5"
              disabled={host.trim().length === 0 || add.isPending}
            >
              {add.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {t('common.add', 'Add')}
            </Button>
          </form>
        )}
        {notice !== null && (
          <p
            role="status"
            className={`rounded border px-3 py-2 text-xs ${
              notice.tone === 'success'
                ? 'border-success/30 text-foreground'
                : 'border-danger/40 text-danger'
            }`}
          >
            {notice.message}
          </p>
        )}
        {list.isError ? (
          <ErrorBox
            title={t('pairing.agentsFoundSection.couldNotListAgents', 'Could not list agents')}
            message={
              list.error?.message ?? t('pairing.agentsFoundSection.requestFailed', 'Request failed')
            }
            onRetry={refresh}
          />
        ) : list.isLoading ? (
          <p className="py-4 text-center text-xs text-foreground-muted">
            {t('pairing.agentsFoundSection.lookingForAgents', 'Looking for agents…')}
          </p>
        ) : agents.length === 0 ? (
          <EmptyState
            icon={Radar}
            title={t('pairing.agentsFoundSection.noAgentsFound', 'No agents found')}
            description={t(
              'pairing.agentsFoundSection.nothingIsAdvertisingOnThis',
              'Nothing is advertising on this network. Start the agent on its own IP (or host networking), or add it by address.',
            )}
          />
        ) : (
          <DataTable
            columns={columns}
            rows={agents}
            rowKey={(a) => a.nodeId}
            minWidthPx={720}
            defaultSort={{ columnKey: 'state', dir: 'asc' }}
          />
        )}
      </div>
      <PairingDialog
        target={target}
        onClose={() => setTarget(null)}
        onSettled={refresh}
        onOpenNode={onOpenNode}
      />
    </SectionCard>
  )
}
