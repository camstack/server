/**
 * The `.restart-pending` marker is the ONLY thing that survives the reboot, so
 * whatever it does not carry the operator will never be told.
 *
 * On 2026-08-19 the hub's own log read
 * `Restart completed {kind=framework-update nodeId=hub packageName=@camstack/server
 * toVersion=1.2.138 requestedBy="server-update: @camstack/server@1.2.138"}` — no
 * `fromVersion` anywhere, because the reason STRING was the only channel and it
 * spells one version. The notification then fell back to its version-less
 * sentence and said neither.
 *
 * The second case here is the mirror image: a PLAIN node restart also travels
 * under the `server-update:` prefix (`RootUpdateService.restartNode`), and
 * labelling it `framework-update` announces an update that never happened.
 */
import { describe, expect, it } from 'vitest'
import { buildRestartMarker } from '../restart-marker.js'

const REQUESTED_AT = 1_787_170_489_404

describe('buildRestartMarker', () => {
  it('records the version the node LEFT alongside the one it went to', () => {
    expect(
      buildRestartMarker({
        requestedBy: 'server-update: @camstack/server@1.2.138',
        update: {
          packageName: '@camstack/server',
          fromVersion: '1.2.137',
          toVersion: '1.2.138',
        },
        requestedAt: REQUESTED_AT,
      }),
    ).toEqual({
      kind: 'framework-update',
      requestedAt: REQUESTED_AT,
      requestedBy: 'server-update: @camstack/server@1.2.138',
      packageName: '@camstack/server',
      fromVersion: '1.2.137',
      toVersion: '1.2.138',
    })
  })

  it('still records the target when only the reason string is available', () => {
    expect(
      buildRestartMarker({
        requestedBy: 'server-update: @camstack/server@1.2.138',
        requestedAt: REQUESTED_AT,
      }),
    ).toEqual({
      kind: 'framework-update',
      requestedAt: REQUESTED_AT,
      requestedBy: 'server-update: @camstack/server@1.2.138',
      packageName: '@camstack/server',
      toVersion: '1.2.138',
    })
  })

  it('does not call a plain node restart a framework update', () => {
    expect(
      buildRestartMarker({
        requestedBy: 'server-update: manual restart',
        requestedAt: REQUESTED_AT,
      }),
    ).toEqual({
      kind: 'manual',
      requestedAt: REQUESTED_AT,
      requestedBy: 'server-update: manual restart',
    })
  })

  it('an operator-requested restart names its requester and nothing else', () => {
    expect(
      buildRestartMarker({
        requestedBy: 'alice',
        requestedAt: REQUESTED_AT,
      }),
    ).toEqual({
      kind: 'manual',
      requestedAt: REQUESTED_AT,
      requestedBy: 'alice',
    })
    expect(buildRestartMarker({ requestedAt: REQUESTED_AT })).toEqual({
      kind: 'manual',
      requestedAt: REQUESTED_AT,
    })
  })
})
