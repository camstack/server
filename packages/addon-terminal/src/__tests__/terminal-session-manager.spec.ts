import type { IScopedLogger, LogExtras } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import type { PtyProcess, PtySpawner, PtySpawnOptions } from '../pty.js'
import { ptyEnvironment } from '../pty.js'
import { resolveServerShell, ServerShellRefusedError } from '../server-shell.js'
import {
  type ScreenBuffer,
  type TerminalOutputEvent,
  TerminalSessionManager,
  type TerminalSessionManagerOptions,
} from '../terminal-session-manager.js'

interface FakePty extends PtyProcess {
  emitData(data: string): void
  emitExit(exitCode: number, signal?: number): void
  readonly spawnOptions: PtySpawnOptions
  readonly writes: string[]
  readonly resizes: Array<{ cols: number; rows: number }>
  killed: boolean
}

function makeSpawner(): { spawn: PtySpawner; ptys: FakePty[] } {
  const ptys: FakePty[] = []
  const spawn: PtySpawner = (options) => {
    let dataCb: ((d: string) => void) | null = null
    let exitCb: ((e: { exitCode: number; signal?: number }) => void) | null = null
    const pty: FakePty = {
      pid: 1000 + ptys.length,
      spawnOptions: options,
      writes: [],
      resizes: [],
      killed: false,
      onData: (cb) => {
        dataCb = cb
      },
      onExit: (cb) => {
        exitCb = cb
      },
      write: (d) => pty.writes.push(d),
      resize: (cols, rows) => pty.resizes.push({ cols, rows }),
      kill: () => {
        pty.killed = true
      },
      emitData: (d) => dataCb?.(d),
      emitExit: (exitCode, signal) => exitCb?.({ exitCode, signal }),
    }
    ptys.push(pty)
    return pty
  }
  return { spawn, ptys }
}

function makeScreenFactory(): {
  screenFactory: (cols: number, rows: number) => ScreenBuffer
  snapshots: Map<ScreenBuffer, string>
} {
  const snapshots = new Map<ScreenBuffer, string>()
  const screenFactory = (): ScreenBuffer => {
    let buf = ''
    const screen: ScreenBuffer = {
      write: (d) => {
        buf += d
        snapshots.set(screen, buf)
      },
      flush: async () => {},
      resize: () => {},
      snapshot: () => buf,
      lines: () => buf.split('\n'),
      styledLines: () => buf.split('\n').map((text) => [{ text, fg: null, bg: null, bold: false }]),
      dispose: () => {},
    }
    snapshots.set(screen, buf)
    return screen
  }
  return { screenFactory, snapshots }
}

const silentLogger: IScopedLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silentLogger,
  withTags: () => silentLogger,
}

function makeManager(overrides?: Partial<TerminalSessionManagerOptions>) {
  const { spawn, ptys } = makeSpawner()
  const { screenFactory } = makeScreenFactory()
  let counter = 0
  const manager = new TerminalSessionManager({
    spawn,
    screenFactory,
    logger: silentLogger,
    btmPath: '',
    topEnabled: false,
    glancesEnabled: false,
    allowShell: false,
    shellPath: '',
    maxSessions: 2,
    mintId: () => `sess-${++counter}`,
    now: () => 1_700_000_000_000,
    ...overrides,
  })
  return { manager, ptys }
}

