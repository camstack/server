/**
 * Identity → Certificates → Nodes: ONE row per node for the two certificates it
 * holds — the one it serves over HTTPS (`certificates.listHttpsCertificates`)
 * and the one that proves its identity to the hub (`certificates.getMeshCertificates`).
 * Only the UI is unified: they come from different CAs and serve different
 * purposes, and every action names which of the two it acts on.
 *
 *  - Renew HTTPS: works on every online node, except an operator-UPLOADED
 *    certificate on the hub (the button is off and says where to replace it).
 *  - Renew identity: a hand-over — the old leaf is revoked only after the hub
 *    SEES the node connected with the new one; ends in one line naming the
 *    stage when it failed.
 *  - Revoke identity: final for that leaf; the node is disconnected and must
 *    be paired again.
 */
import { DataTable, TABLE_SCROLL_MAX_H, trpc, useConfirm } from '@camstack/ui-library'
import { Server } from 'lucide-react'
import { useMemo, useState, type ReactNode } from 'react'

import { AccessSection, pickNotice, type AccessNotice } from '../access/AccessSection'
import { describeMeshRenewal } from './certificate-model'
import { CaStrip } from './CaStrip'
import { nodeColumns, type NodeAction } from './nodes-columns'
import { joinNodes, type NodeCertificateRow } from './nodes-model'
import { QueryBody } from './QueryBody'
import { useNow } from './use-now'
import { useTranslation } from 'react-i18next'

interface Running {
  readonly nodeId: string
  readonly action: NodeAction
}

export function NodesCard(): ReactNode {
  const { t } = useTranslation()
  const confirm = useConfirm()
  const utils = trpc.useUtils()
  const now = useNow(60_000)
  const https = trpc.certificates.listHttpsCertificates.useQuery()
  const mesh = trpc.certificates.getMeshCertificates.useQuery()
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<AccessNotice | null>(null)
  const [running, setRunning] = useState<Running | null>(null)

  const finish = (): void => {
    setRunning(null)
    void utils.certificates.listHttpsCertificates.invalidate()
    void utils.certificates.getMeshCertificates.invalidate()
  }
  const failed =
    (what: string) =>
    (err: { message: string }, vars: { nodeId: string }): void => {
      setRunning(null)
      setError(`${vars.nodeId}: ${what} - ${err.message}`)
    }

  const renewHttps = trpc.certificates.renewHttpsOnNode.useMutation({
    onSuccess: (status, vars) => {
      setDone({
        tone: 'success',
        message: status.restartRequired
          ? t(
              'certificates.nodesCard.newCertificateIssuedRestartThe',
              '{{nodeId}}: new certificate issued. Restart the node to serve it.',
              { nodeId: vars.nodeId },
            )
          : t(
              'certificates.nodesCard.newCertificateIssuedAndServed',
              '{{nodeId}}: new certificate issued and served.',
              { nodeId: vars.nodeId },
            ),
      })
      finish()
    },
    onError: failed('renewal failed'),
  })
  const renewIdentity = trpc.certificates.renewMeshOnNode.useMutation({
    onSuccess: (result) => {
      setDone(describeMeshRenewal(result))
      finish()
    },
    onError: failed('renewal could not start'),
  })
  const revokeIdentity = trpc.certificates.revokeMeshOnNode.useMutation({
    onSuccess: (result) => {
      setDone({ tone: 'success', message: `${result.nodeId}: ${result.next}` })
      finish()
    },
    onError: failed('revoke failed'),
  })
  const busy = renewHttps.isPending || renewIdentity.isPending || revokeIdentity.isPending

  const start = (nodeId: string, action: NodeAction): void => {
    setError(null)
    setDone(null)
    setRunning({ nodeId, action })
  }

  const onRenewHttps = async (row: NodeCertificateRow): Promise<void> => {
    const ok = await confirm({
      title: t('certificates.nodesCard.renewHttpsOn', 'Renew HTTPS on "{{nodeId}}"?', {
        nodeId: row.nodeId,
      }),
      message: row.isHub
        ? t(
            'certificates.nodesCard.aNewCertificateIsIssued',
            'A new certificate is issued from the local CA. Clients that trust the CA keep working.',
          )
        : t(
            'certificates.nodesCard.theNodeMakesANew',
            'The node makes a new key, the hub signs it and the node switches over without a restart. It keeps serving what it had if anything fails.',
          ),
      confirmLabel: t('certificates.nodesCard.renew', 'Renew'),
    })
    if (!ok) return
    start(row.nodeId, 'renew-https')
    renewHttps.mutate({ nodeId: row.nodeId })
  }
  const onRenewIdentity = (row: NodeCertificateRow): void => {
    start(row.nodeId, 'renew-identity')
    renewIdentity.mutate({ nodeId: row.nodeId })
  }
  const onRevokeIdentity = async (row: NodeCertificateRow): Promise<void> => {
    const ok = await confirm({
      title: t(
        'certificates.nodesCard.revokeTheIdentityOf',
        'Revoke the identity of "{{nodeId}}"?',
        { nodeId: row.nodeId },
      ),
      message: t(
        'certificates.nodesCard.isDisconnectedAtOnceAnd',
        '{{nodeId}} is disconnected at once and can no longer connect. To bring it back it must be paired again from System → Cluster → Agents. It stays in the node list until you forget it on the Cluster page. This cannot be undone.',
        { nodeId: row.nodeId },
      ),
      confirmLabel: t('certificates.nodesCard.revokeAndDisconnect', 'Revoke and disconnect'),
      variant: 'danger',
    })
    if (!ok) return
    start(row.nodeId, 'revoke-identity')
    revokeIdentity.mutate({ nodeId: row.nodeId })
  }

  const columns = nodeColumns({
    now,
    busy,
    running,
    onRenewHttps: (r) => void onRenewHttps(r),
    onRenewIdentity,
    onRevokeIdentity: (r) => void onRevokeIdentity(r),
  })
  const rows = useMemo(() => joinNodes(https.data ?? [], mesh.data), [https.data, mesh.data])
  const registryAvailable = mesh.data?.registryAvailable ?? true

  return (
    <AccessSection
      id="nodes"
      title={t('certificates.nodesCard.nodes', 'Nodes')}
      icon={Server}
      description={t(
        'certificates.nodesCard.eachNodeHoldsTwoCertificates',
        'Each node holds two certificates: one it serves over HTTPS, one that proves its identity to the hub. Renewing replaces a certificate without a gap; revoking an identity cuts the node off until it re-joins.',
      )}
      notice={pickNotice(error, done)}
      onDismissNotice={() => {
        setError(null)
        setDone(null)
      }}
    >
      <QueryBody
        isPending={https.isPending || mesh.isPending}
        error={https.error ?? mesh.error}
        what="node certificates"
        onRetry={() => {
          void https.refetch()
          void mesh.refetch()
        }}
      >
        <div className="space-y-3">
          <CaStrip https={https.data ?? []} mesh={mesh.data} now={now} />
          <DataTable
            columns={columns}
            rows={rows}
            rowKey={(r) => r.nodeId}
            minWidthPx={960}
            maxBodyHeight={TABLE_SCROLL_MAX_H}
            defaultSort={{ columnKey: 'node', dir: 'asc' }}
            emptyMessage={
              registryAvailable
                ? t('certificates.nodesCard.noNodesReported', 'No nodes reported.')
                : t(
                    'certificates.nodesCard.theCertificateRegistryIsNot',
                    'The certificate registry is not available yet, so nodes cannot be listed.',
                  )
            }
          />
        </div>
      </QueryBody>
    </AccessSection>
  )
}
