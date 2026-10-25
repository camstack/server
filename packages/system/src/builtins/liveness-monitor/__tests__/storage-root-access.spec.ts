/**
 * A storage root this process cannot write is reported ONCE at boot, naming
 * the path, its owner, its mode and the uid — and raised as an alert.
 *
 * Fresh dev hub (CT200), 2026-10-23: `/recordings` was `root:root 0755`, the
 * hub runs as uid 1001, and the first sign was `EACCES` on
 * `/recordings/artifacts` — nothing at boot said the recordings disk was
 * unusable. The real probe runs here against real directories.
 */
import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  EventCategory,
  type IScopedLogger,
  type StorageLocation,
  type SystemEvent,
} from '@camstack/types'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { isLivenessFindingId, type LivenessFinding } from '../liveness-checks.js'
import { LivenessReporter } from '../liveness-reporter.js'
import {
  isStorageRootFindingId,
  nodeStorageRootProbe,
  probeStorageRoot,
  storageRootFindings,
  storageRootTargets,
} from '../storage-root-access.js'

function location(over: Partial<StorageLocation> & Pick<StorageLocation, 'id'>): StorageLocation {
  return {
    type: over.id.split(':')[0] ?? 'recordings',
    displayName: over.id,
    providerId: 'filesystem-storage',
    config: {},
    nodeId: 'hub',
    isSystem: false,
    enabled: true,
    mode: 'active',
    createdAt: 0,
    updatedAt: 0,
    ...over,
  }
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'storage-root-access-'))
const lockedDir = path.join(root, 'recordings')
const openDir = path.join(root, 'data')
fs.mkdirSync(lockedDir)
fs.mkdirSync(openDir)
fs.chmodSync(lockedDir, 0o555) // root:root 0755 seen by uid 1001 — no write bit for us

afterAll(() => {
  fs.chmodSync(lockedDir, 0o755)
  fs.rmSync(root, { recursive: true, force: true })
})

const runsAsRoot = typeof process.getuid === 'function' && process.getuid() === 0

const LOCATIONS: readonly StorageLocation[] = [
  location({ id: 'recordings:default', config: { basePath: lockedDir } }),
  // A missing root under the locked mount: judged by the directory it must be created in.
  location({ id: 'artifacts:default', config: { basePath: path.join(lockedDir, 'artifacts') } }),
  location({ id: 'eventMedia:default', config: { basePath: openDir } }),
  // Not this node's, not writable, not local, not absolute: never judged.
  location({ id: 'recordings:agent', nodeId: 'agent-a', config: { basePath: lockedDir } }),
  location({ id: 'recordings:old', mode: 'readonly', config: { basePath: lockedDir } }),
  location({ id: 'backups:nas', providerId: 'smb-storage', config: { basePath: lockedDir } }),
  location({ id: 'backups:rel', config: { basePath: 'camstack' } }),
]

describe('storage roots the node cannot write', () => {
  it('selects only this node’s writable, local, absolute roots', () => {
    expect(storageRootTargets(LOCATIONS, 'hub')).toEqual([
      { path: openDir, locationIds: ['eventMedia:default'] },
      { path: lockedDir, locationIds: ['recordings:default'] },
      { path: path.join(lockedDir, 'artifacts'), locationIds: ['artifacts:default'] },
    ])
  })

  it.skipIf(runsAsRoot)(
    'one finding for the locked mount, naming path, owner, mode and uid',
    async () => {
      const probe = nodeStorageRootProbe(fsp)
      const results = await Promise.all(
        storageRootTargets(LOCATIONS, 'hub').map((t) => probeStorageRoot(t, probe)),
      )
      expect(results.map((r) => r.kind)).toEqual(['writable', 'unwritable', 'unwritable'])
      const findings = storageRootFindings(results, probe)
      expect(findings).toHaveLength(1)
      const [finding] = findings
      const st = fs.statSync(lockedDir)
      expect(finding?.id).toBe(`liveness:storage-root-unwritable:${lockedDir}`)
      expect(finding?.severity).toBe('error')
      expect(finding?.message).toContain(lockedDir)
      expect(finding?.message).toContain(`owned by ${st.uid}:${st.gid}`)
      expect(finding?.message).toContain('mode 0555')
      expect(finding?.message).toContain(`uid ${String(process.getuid?.())}`)
      expect(finding?.message).toContain('artifacts:default')
      expect(finding?.message).toContain('recordings:default')
    },
  )

  it('one ERROR and one alert event per fault — not one per check — and a recovery when fixed', () => {
    const errors: string[] = []
    const logger: IScopedLogger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: (msg: string) => {
        errors.push(msg)
      },
      child: () => logger,
      withTags: () => logger,
    }
    const events: SystemEvent[] = []
    const reporter = new LivenessReporter({ logger, emit: (e) => events.push(e) })
    const finding: LivenessFinding = {
      id: `liveness:storage-root-unwritable:${lockedDir}`,
      severity: 'error',
      title: 'Storage location not writable',
      message: `${lockedDir} is owned by 0:0 with mode 0755`,
    }
    const deviceFinding: LivenessFinding = {
      id: 'liveness:no-devices',
      severity: 'error',
      title: 'No devices',
      message: 'none',
    }
    reporter.report([deviceFinding], isLivenessFindingId)
    reporter.report([finding], isStorageRootFindingId)
    reporter.report([finding], isStorageRootFindingId) // the next tick: unchanged
    expect(errors.filter((m) => m.includes('Storage location not writable'))).toHaveLength(1)
    expect(
      events
        .filter((e) => e.category === EventCategory.SystemLivenessFailed)
        .map((e) => e.data['findingId']),
    ).toEqual(['liveness:no-devices', finding.id])

    // Fixed: the storage family recovers; the device finding is NOT judged by it.
    reporter.report([], isStorageRootFindingId)
    const recovered = events
      .filter((e) => e.category === EventCategory.SystemLivenessRecovered)
      .map((e) => e.data['findingId'])
    expect(recovered).toEqual([finding.id])
  })
})
