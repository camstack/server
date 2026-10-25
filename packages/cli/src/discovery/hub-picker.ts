/**
 * Choosing a hub from what {@link findHubs} returned (D838): none is an error
 * that points at `--server`; one or several are offered in a picker whose
 * first entry (the default, one Enter) is the found hub and whose last entry is
 * a typed address — a single found hub is NOT taken silently, because a hub
 * that does not announce (an old build) would otherwise be unreachable. A
 * server given explicitly never reaches this module. Prompts are injected so
 * the flow is tested without a terminal.
 */
import { normalizeHubAddress } from '@camstack/develop'
import { describeHub, type HubCandidate, validateManualHubUrl } from './hub-finder.js'

export const MANUAL_ENTRY_VALUE = '__manual__'
export const MANUAL_ENTRY_LABEL = 'Enter an address…'

export interface HubPrompts {
  select(message: string, options: readonly { value: string; label: string }[]): Promise<string>
  text(message: string, validate: (value: string) => string | undefined): Promise<string>
}

export const NO_HUB_MESSAGE =
  'No camstack hub found on this network (mDNS) or among the hubs this machine knows. ' +
  'Pass --server https://<host>:<port>, and check the hub is reachable from here.'

export async function pickHub(hubs: readonly HubCandidate[], prompts: HubPrompts): Promise<string> {
  if (hubs.length === 0) throw new Error(NO_HUB_MESSAGE)
  const chosen = await prompts.select('Select a hub to log into', [
    ...hubs.map((h) => ({ value: h.url, label: describeHub(h) })),
    { value: MANUAL_ENTRY_VALUE, label: MANUAL_ENTRY_LABEL },
  ])
  if (chosen !== MANUAL_ENTRY_VALUE) return chosen
  const typed = await prompts.text(
    'Hub address (host, host:port or https://host:port)',
    validateManualHubUrl,
  )
  return normalizeHubAddress(typed)
}