describe('TerminalSessionManager', () => {
  it('lists only the allowlisted monitor profile by default', async () => {
    const { manager } = makeManager()
    const profiles = await manager.listProfiles()
    expect(profiles.map((p) => p.profileId)).toEqual(['monitor', 'server-shell'])
  })

  it('does not treat profile templates as Terminal instances until hub control adopts one', async () => {
    const { manager } = makeManager()
    expect(await manager.listLegacyCameras()).toEqual([])
    await expect(
      manager.adoptLegacyMonitor({ stableId: 'terminal-camera-agent-1' }),
    ).rejects.toThrow(/managed on the hub/)

    const created = {
      instanceId: 'instance-a',
      cameraStableId: 'terminal-camera-instance-a',
      nodeInCluster: true,
      nodeId: 'hub',
      profileId: 'monitor',
      profileLabel: 'BTM',
      name: 'Hub monitor',
      enabled: true,
      executable: '',
      args: [],
      cwd: '',
      environment: [],
      profileSettings: {},
    }
    manager.setInstanceControl({
      listLegacyCameras: async () => [],
      adoptLegacyMonitor: async () => created,
    })

    await expect(
      manager.adoptLegacyMonitor({ stableId: 'terminal-camera-agent-1' }),
    ).resolves.toEqual(created)
  })

  it('adds a shell profile only when allowShell is set', async () => {
    const { manager } = makeManager({ allowShell: true })
    expect((await manager.listProfiles()).map((p) => p.profileId)).toEqual([
      'monitor',
      'shell',
      'server-shell',
    ])
  })

  it('exposes distinct BTM, Top and embedded-Python Glances profiles', async () => {
    const { manager, ptys } = makeManager({
      topEnabled: true,
      glancesEnabled: true,
      glancesPythonPath: '/camstack/python/bin/python3',
    })

    expect((await manager.listProfiles()).map((profile) => profile.profileId)).toEqual([
      'monitor',
      'top',
      'glances',
      'server-shell',
    ])
    await manager.openSession({ profileId: 'glances', cols: 80, rows: 24 })
    expect(ptys[0]!.spawnOptions).toMatchObject({
      file: '/camstack/python/bin/python3',
      args: ['-m', 'glances'],
    })
  })

  it('exports a Glances settings schema and none for BTM', async () => {
    const { manager } = makeManager({
      topEnabled: true,
      glancesEnabled: true,
      glancesPythonPath: '/camstack/python/bin/python3',
    })
    const profiles = await manager.listProfiles()
    const glances = profiles.find((profile) => profile.profileId === 'glances')
    const monitor = profiles.find((profile) => profile.profileId === 'monitor')
    expect(glances?.settingsSchema).toEqual(
      expect.objectContaining({
        sections: expect.arrayContaining([expect.objectContaining({ id: 'glances-panels' })]),
      }),
    )
    expect(monitor?.settingsSchema).toBeNull()
  })

  it('adds validated custom profiles with fixed arguments, cwd, and environment', async () => {
    const { manager, ptys } = makeManager({
      customProfiles: [
        {
          enabled: true,
          profileId: 'gpu-monitor',
          label: 'GPU Monitor',
          description: 'nvtop',
          executable: 'nvtop',
          args: ['--no-color'],
          cwd: '/tmp',
          environment: ['GPU=0', 'MODE=compact'],
        },
      ],
      env: { PATH: '/usr/bin' },
    })
    expect((await manager.listProfiles()).map((profile) => profile.profileId)).toEqual([
      'monitor',
      'server-shell',
      'gpu-monitor',
    ])
    await manager.openSession({ profileId: 'gpu-monitor', cols: 80, rows: 24 })
    expect(ptys[0]!.spawnOptions).toMatchObject({
      file: 'nvtop',
      args: ['--no-color'],
      cwd: '/tmp',
      env: { PATH: '/usr/bin', GPU: '0', MODE: 'compact' },
    })
  })

  it('logs and omits malformed custom profiles without bricking the addon', async () => {
    const warn = vi.fn()
    const { manager } = makeManager({
      logger: { ...silentLogger, warn },
      customProfiles: [
        {
          enabled: true,
          profileId: 'shell',
          label: 'Unsafe override',
          executable: '/tmp/shell',
        },
      ],
    })
    expect((await manager.listProfiles()).map((profile) => profile.profileId)).toEqual([
      'monitor',
      'server-shell',
    ])
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/reserved profile IDs/))
  })

  it('spawns the profile binary and returns session info', async () => {
    const { manager, ptys } = makeManager()
    const info = await manager.openSession({ profileId: 'monitor', cols: 120, rows: 40 })
    expect(info).toMatchObject({
      profileId: 'monitor',
      label: 'BTM',
      cols: 120,
      rows: 40,
    })
    expect(ptys).toHaveLength(1)
    expect(ptys[0]!.spawnOptions.file).toBe('btm')
    expect(ptys[0]!.spawnOptions.cols).toBe(120)
    expect(await manager.listSessions()).toHaveLength(1)
  })

  it('rejects an unknown profile (no free-form command)', async () => {
    const { manager, ptys } = makeManager()
    await expect(
      manager.openSession({ profileId: 'rm -rf /', cols: 80, rows: 24 }),
    ).rejects.toThrow(/Unknown terminal profile/)
    expect(ptys).toHaveLength(0)
  })

  it('enforces the concurrent session limit', async () => {
    const { manager } = makeManager({ maxSessions: 1 })
    await manager.openSession({ profileId: 'monitor', cols: 80, rows: 24 })
    await expect(manager.openSession({ profileId: 'monitor', cols: 80, rows: 24 })).rejects.toThrow(
      /session limit/,
    )
  })

  it('clamps absurd grid dimensions', async () => {
    const { manager, ptys } = makeManager()
    await manager.openSession({ profileId: 'monitor', cols: 999999, rows: -5 })
    expect(ptys[0]!.spawnOptions.cols).toBe(1000)
    expect(ptys[0]!.spawnOptions.rows).toBe(1)
  })

  it('sends a repaint snapshot then streams live output to an attached sink', async () => {
    const { manager, ptys } = makeManager()
    const info = await manager.openSession({ profileId: 'monitor', cols: 80, rows: 24 })
    ptys[0]!.emitData('EXISTING')

    const events: TerminalOutputEvent[] = []
    manager.attachOutput(info.sessionId, (e) => events.push(e))
    // First event is the current-screen repaint.
    expect(events[0]).toEqual({ kind: 'data', data: 'EXISTING' })

    ptys[0]!.emitData('LIVE')
    expect(events[1]).toEqual({ kind: 'data', data: 'LIVE' })
  })

  it('pulls ordered output by cursor and repairs a fresh client from the screen snapshot', async () => {
    const { manager, ptys } = makeManager()
    const info = await manager.openSession({ profileId: 'monitor', cols: 80, rows: 24 })
    ptys[0]!.emitData('FIRST')

    const initial = await manager.pullOutput({ sessionId: info.sessionId, afterSeq: 0 })
    expect(initial).toMatchObject({ cursor: 1, reset: true, snapshot: 'FIRST', events: [] })

    ptys[0]!.emitData('SECOND')
    await expect(
      manager.pullOutput({ sessionId: info.sessionId, afterSeq: initial.cursor }),
    ).resolves.toEqual({
      cursor: 2,
      reset: false,
      events: [{ seq: 2, kind: 'data', data: 'SECOND' }],
    })
  })

  it('long-polls at the live cursor and wakes as soon as output arrives', async () => {
    const { manager, ptys } = makeManager()
    const info = await manager.openSession({ profileId: 'monitor', cols: 80, rows: 24 })
    ptys[0]!.emitData('FIRST')
    const initial = await manager.pullOutput({ sessionId: info.sessionId, afterSeq: 0 })

    const pending = manager.pullOutput({
      sessionId: info.sessionId,
      afterSeq: initial.cursor,
      waitMs: 1_000,
    })

    await Promise.resolve()
    ptys[0]!.emitData('SECOND')

    await expect(pending).resolves.toEqual({
      cursor: 2,
      reset: false,
      events: [{ seq: 2, kind: 'data', data: 'SECOND' }],
    })
  })

  it('waits for first output only when a startup caller explicitly opts in', async () => {
    const { manager, ptys } = makeManager()
    const info = await manager.openSession({ profileId: 'monitor', cols: 80, rows: 24 })
    const pending = manager.pullOutput({
      sessionId: info.sessionId,
      afterSeq: 0,
      waitMs: 1_000,
      waitForOutput: true,
    })

    await Promise.resolve()
    ptys[0]!.emitData('READY')

    await expect(pending).resolves.toMatchObject({
      cursor: 1,
      reset: true,
      snapshot: 'READY',
    })
  })

  it('routes capability input to the pty', async () => {
    const { manager, ptys } = makeManager()
    const info = await manager.openSession({ profileId: 'monitor', cols: 80, rows: 24 })
    await manager.writeInput({ sessionId: info.sessionId, data: 'q' })
    expect(ptys[0]!.writes).toEqual(['q'])
  })

  it('stops delivering to a detached sink', async () => {
    const { manager, ptys } = makeManager()
    const info = await manager.openSession({ profileId: 'monitor', cols: 80, rows: 24 })
    const events: TerminalOutputEvent[] = []
    const detach = manager.attachOutput(info.sessionId, (e) => events.push(e))
    detach()
    ptys[0]!.emitData('AFTER-DETACH')
    expect(events.some((e) => e.kind === 'data' && e.data === 'AFTER-DETACH')).toBe(false)
  })

  it('routes keystrokes to the pty', async () => {
    const { manager, ptys } = makeManager()
    const info = await manager.openSession({ profileId: 'monitor', cols: 80, rows: 24 })
    manager.writeInputToSession(info.sessionId, 'q')
    expect(ptys[0]!.writes).toEqual(['q'])
  })

  it('resizes both the pty and the screen and updates session info', async () => {
    const { manager, ptys } = makeManager()
    const info = await manager.openSession({ profileId: 'monitor', cols: 80, rows: 24 })
    await manager.resize({ sessionId: info.sessionId, cols: 100, rows: 30 })
    expect(ptys[0]!.resizes).toEqual([{ cols: 100, rows: 30 }])
    expect((await manager.listSessions())[0]).toMatchObject({ cols: 100, rows: 30 })
  })

  it('emits an exit event and drops the session when the pty exits', async () => {
    const { manager, ptys } = makeManager()
    const info = await manager.openSession({ profileId: 'monitor', cols: 80, rows: 24 })
    const events: TerminalOutputEvent[] = []
    manager.attachOutput(info.sessionId, (e) => events.push(e))
    ptys[0]!.emitExit(0)
    expect(events.some((e) => e.kind === 'exit')).toBe(true)
    expect(manager.hasSession(info.sessionId)).toBe(false)
    expect(await manager.listSessions()).toHaveLength(0)
  })

  it('keeps an exited session addressable so a late /out still delivers the exit event', async () => {
    const { manager, ptys } = makeManager()
    const info = await manager.openSession({ profileId: 'monitor', cols: 80, rows: 24 })
    ptys[0]!.emitExit(3, 15)
    // Live-only views exclude it, but the entry lingers for a racing attach.
    expect(manager.hasSession(info.sessionId)).toBe(false)
    expect(manager.hasEntry(info.sessionId)).toBe(true)
    const events: TerminalOutputEvent[] = []
    manager.attachOutput(info.sessionId, (e) => events.push(e))
    expect(events).toEqual([{ kind: 'exit', exitCode: 3, signal: 15 }])
    await expect(
      manager.pullOutput({ sessionId: info.sessionId, afterSeq: 0 }),
    ).resolves.toMatchObject({
      reset: true,
      events: [{ seq: 1, kind: 'exit', exitCode: 3, signal: 15 }],
    })
  })

  it('drops the exited entry after the retention window elapses', async () => {
    vi.useFakeTimers()
    try {
      const { manager, ptys } = makeManager()
      const info = await manager.openSession({ profileId: 'monitor', cols: 80, rows: 24 })
      ptys[0]!.emitExit(0)
      expect(manager.hasEntry(info.sessionId)).toBe(true)
      vi.advanceTimersByTime(11_000)
      expect(manager.hasEntry(info.sessionId)).toBe(false)
      expect(() => manager.attachOutput(info.sessionId, () => {})).toThrow(
        /No such terminal session/,
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it('throws a clear error and spawns nothing when the profile binary is not on PATH', async () => {
    const { manager, ptys } = makeManager({ resolveBinary: () => null })
    await expect(manager.openSession({ profileId: 'monitor', cols: 80, rows: 24 })).rejects.toThrow(
      /executable 'btm' was not found on PATH/,
    )
    expect(ptys).toHaveLength(0)
  })

  it('spawns the resolved absolute path, not the bare profile name', async () => {
    const { manager, ptys } = makeManager({ resolveBinary: () => '/usr/local/bin/btm' })
    await manager.openSession({ profileId: 'monitor', cols: 80, rows: 24 })
    expect(ptys[0]!.spawnOptions.file).toBe('/usr/local/bin/btm')
  })

  it('a throwing sink does not break sibling sinks', async () => {
    const { manager, ptys } = makeManager()
    const info = await manager.openSession({ profileId: 'monitor', cols: 80, rows: 24 })
    const good: TerminalOutputEvent[] = []
    manager.attachOutput(info.sessionId, () => {
      throw new Error('broken sink')
    })
    manager.attachOutput(info.sessionId, (e) => good.push(e))
    ptys[0]!.emitData('X')
    expect(good.some((e) => e.kind === 'data' && e.data === 'X')).toBe(true)
  })

  it('kills every pty on disposeAll', async () => {
    const { manager, ptys } = makeManager()
    await manager.openSession({ profileId: 'monitor', cols: 80, rows: 24 })
    manager.disposeAll()
    expect(ptys[0]!.killed).toBe(true)
    expect(await manager.listSessions()).toHaveLength(0)
  })

  it('close kills the pty', async () => {
    const { manager, ptys } = makeManager()
    const info = await manager.openSession({ profileId: 'monitor', cols: 80, rows: 24 })
    await manager.close({ sessionId: info.sessionId })
    expect(ptys[0]!.killed).toBe(true)
  })

  it('explicit close removes the session immediately and terminates an in-flight output poll', async () => {
    const { manager, ptys } = makeManager()
    const info = await manager.openSession({ profileId: 'monitor', cols: 80, rows: 24 })
    ptys[0]!.emitData('READY')
    const initial = await manager.pullOutput({ sessionId: info.sessionId, afterSeq: 0 })
    const pending = manager.pullOutput({
      sessionId: info.sessionId,
      afterSeq: initial.cursor,
      waitMs: 1_000,
    })

    await manager.close({ sessionId: info.sessionId })

    expect(await manager.listSessions()).toEqual([])
    expect(manager.hasEntry(info.sessionId)).toBe(false)
    await expect(pending).resolves.toEqual({
      cursor: 2,
      reset: false,
      events: [{ seq: 2, kind: 'exit', exitCode: 0 }],
    })
    // kill() intentionally does not emit onExit in this fake. The manager must
    // still be terminal rather than waiting forever for that callback.
    expect(ptys).toHaveLength(1)
  })
})

const shellCaller = { userId: 'admin-7', isAdmin: true } as const

function auditLogger(): {
  logger: IScopedLogger
  lines: { message: string; extras?: LogExtras }[]
} {
  const lines: { message: string; extras?: LogExtras }[] = []
  const logger: IScopedLogger = {
    ...silentLogger,
    info: (message, extras) => {
      lines.push({ message, ...(extras !== undefined ? { extras } : {}) })
    },
  }
  return { logger, lines }
}

const SHELL_ENV = {
  PATH: '/usr/bin',
  HOME: '/data',
  LANG: 'C',
  TERM: 'xterm-256color',
  USER: 'camstack',
  SECRET_TOKEN: 'must-not-leak',
  AWS_SECRET_ACCESS_KEY: 'must-not-leak',
} as const

function shellManager(
  overrides?: Partial<TerminalSessionManagerOptions> & { readonly now?: () => number },
) {
  return makeManager({
    nodeId: 'hub',
    serverShellEnabled: true,
    serverShellIdleMs: 30 * 60_000,
    serverShell: resolveServerShell({
      platform: 'linux',
      inContainer: true,
      shellFromEnv: '/bin/zsh',
      dataDir: '/data',
      processEnv: SHELL_ENV,
    }),
    env: { SECRET_TOKEN: 'from-manager', PATH: '/wrong' },
    ...overrides,
  })
}

describe('server shell', () => {
  it('refuses to open when the node has not opted in, naming the node', async () => {
    const { manager, ptys } = shellManager({ serverShellEnabled: false })
    const status = await manager.serverShellStatus()
    expect(status).toEqual({
      nodeId: 'hub',
      enabled: false,
      idleMinutes: 30,
      refusal: {
        code: 'server-shell-disabled',
        nodeId: 'hub',
        message: expect.stringContaining('hub'),
      },
    })
    await expect(
      manager.openSession({
        profileId: 'server-shell',
        cols: 80,
        rows: 24,
        caller: shellCaller,
        executable: '/bin/sh',
        environment: ['SECRET_TOKEN=from-caller'],
      }),
    ).rejects.toBeInstanceOf(ServerShellRefusedError)
    await expect(
      manager.openSession({ profileId: 'server-shell', cols: 80, rows: 24, caller: shellCaller }),
    ).rejects.toMatchObject({ code: 'server-shell-disabled', nodeId: 'hub' })
    expect(ptys).toHaveLength(0)
  })

  it('spawns the login shell in the data dir with only the allowlisted environment', async () => {
    const { manager, ptys } = shellManager()
    await manager.openSession({
      profileId: 'server-shell',
      cols: 80,
      rows: 24,
      caller: shellCaller,
      executable: '/bin/evil',
      args: ['-c', 'steal'],
      cwd: '/tmp',
      environment: ['SECRET_TOKEN=from-caller', 'PATH=/attacker'],
    })
    expect(ptys[0]!.spawnOptions).toMatchObject({
      file: '/bin/bash',
      args: ['-l'],
      cwd: '/data',
      envMode: 'replace',
    })
    expect(ptys[0]!.spawnOptions.env).toEqual({
      PATH: '/usr/bin',
      HOME: '/data',
      LANG: 'C',
      TERM: 'xterm-256color',
      USER: 'camstack',
    })
    expect(
      ptyEnvironment({ ...SHELL_ENV }, ptys[0]!.spawnOptions.env, 'replace'),
    ).not.toHaveProperty('SECRET_TOKEN')
    expect(
      ptyEnvironment({ ...SHELL_ENV }, ptys[0]!.spawnOptions.env, 'replace'),
    ).not.toHaveProperty('AWS_SECRET_ACCESS_KEY')
  })

  it('writes an audit line with the node, user and session on open, attach and close', async () => {
    const { logger, lines } = auditLogger()
    const { manager } = shellManager({ logger })
    const info = await manager.openSession({
      profileId: 'server-shell',
      cols: 80,
      rows: 24,
      caller: shellCaller,
    })
    await manager.pullOutput({ sessionId: info.sessionId, afterSeq: 0, caller: shellCaller })
    await manager.close({ sessionId: info.sessionId, caller: shellCaller })
    const tags = { nodeId: 'hub', sessionId: info.sessionId, userId: 'admin-7' }
    expect(lines.map((line) => line.message)).toEqual(
      expect.arrayContaining([
        'terminal: server shell opened',
        'terminal: server shell attached',
        'terminal: server shell closed',
      ]),
    )
    for (const message of [
      'terminal: server shell opened',
      'terminal: server shell attached',
      'terminal: server shell closed',
    ]) {
      expect(lines.find((line) => line.message === message)?.extras?.tags).toEqual(tags)
    }
  })

  it('closes a server shell that has had no input and no output for the idle window', async () => {
    let now = 1_700_000_000_000
    const { logger, lines } = auditLogger()
    const { manager, ptys } = shellManager({
      logger,
      now: () => now,
      serverShellIdleMs: 1_000,
    })
    const info = await manager.openSession({
      profileId: 'server-shell',
      cols: 80,
      rows: 24,
      caller: shellCaller,
    })
    now += 999
    manager.sweepIdle()
    expect(ptys[0]!.killed).toBe(false)
    ptys[0]!.emitData('prompt')
    now += 999
    manager.sweepIdle()
    expect(ptys[0]!.killed).toBe(false)
    manager.writeInputToSession(info.sessionId, 'ls\n')
    now += 1_000
    manager.sweepIdle()
    expect(ptys[0]!.killed).toBe(true)
    expect(await manager.listSessions()).toEqual([])
    expect(
      lines.find((line) => line.message === 'terminal: server shell idle-killed')?.extras?.tags,
    ).toEqual({
      nodeId: 'hub',
      sessionId: info.sessionId,
      userId: 'idle',
    })
  })
})
