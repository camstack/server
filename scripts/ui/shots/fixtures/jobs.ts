/**
 * The Activity panel (shell) and System → Jobs (`/system/jobs`, planning#719):
 * a running adoption with progress 3/10, a running one with unknown progress, a
 * failed one, a finished one with a result link, and an automatic job.
 */
import { defineFixtures } from './_define'
import { H, MINUTE, NOW } from './_time'

const job = (over: Record<string, unknown>) => ({
  producerAddonId: 'device-manager',
  ownerUserId: 'u-admin',
  audience: 'owner',
  titleKey: 'jobs.adoption.title',
  titleParams: { addonId: 'provider-unifi', integrationId: 'int-1', total: 10 },
  failure: null,
  progress: null,
  cancellable: true,
  lastConfirmedAt: NOW,
  finishedAt: null,
  ...over,
})

const JOBS = [
  job({
    jobId: 'job-1',
    kind: 'adoption',
    state: 'running',
    progress: { done: 3, total: 10, unit: 'candidates' },
    createdAt: NOW - 4 * MINUTE,
    updatedAt: NOW - 20_000,
  }),
  job({
    jobId: 'job-2',
    kind: 'adoption',
    ownerUserId: 'u-viewer',
    state: 'running',
    progress: null,
    createdAt: NOW - 2 * MINUTE,
    updatedAt: NOW - 10_000,
  }),
  job({
    jobId: 'job-3',
    kind: 'adoption',
    state: 'failed',
    failure: { reason: 'error', message: 'Camera 198.51.100.24 refused the credentials' },
    createdAt: NOW - 3 * H,
    updatedAt: NOW - 3 * H + 5 * MINUTE,
    finishedAt: NOW - 3 * H + 5 * MINUTE,
  }),
  job({
    jobId: 'job-4',
    kind: 'adoption',
    state: 'done',
    progress: { done: 6, total: 6, unit: 'candidates' },
    cancellable: false,
    createdAt: NOW - 26 * H,
    updatedAt: NOW - 26 * H + 8 * MINUTE,
    finishedAt: NOW - 26 * H + 8 * MINUTE,
  }),
  job({
    jobId: 'job-5',
    kind: 'storage.drain',
    titleKey: 'jobs.storageDrain.unknown',
    titleParams: {},
    ownerUserId: 'system',
    audience: 'admins',
    state: 'queued',
    cancellable: false,
    createdAt: NOW - 30_000,
    updatedAt: NOW - 30_000,
  }),
]

export default defineFixtures({
  area: 'jobs',
  description:
    'Activity panel + System → Jobs: running, indeterminate, failed, done with result, queued',
  handlers: {
    'jobs.list': JOBS,
    'jobs.getSummary': { running: 2, unseenFinished: 2 },
    'jobs.collect': (input: unknown) =>
      (input as { jobId?: string } | undefined)?.jobId === 'job-4' ? { href: '/devices' } : null,
    'mut:jobs.cancel': { accepted: true, reason: null },
    'mut:jobs.dismiss': { dismissed: true },
    'userManagement.listUsers': [
      { id: 'u-admin', username: 'admin', isAdmin: true },
      { id: 'u-viewer', username: 'viewer-one', isAdmin: false },
    ],
  },
})
