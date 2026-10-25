/**
 * Resolve the host a REMOTE recording node should use to dial the hub-only
 * stream-broker's restream port.
 *
 * The implementation was promoted to the package-shared
 * `src/shared/hub-hostname.ts` in P2d (cross-node Phase 2) so the
 * pipeline-runner's remote-source leg shares the exact same resolver instead
 * of copying it. This module keeps the recorder-facing name as a thin alias —
 * resolution order and semantics are unchanged (operator override first, then
 * the host extracted from `CAMSTACK_HUB_URL`).
 */
import { resolveHubHostname } from '../../shared/hub-hostname.js'

export const resolveRecordingHubHostname = resolveHubHostname
