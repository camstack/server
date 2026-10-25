/**
 * The hub this agent is paired with, and the way out (D857).
 *
 * "Forget this hub" erases the mesh certificate the hub issued; the agent then
 * accepts a new pairing. The agent allows it from its own machine or from a
 * hub-unlocked session - this card only renders behind that lock, so reaching
 * it already proves one of the two.
 */
import { ConfirmActionButton, SettingRow } from '@camstack/ui-library'
import { Unlink } from 'lucide-react'
import { useT } from './i18n'
import { PAIRING_FORGET_PATH, describeFailure, groupFingerprint, sendPairing } from './pairing-api'

/** Mirrors `PairedHubInfo` in `server/backend/src/agent/agent-http.ts`. */
export interface PairedHubInfo {
  readonly url: string | null
  readonly caFingerprint: string
}

interface PairedHubCardProps {
  /** `null` on an agent that predates the field: only the fact of pairing is known. */
  readonly hub: PairedHubInfo | null
  /** The hub's own name when the agent's cluster registry knows it. */
  readonly hubName: string | null
  readonly onForgotten: () => Promise<void>
}

async function forgetHub(): Promise<void> {
  const outcome = await sendPairing(PAIRING_FORGET_PATH, {})
  if (!outcome.ok) throw new Error(describeFailure(outcome))
}

export function PairedHubCard({ hub, hubName, onForgotten }: PairedHubCardProps) {
  const { t } = useT()
  return (
    <div className="space-y-3">
      <div className="space-y-0">
        <SettingRow label={t('paired.pairedWith')}>{hubName ?? t('paired.theHub')}</SettingRow>
        {hub?.url != null && (
          <SettingRow label={t('paired.hubUrl')} valueClassName="font-mono break-all">
            {hub.url}
          </SettingRow>
        )}
        {hub !== null && (
          <SettingRow label={t('paired.caFingerprint')} valueClassName="font-mono break-all">
            {groupFingerprint(hub.caFingerprint)}
          </SettingRow>
        )}
      </div>
      <ConfirmActionButton
        label={t('paired.forget')}
        icon={Unlink}
        title={t('paired.forgetTitle')}
        description={t('paired.forgetDescription')}
        confirmLabel={t('paired.forgetConfirm')}
        size="sm"
        action={forgetHub}
        onSuccess={() => void onForgotten()}
      />
    </div>
  )
}
