/**
 * D696, the controller's ruling on the release order: one camera `motion`
 * slice never has two writers. The orchestrator writes it only while EVERY
 * known runner node has ANSWERED that it no longer writes it
 * (`getLocalLoad().motionSliceWriter === 'orchestrator'`). A runner that
 * answers without the field is older than D696 and still writes. A node that
 * never answered is unknown, so it keeps the gate closed. A node whose read
 * failed keeps its last answer (D49).
 */
import type { IScopedLogger, RunnerLocalLoad } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  type DirectoryEntry,
  GATE_STALE_REFRESH_MS,
  isRunnerProcess,
  MotionSliceWriterGate,
  type RunnerLoadAnswer,
} from '../camera-sensors/motion-slice-gate.js'

interface Line {
  readonly level: string
  readonly message: string
  readonly meta: Readonly<Record<string, unknown>> | undefined
}

function load(nodeId: string, advertises: boolean): RunnerLocalLoad {
  return {
    nodeId,
    attachedCameras: 0,
    activeCameras: 0,
    avgInferenceFps: 0,
    avgInferenceTimeMs: 0,
    queueDepthTotal: 0,
    devices: [],
    hardware: { hasGpu: false },
    ...(advertises ? { motionSliceWriter: 'orchestrator' as const } : {}),
  }
}

const answered = (nodeId: string, advertises: boolean): RunnerLoadAnswer => ({
  nodeId,
  load: load(nodeId, advertises),
})
const unanswered = (nodeId: string): RunnerLoadAnswer => ({ nodeId, load: null })

