import type { OnboardStorage } from '@camstack/types'

import { isCgiHttpStatus } from './amcrest-cgi-client.js'
import { parseOnboardStorage } from './recording-onboard-mapping.js'

/**
 * THE storage read of this addon — `storageDevice.cgi?action=getDeviceAllInfo`
 * — shared by `recording-onboard` (D614) and the clip source, so both hold one
 * opinion about whether a card is in the slot.
 *
 * Three answers:
 *
 * - the camera answered a table → {@link parseOnboardStorage} (`present`, or
 *   `absent` when it lists no storage device);
 * - the camera answered **HTTP 400** → `absent`. A Dahua model with no card
 *   slot (a Lite IPC-HDBW1431E-S4) refuses the storage query outright; that is
 *   its statement that there is no onboard storage, not a failed read;
 * - anything else (network error, timeout, 401, 5xx) → `unknown`. A read that
 *   FAILED is never folded into "no card" (D393).
 */
export async function readOnboardStorage(
  read: () => Promise<ReadonlyMap<string, string>>,
): Promise<OnboardStorage> {
  try {
    return parseOnboardStorage(await read())
  } catch (err: unknown) {
    if (isCgiHttpStatus(err, 400)) {
      return {
        kind: 'absent',
        reason: 'The camera refused the storage query (HTTP 400) — it has no onboard storage.',
      }
    }
    return {
      kind: 'unknown',
      reason: `The camera did not answer the storage read: ${
        err instanceof Error ? err.message : String(err)
      }`,
    }
  }
}
