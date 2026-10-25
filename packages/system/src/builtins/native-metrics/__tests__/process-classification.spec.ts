/**
 * Process classification — the shapes that used to be called ghosts.
 *
 * The rows below are the real ones, from the 2026-08-27 measurement across the
 * three live nodes: the container init on `hub` and on `agent-a`, and the
 * desktop app plus its three Electron helpers on `MacMiniAgent.localdomain`.
 * All six were classified `ghost` — the one class the (now deleted)
 * `killProcess` was willing to signal.
 *
 * What is pinned here:
 *  - none of them is `ghost` any more (the class does not exist);
 *  - all of them are `system` — the class for "camstack-shaped, but this node
 *    did not spawn it and cannot name it";
 *  - the only class carrying an addon attribution is `managed`, which is what
 *    the Processes page exists to show.
 */
import { describe, expect, it } from 'vitest'
import type { ThreadCpuSplit } from '../thread-cpu-sampler.js'
import {
  buildNodeProcesses,
  classifyProcess,
  type ManagedProcessEntry,
  type PsProcessRow,
} from '../process-classification.js'

function psRow(over: Partial<PsProcessRow>): PsProcessRow {
  return {
    pid: 100,
    ppid: 1,
    pgid: 100,
    cpuPercent: 1.5,
    memoryRssBytes: 4 * 1024 * 1024,
    uptimeSec: 3600,
    command: '/usr/local/bin/node /opt/camstack-hub/server/backend/dist/main.js',
    ...over,
  }
}

/** `hub` and `agent-a`: pid 1 is the container's init. ppid 0 is not in `ps`. */
const TINI_PID_1 = psRow({
  pid: 1,
  ppid: 0,
  pgid: 1,
  command: '/usr/bin/tini -- /usr/local/bin/docker-entrypoint.sh /opt/camstack-hub/starter.js',
})

/** `MacMiniAgent.localdomain`: the operator's own app, started by launchd. */
const DESKTOP_APP = psRow({
  pid: 71514,
  ppid: 1,
  pgid: 71514,
  command: '/Applications/camstack.app/Contents/MacOS/camstack',
})

const DESKTOP_HELPERS: readonly PsProcessRow[] = [71522, 71523, 71524].map((pid) =>
  psRow({
    pid,
    ppid: 71514,
    pgid: 71514,
    command:
      '/Applications/camstack.app/Contents/Frameworks/camstack Helper (Renderer).app/Contents/MacOS/camstack Helper (Renderer) --type=renderer',
  }),
)

const SELF_PID = 42
const HUB_ROOT = psRow({ pid: SELF_PID, ppid: 1, pgid: SELF_PID })
const RUNNER = psRow({
  pid: 8801,
  ppid: SELF_PID,
  command: '/usr/local/bin/node /opt/camstack-hub/addons/@camstack/addon-pipeline/dist/runner.js',
})

const MANAGED: ReadonlyMap<number, ManagedProcessEntry> = new Map([
  [8801, { addonId: 'pipeline', nodeId: 'hub' }],
])
const NO_SPLITS: ReadonlyMap<number, ThreadCpuSplit> = new Map()

describe('classifyProcess', () => {
  it('classifies the container init as system, never as an orphan', () => {
    expect(classifyProcess(TINI_PID_1.pid, SELF_PID, MANAGED)).toBe('system')
  })

  it('classifies the desktop app and its helpers as system', () => {
    for (const p of [DESKTOP_APP, ...DESKTOP_HELPERS]) {
      expect(classifyProcess(p.pid, SELF_PID, MANAGED)).toBe('system')
    }
  })

  it('classifies this node as root and a tracked runner as managed', () => {
    expect(classifyProcess(SELF_PID, SELF_PID, MANAGED)).toBe('root')
    expect(classifyProcess(8801, SELF_PID, MANAGED)).toBe('managed')
  })
})

describe('buildNodeProcesses', () => {
  const table = buildNodeProcesses({
    psRows: [TINI_PID_1, DESKTOP_APP, ...DESKTOP_HELPERS, HUB_ROOT, RUNNER],
    selfPid: SELF_PID,
    selfNodeId: 'hub',
    managed: MANAGED,
    cpuSplits: NO_SPLITS,
  })

  it('emits only the three classes — the six former ghosts are all system', () => {
    expect(new Set(table.map((p) => p.classification))).toEqual(
      new Set(['root', 'managed', 'system']),
    )
    const formerGhosts = [1, 71514, 71522, 71523, 71524]
    for (const pid of formerGhosts) {
      expect(table.find((p) => p.pid === pid)?.classification).toBe('system')
    }
  })

  it('attributes an addon only to the pid the kernel named', () => {
    expect(table.find((p) => p.pid === 8801)?.addonId).toBe('pipeline')
    for (const p of table) {
      if (p.pid !== 8801) expect(p.addonId).toBeNull()
    }
  })

  it('reports an unknown thread split as null, never as zero', () => {
    const runner = table.find((p) => p.pid === 8801)
    expect(runner?.cpuMainPercent).toBeNull()
    expect(runner?.cpuGcPercent).toBeNull()
    expect(runner?.threadCount).toBeNull()
  })

  it('drops rows that are not camstack-shaped', () => {
    const withStranger = buildNodeProcesses({
      psRows: [RUNNER, psRow({ pid: 999, command: '/usr/sbin/cupsd -l' })],
      selfPid: SELF_PID,
      selfNodeId: 'hub',
      managed: MANAGED,
      cpuSplits: NO_SPLITS,
    })
    expect(withStranger.map((p) => p.pid)).toEqual([8801])
  })
})
