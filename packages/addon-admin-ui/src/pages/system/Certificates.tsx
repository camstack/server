/**
 * Identity → Certificates (D855, D856): the kinds of certificate the hub
 * deals with — paired devices (and the CA that signs them) and one row per
 * node for the HTTPS and the cluster-identity certificate it holds.
 * "Pair a device" is the page header's action (Identity.tsx), which holds the
 * open state and hands it down.
 */
import type { ReactNode } from 'react'

import { DeviceCaCard } from '../../components/certificates/DeviceCaCard'
import { DevicesCard } from '../../components/certificates/DevicesCard'
import { HttpsCertificateCard } from '../../components/certificates/HttpsCertificateCard'
import { NodesCard } from '../../components/certificates/NodesCard'

export interface CertificatesPageProps {
  readonly pairOpen: boolean
  readonly onPairClose: () => void
}

export function CertificatesPage({ pairOpen, onPairClose }: CertificatesPageProps): ReactNode {
  return (
    <div className="space-y-4" data-testid="certificates-page">
      <DevicesCard pairOpen={pairOpen} onPairClose={onPairClose} />
      <DeviceCaCard />
      <HttpsCertificateCard />
      <NodesCard />
    </div>
  )
}
