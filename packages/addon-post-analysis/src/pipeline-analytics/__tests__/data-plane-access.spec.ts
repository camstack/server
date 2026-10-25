/**
 * The access level of every pipeline-analytics data plane is a POLICY, and this
 * is the guard on it.
 *
 * It exists because the levels drifted apart from the cap surface serving the
 * same bytes, and nothing noticed for as long as the only people looking were
 * admins. `event-media` was `admin` while `pipelineAnalytics.getTrackMedia` —
 * the SAME blob, base64 over tRPC — is `access: 'view'`; the gate protected
 * nothing and cost every non-admin operator their thumbnails.
 *
 * The rule the table encodes: a plane serving ONE item the caller already had
 * to be told about is `authenticated`; a plane that walks off with a CORPUS is
 * `admin`. A future change that flips either direction goes red here.
 */
import { describe, expect, it } from 'vitest'
import {
  NC_ARTIFACT_READ_PREFIX_REF,
  PIPELINE_ANALYTICS_PLANE_ACCESS,
  planeAccess,
  RETRAIN_EXPORT_PREFIX_REF,
  RETRAIN_FRAME_PREFIX_REF,
  TAPE_EXPORT_PREFIX_REF,
  TRAINING_EXPORT_PREFIX_REF,
} from '../data-plane-access'
import { DEBUG_EXPORT_PREFIX } from '../debug/debug-bundle'
import { TAPE_EXPORT_PREFIX } from '../debug/tape-export-handler'
import { artifactDownloadPath } from '../../notification-center/artifact-index'

describe('pipeline-analytics data-plane access policy', () => {
  it('serves event media to any AUTHENTICATED caller, not just admins', () => {
    // The operator-facing statement: a thumbnail is not an admin secret.
    expect(planeAccess('event-media')).toBe('authenticated')
  })

  it('keeps every BULK-EXPORT plane admin-only', () => {
    // Marking a track is a viewer-level curation act (D81); walking off with
    // every stored frame behind the marked set is not.
    expect(planeAccess(TRAINING_EXPORT_PREFIX_REF)).toBe('admin')
    expect(planeAccess(RETRAIN_EXPORT_PREFIX_REF)).toBe('admin')
    expect(planeAccess(RETRAIN_FRAME_PREFIX_REF)).toBe('admin')
    expect(planeAccess(DEBUG_EXPORT_PREFIX)).toBe('admin')
    expect(planeAccess(TAPE_EXPORT_PREFIX_REF)).toBe('admin')
  })

  it('leaves the notification-center planes on their own token auth (D47)', () => {
    // `public` at the hub gate is NOT unauthenticated: both planes verify a
    // single-use action/artifact token themselves. Promoting them to
    // `authenticated` would break every notification button, which is opened
    // from a phone with no hub session at all.
    expect(planeAccess('nc-action')).toBe('public')
    expect(planeAccess('nc-artifact')).toBe('public')
  })

  it('serves the viewer artifact library to any AUTHENTICATED caller', () => {
    // Task #36. Same rule as event-media: ONE indexed artefact by an
    // unguessable id the caller was handed by `nc.listArtifacts`.
    expect(planeAccess(NC_ARTIFACT_READ_PREFIX_REF)).toBe('authenticated')
  })

  // A signed plane is opened by strangers; this one is not. Making it `public`
  // would serve every indexed artefact to an unauthenticated id-guesser, and
  // unlike the two nc planes this handler has no token of its own to check.
  it('never admits an UNAUTHENTICATED caller to the artifact library', () => {
    expect(planeAccess(NC_ARTIFACT_READ_PREFIX_REF)).not.toBe('public')
  })

  it('declares a level for every plane the addon serves, and nothing else', () => {
    expect(Object.keys(PIPELINE_ANALYTICS_PLANE_ACCESS).sort()).toEqual([
      'debug-export',
      'event-media',
      'nc-action',
      'nc-artifact',
      'nc-artifact-read',
      'retrain-export',
      'retrain-frame',
      'tape-export',
      'training-export',
    ])
  })

  // The prefix is ALSO baked into every index row's `downloadPath`. Two copies
  // of that string is a 404 nobody would think to look for.
  it('serves the artifact library on the SAME prefix the index writes', () => {
    expect(NC_ARTIFACT_READ_PREFIX_REF).toBe('nc-artifact-read')
    expect(artifactDownloadPath('pipeline-analytics', 'abc')).toBe(
      `/addon/pipeline-analytics/${NC_ARTIFACT_READ_PREFIX_REF}/abc`,
    )
  })

  it('the export prefix references match the modules that own them', () => {
    // The table keys are literals so the policy reads as a table; these assert
    // the literals have not drifted from the constants the handlers register.
    expect(TRAINING_EXPORT_PREFIX_REF).toBe('training-export')
    expect(RETRAIN_EXPORT_PREFIX_REF).toBe('retrain-export')
    expect(DEBUG_EXPORT_PREFIX).toBe('debug-export')
    expect(TAPE_EXPORT_PREFIX_REF).toBe(TAPE_EXPORT_PREFIX)
  })

  it('never admits an UNAUTHENTICATED caller to event media', () => {
    // The one thing this change must not become. `public` would mean the hub
    // proxies straight through with no token at all — and unlike the nc planes,
    // the event-media handler has no token of its own to check.
    expect(planeAccess('event-media')).not.toBe('public')
  })
})
