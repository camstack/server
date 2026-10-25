/**
 * Exercises the runtime-built `recording-export` router:
 *  - the router mounts (system singleton) under the camel router key `recordingExport`
 *  - a query dispatches to the wired provider and returns typed output
 *  - `protected` auth is enforced (anonymous → UNAUTHORIZED)
 *  - a missing provider surfaces PRECONDITION_FAILED
 */
import { describe, it, expect } from 'vitest'
import { type IRecordingExportProvider, type ExportRecord } from '@camstack/types'
import { makeCtx, invokeProcedure, buildCapRouterForTest } from './harness.js'

function makeRecord(over: Partial<ExportRecord> = {}): ExportRecord {
  return {
    id: 'e1',
    deviceId: 101,
    profile: 'main',
    fromMs: 1_000,
    toMs: 2_000,
    options: { speed: 1, includeAudio: true, maxLifeMs: 604_800_000, deleteAfterDownload: false },
    state: 'queued',
    progressPct: null,
    fileBytes: null,
    expiresAt: 604_808_000,
    deleteAfterDownload: false,
    downloadedAt: null,
    createdAt: 5_000,
    createdBy: 'op',
    error: null,
    ...over,
  }
}

function makeMockProvider(
  overrides: Partial<IRecordingExportProvider> = {},
): Partial<IRecordingExportProvider> {
  return {
    createExport: async () => makeRecord(),
    listExports: async () => [makeRecord({ id: 'e1' }), makeRecord({ id: 'e2' })],
    getExport: async ({ exportId }) => makeRecord({ id: exportId }),
    cancelExport: async ({ exportId }) =>
      makeRecord({ id: exportId, state: 'failed', error: 'cancelled' }),
    deleteExport: async ({ exportId }) => makeRecord({ id: exportId, state: 'deleted' }),
    getDownloadUrl: async ({ exportId }) => ({
      url: `/addon/recorder/exports/${exportId}.mp4`,
      endpoints: [`/addon/recorder/exports/${exportId}.mp4`],
    }),
    ...overrides,
  }
}

describe('recording-export router', () => {
  it('mounts and dispatches listExports to the provider', async () => {
    const router = buildCapRouterForTest('recording-export', () => makeMockProvider())
    const outcome = await invokeProcedure(router, 'listExports', makeCtx('user'), {})
    expect(outcome.ok).toBe(true)
    if (outcome.ok) {
      expect(Array.isArray(outcome.value)).toBe(true)
      expect((outcome.value as ExportRecord[]).map((r) => r.id)).toEqual(['e1', 'e2'])
    }
  })

  it('dispatches getDownloadUrl and returns the data-plane url shape', async () => {
    const router = buildCapRouterForTest('recording-export', () => makeMockProvider())
    const outcome = await invokeProcedure(router, 'getDownloadUrl', makeCtx('user'), {
      exportId: 'abc',
    })
    expect(outcome.ok).toBe(true)
    if (outcome.ok) {
      expect(outcome.value).toEqual({
        url: '/addon/recorder/exports/abc.mp4',
        endpoints: ['/addon/recorder/exports/abc.mp4'],
      })
    }
  })

  it('rejects anonymous (protected endpoint)', async () => {
    const router = buildCapRouterForTest('recording-export', () => makeMockProvider())
    const outcome = await invokeProcedure(router, 'listExports', makeCtx('anonymous'), {})
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.code).toBe('UNAUTHORIZED')
  })

  it('throws PRECONDITION_FAILED when no provider is registered', async () => {
    const router = buildCapRouterForTest('recording-export', () => null)
    const outcome = await invokeProcedure(router, 'listExports', makeCtx('admin'), {})
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.code).toBe('PRECONDITION_FAILED')
  })
})