function gate(
  nodes: string[],
  directory: () => Promise<readonly DirectoryEntry[]> = async () => [],
) {
  const lines: Line[] = []
  const record =
    (level: string) =>
    (message: string, extras?: { meta?: Readonly<Record<string, unknown>> }): void => {
      lines.push({ level, message, meta: extras?.meta })
    }
  const logger: IScopedLogger = {
    debug: record('debug'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
    child: () => logger,
    withTags: () => logger,
  }
  const changes: boolean[] = []
  let now = 0
  let censuses = 0
  let release: (() => void) | null = null
  const g = new MotionSliceWriterGate({
    logger,
    runnerNodeIds: () => nodes,
    census: () => {
      censuses += 1
      return new Promise<void>((resolve) => {
        release = resolve
      })
    },
    readDirectory: directory,
    now: () => now,
    onChange: (open) => changes.push(open),
  })
  return {
    g,
    lines,
    changes,
    advance: (ms: number) => {
      now += ms
    },
    censuses: () => censuses,
    finishCensus: async () => {
      release?.()
      release = null
      for (let i = 0; i < 20; i += 1) await Promise.resolve()
    },
  }
}

describe('MotionSliceWriterGate (D696)', () => {
  it('is closed until every known runner node ANSWERED with the field', () => {
    const h = gate(['hub', 'agent-1'])
    expect(h.g.isOpen()).toBe(false)
    h.g.noteCensus([answered('hub', true)])
    expect(h.g.isOpen()).toBe(false)
    h.g.noteCensus([answered('agent-1', true)])
    expect(h.g.isOpen()).toBe(true)
    expect(h.changes).toEqual([true])
  })

  it('an OLD runner (the field absent) keeps it closed: the old runner stays the one writer', () => {
    const h = gate(['hub', 'agent-1'])
    h.g.noteCensus([answered('hub', true), answered('agent-1', false)])
    expect(h.g.isOpen()).toBe(false)
    const warn = h.lines.find((l) => l.message.includes('writer gate closed'))
    expect(warn?.level).toBe('warn')
    expect(warn?.meta?.['blocking']).toEqual([{ nodeId: 'agent-1', reason: 'old-runner' }])
  })

  it('a runner ROLLBACK (the field disappears) closes it again', () => {
    const h = gate(['hub'])
    h.g.noteCensus([answered('hub', true)])
    h.g.noteCensus([answered('hub', false)])
    expect(h.g.isOpen()).toBe(false)
    expect(h.changes).toEqual([true, false])
  })

  it('a failed read keeps that node’s last answer, open or closed (D49)', () => {
    const h = gate(['hub'])
    h.g.noteCensus([answered('hub', true)])
    h.g.noteCensus([unanswered('hub')])
    expect(h.g.isOpen()).toBe(true)
    const c = gate(['hub'])
    c.g.noteCensus([unanswered('hub')])
    expect(c.g.isOpen()).toBe(false)
    expect(
      c.lines.find((l) => l.message.includes('writer gate closed'))?.meta?.['blocking'],
    ).toEqual([{ nodeId: 'hub', reason: 'unanswered' }])
  })

  it('a node that leaves the set no longer holds it closed; one that joins unanswered closes it', () => {
    const nodes = ['hub', 'agent-1']
    const h = gate(nodes)
    h.g.noteCensus([answered('hub', true)])
    expect(h.g.isOpen()).toBe(false)
    nodes.splice(1, 1)
    h.g.reevaluate()
    expect(h.g.isOpen()).toBe(true)
    nodes.push('agent-2')
    h.g.reevaluate()
    expect(h.g.isOpen()).toBe(false)
    expect(h.changes).toEqual([true, false])
  })

  it('says each change once, with the blocking nodes', () => {
    const h = gate(['hub', 'agent-1'])
    h.g.noteCensus([answered('hub', true), unanswered('agent-1')])
    h.g.noteCensus([answered('hub', true), unanswered('agent-1')])
    const closed = h.lines.filter((l) => l.message.includes('writer gate closed'))
    expect(closed).toHaveLength(1)
    // Not answered YET is the boot state, said at info; only an old runner is a WARN.
    expect(closed[0]?.level).toBe('info')
    expect(closed[0]?.meta?.['blocking']).toEqual([{ nodeId: 'agent-1', reason: 'unanswered' }])
    h.g.noteCensus([answered('agent-1', true)])
    expect(h.lines.filter((l) => l.message.includes('writer gate open'))).toHaveLength(1)
  })

  it('refresh() coalesces: one census in flight, one more after it, never a pile', async () => {
    const h = gate(['hub'])
    void h.g.refresh('boot')
    void h.g.refresh('agent-online')
    void h.g.refresh('agent-online')
    expect(h.censuses()).toBe(1)
    await h.finishCensus()
    expect(h.censuses()).toBe(2)
    await h.finishCensus()
    expect(h.censuses()).toBe(2)
  })

  it('refreshIfStale() asks for a census at most once per window', async () => {
    const h = gate(['hub'])
    h.g.refreshIfStale()
    await h.finishCensus()
    h.g.refreshIfStale()
    expect(h.censuses()).toBe(1)
    h.advance(GATE_STALE_REFRESH_MS)
    h.g.refreshIfStale()
    expect(h.censuses()).toBe(2)
  })

  it('a process that (re)connects or leaves forgets its node`s answer: closed until it answers again', () => {
    const h = gate(['hub', 'agent-1'])
    h.g.noteCensus([answered('hub', true), answered('agent-1', true)])
    expect(h.g.isOpen()).toBe(true)
    // A rolled-back runner respawns as a child process of the hub: closed BEFORE it can attach and write.
    h.g.forgetNode('hub/pipeline')
    expect(h.g.isOpen()).toBe(false)
    h.g.noteCensus([answered('hub', false)])
    expect(h.g.isOpen()).toBe(false)
    h.g.noteCensus([answered('hub', true)])
    expect(h.g.isOpen()).toBe(true)
    // A top-level node by its own id.
    h.g.forgetNode('agent-1')
    expect(h.g.isOpen()).toBe(false)
    expect(h.changes).toEqual([true, false, true, false])
  })

  describe('a node the registry POSITIVELY reports offline never blocks it (review F2, D58)', () => {
    const offline = (id: string): DirectoryEntry => ({ id, isOnline: false })
    const online = (id: string): DirectoryEntry => ({ id, isOnline: true })

    it('an enabled agent offline since boot does not block; reconnecting, it blocks until it answers', () => {
      const h = gate(['hub', 'agent-1'])
      h.g.noteCensus([answered('hub', true), unanswered('agent-1')])
      expect(h.g.isOpen()).toBe(false)
      h.g.noteDirectory([online('hub'), offline('agent-1')])
      expect(h.g.isOpen()).toBe(true)
      // AgentOnline: it counts again, unanswered, until a census reads it.
      h.g.forgetNode('agent-1')
      expect(h.g.isOpen()).toBe(false)
      h.g.noteCensus([answered('agent-1', true)])
      expect(h.g.isOpen()).toBe(true)
    })

    it('an AgentOffline is the registry`s positive statement too', () => {
      const h = gate(['hub', 'agent-1'])
      h.g.noteCensus([answered('hub', true)])
      h.g.noteOffline('agent-1')
      expect(h.g.isOpen()).toBe(true)
    })

    it('a FAILED census read never excludes a node, and a node the directory does not list is not offline', () => {
      const h = gate(['hub', 'agent-1'])
      h.g.noteCensus([answered('hub', true), unanswered('agent-1')])
      h.g.noteDirectory([online('hub')])
      expect(h.g.isOpen()).toBe(false)
    })

    it('a failed directory read changes nothing (D49)', async () => {
      let fail = false
      const h = gate(['hub', 'agent-1'], async () => {
        if (fail) throw new Error('registry down')
        return [online('hub'), offline('agent-1')]
      })
      h.g.noteCensus([answered('hub', true)])
      void h.g.refresh('boot')
      await h.finishCensus()
      expect(h.g.isOpen()).toBe(true)
      fail = true
      void h.g.refresh('agent-online')
      await h.finishCensus()
      expect(h.g.isOpen()).toBe(true)
    })

    it('a node still unanswered after a whole census is a WARN naming it, sampled', () => {
      const h = gate(['hub', 'agent-1'])
      const census = (): void => h.g.noteCensus([answered('hub', true), unanswered('agent-1')])
      census()
      const blockedWarns = (): readonly Line[] =>
        h.lines.filter((l) => l.level === 'warn' && l.message.includes('has not answered'))
      expect(blockedWarns()).toHaveLength(0)
      census()
      expect(blockedWarns()).toHaveLength(1)
      expect(blockedWarns()[0]?.meta).toMatchObject({ nodeId: 'agent-1', censuses: 2 })
      for (let i = 0; i < 5; i += 1) census()
      expect(blockedWarns()).toHaveLength(1)
    })
  })

  describe('the offline exclusion is never sticky (re-review R1)', () => {
    it('a node that ANSWERS is online: an old runner answering closes the gate even if the directory said offline', () => {
      const h = gate(['hub', 'agent'])
      h.g.noteCensus([answered('hub', true)])
      h.g.noteDirectory([
        { id: 'hub', isOnline: true },
        { id: 'agent', isOnline: false },
      ])
      expect(h.g.isOpen()).toBe(true)
      // Its AgentOnline was lost (events may be dropped, D8), but it answers a census: it writes.
      h.g.noteCensus([answered('agent', false)])
      expect(h.g.isOpen()).toBe(false)
    })

    it('a directory read in flight when the node reconnects cannot re-exclude it', async () => {
      let land: (entries: readonly DirectoryEntry[]) => void = () => undefined
      const h = gate(
        ['hub', 'agent'],
        () =>
          new Promise<readonly DirectoryEntry[]>((resolve) => {
            land = resolve
          }),
      )
      h.g.noteCensus([answered('hub', true)])
      void h.g.refresh('boot')
      // The node reconnects while the read is in flight: it counts again, unanswered.
      h.g.forgetNode('agent')
      expect(h.g.isOpen()).toBe(false)
      // The stale snapshot lands: it still lists the node offline.
      land([
        { id: 'hub', isOnline: true },
        { id: 'agent', isOnline: false },
      ])
      await h.finishCensus()
      expect(h.g.isOpen()).toBe(false)
    })
  })
})

describe('isRunnerProcess (R2-L3)', () => {
  it('accepts only <node>/detection; a bare node id is AgentOnline`s concern, not Worker`s', () => {
    expect(isRunnerProcess('hub/detection')).toBe(true)
    expect(isRunnerProcess('agent-a/detection')).toBe(true)
    expect(isRunnerProcess('hub/decoder-nodeav')).toBe(false)
    expect(isRunnerProcess('hub/provider-hikvision')).toBe(false)
    expect(isRunnerProcess('hub')).toBe(false)
    expect(isRunnerProcess('agent-a')).toBe(false)
  })
})
