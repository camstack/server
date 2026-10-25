/** The pairing state of a discovered agent, with whether it is connected to the mesh. */
import { Badge } from '@camstack/ui-library'
import type { ReactNode } from 'react'

import { AGENT_STATE_LABEL, type AgentPairState } from './pairing-model'
import { useTranslation } from 'react-i18next'

const VARIANT: Readonly<Record<AgentPairState, 'success' | 'warning' | 'default'>> = {
  paired: 'success',
  pending: 'warning',
  unpaired: 'default',
}

export function AgentStateBadge({
  state,
  connected,
}: {
  readonly state: AgentPairState
  readonly connected: boolean
}): ReactNode {
  const { t } = useTranslation()
  return (
    <span className="inline-flex items-center gap-1.5">
      <Badge variant={VARIANT[state]} className="text-[10px]">
        {AGENT_STATE_LABEL[state]}
      </Badge>
      {state === 'paired' && (
        <span className="text-[10px] text-foreground-muted">
          {connected
            ? t('common.connected')
            : t('pairing.agentStateBadge.notConnected', 'not connected')}
        </span>
      )}
    </span>
  )
}
