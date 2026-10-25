/**
 * The stream route's decision, from the service's own gates to the producer.
 *
 * Nothing here is a second authority: the device gate is the service's
 * `gateClipDevice` (the one the file path runs), the row is the catalog's, and
 * the bytes are `clip-stream.ts`'s. This module only decides, in order, which
 * of them refuses — and says so, per camera — before the camera is touched.
 *
 * Which TWIN and which AUDIO are the caller's, on the target, not this
 * module's. The route used to open `row.subFileName` unconditionally while
 * the dial's answer already claimed `served: high` for a `high` ask (D599) —
 * the silent 33x substitution D576 forbids, produced by the one call site
 * that had not been told. It is told now. Nothing is written and nothing is
 * looked up in the scratch — a stream is not a file and must not warm or
 * read one.
 *
 * An in-progress row is refused by name even though `listableClips` no longer
 * lists one: a stream of a file the camera is still writing has no end for the
 * idle window to find, and the key may reach this route from a listing older
 * than the gate.
 */
import type { IScopedLogger } from '@camstack/types'

import type { ReolinkClipRow } from './clip-catalog.js'
import type {
  ClipStreamRouteOutcome,
  ClipStreamRouteSink,
  ClipStreamTarget,
} from './clip-data-plane.js'
import type { GateClipDeviceInput, GateClipDeviceOutcome } from './clip-service.js'
import type { ClipStreamProducer } from './clip-stream.js'

export interface ClipStreamRouteDeps {
  readonly logger: IScopedLogger
  /** The service's one device gate — shared with the file path. */
  gate(input: GateClipDeviceInput): Promise<GateClipDeviceOutcome>
  rowFor(deviceId: number, clipKey: string): ReolinkClipRow | null
  readonly producer: ClipStreamProducer
}

export type ClipStreamRoute = (
  target: ClipStreamTarget,
  sink: ClipStreamRouteSink,
) => Promise<ClipStreamRouteOutcome>

export function createClipStreamRoute(deps: ClipStreamRouteDeps): ClipStreamRoute {
  return async (target, sink) => {
    const { deviceId, clipKey, twin, audio } = target
    const gate = await deps.gate({ deviceId, clipKey, twin, path: 'stream' })
    if (gate.kind === 'refused') return { kind: 'refused', code: gate.branch, detail: gate.detail }
    const row = deps.rowFor(deviceId, clipKey)
    if (row === null) {
      deps.logger.warn('videoclips: no catalog row for this clip stream', {
        tags: { deviceId },
        meta: { clipKey, twin, branch: 'no-catalog-row' },
      })
      return {
        kind: 'refused',
        code: 'no-catalog-row',
        detail: 'no-catalog-row: list this day before asking for its stream',
      }
    }
    if (row.inProgress === true) {
      deps.logger.warn('videoclips: refusing to stream a clip the camera is still writing', {
        tags: { deviceId },
        meta: { clipKey, twin, branch: 'clip-in-progress' },
      })
      return {
        kind: 'refused',
        code: 'clip-in-progress',
        detail:
          'clip-in-progress: the camera is still writing this file; it has no end to stream to',
      }
    }
    const fileName = twin === 'main' ? (row.mainFileName ?? '') : row.subFileName
    if (fileName === '') {
      // The twin the caller was PROMISED does not exist on this row. Refused
      // by name rather than quietly opening the other one: `chooseClipTwin`
      // is the only place a downgrade may be decided, and it answered before
      // the dial was minted.
      deps.logger.warn('videoclips: no byte handle for the twin this clip stream names', {
        tags: { deviceId },
        meta: { clipKey, twin, branch: 'no-catalog-row' },
      })
      return {
        kind: 'refused',
        code: 'no-catalog-row',
        detail: `no-catalog-row: this clip is listed with no ${twin} file behind it`,
      }
    }
    const outcome = await deps.producer.stream({
      device: gate.device,
      row,
      fileName,
      twin,
      audio,
      sink,
    })
    switch (outcome.kind) {
      case 'served':
        return { kind: 'served' }
      case 'cut':
        return { kind: 'cut' }
      case 'refused':
        return { kind: 'refused', code: outcome.code, detail: outcome.detail }
    }
  }
}
