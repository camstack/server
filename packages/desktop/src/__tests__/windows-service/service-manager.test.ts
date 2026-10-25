import { describe, expect, it, vi } from 'vitest'
import {
  isUnderProtectedRoot,
  parseScState,
  WindowsServiceManager,
  type ExecResult,
  type ServiceManagerDeps,
} from '../../windows-service/service-manager'
import type { AgentServiceSpec } from '../../windows-service/winsw-config'

const spec: AgentServiceSpec = {
  nodeExe: 'C:\\Program Files\\CamStack\\resources\\node\\node.exe',
  supervisorJs: 'C:\\App\\resources\\service\\service-supervisor.js',
  starterJs: 'C:\\App\\resources\\node_modules\\@camstack\\server\\dist\\starter.js',
  workingDir: 'C:\\App\\resources',
  env: { CAMSTACK_ROLE: 'agent' },
  logDir: '',
}

function manager(overrides: Partial<ServiceManagerDeps> = {}) {
  const exec = vi.fn(async (): Promise<ExecResult> => ({ code: 0, stdout: '' }))
  const deps: ServiceManagerDeps = {
    platform: 'win32',
    programData: 'C:\\ProgramData',
    systemRoot: 'C:\\Windows',
    exec,
    fileExists: () => true,
    protectedRoots: ['C:\\Program Files', 'C:\\Program Files (x86)'],
    readFile: () => null,
    ...overrides,
  }
  return { mgr: new WindowsServiceManager(deps), exec }
}

describe('parseScState', () => {
  it('reads the SCM state out of sc.exe query', () => {
    expect(
      parseScState('SERVICE_NAME: CamStackAgent\n        STATE              : 4  RUNNING'),
    ).toBe('running')
    expect(parseScState('        STATE              : 1  STOPPED')).toBe('stopped')
    expect(parseScState('        STATE              : 2  START_PENDING')).toBe('transitioning')
    expect(parseScState('')).toBe('not-installed')
  })
})

describe('WindowsServiceManager', () => {
  it('is unsupported off Windows and never executes anything', async () => {
    const { mgr, exec } = manager({ platform: 'darwin' })
    expect(mgr.supported).toBe(false)
    expect(await mgr.state()).toBe('unsupported')
    expect(await mgr.install({ winswSource: 'w.exe', spec, agentConfigSource: null })).toEqual({
      ok: false,
      reason: 'The Windows service is only available on Windows.',
    })
    expect((await mgr.remove()).ok).toBe(false)
    expect(exec).not.toHaveBeenCalled()
  })

  it('maps "service does not exist" (1060) to not-installed', async () => {
    const { mgr } = manager({ exec: async () => ({ code: 1060, stdout: '' }) })
    expect(await mgr.state()).toBe('not-installed')
  })

  it('refuses to install a build that shipped without the wrapper', async () => {
    const { mgr, exec } = manager({ fileExists: (p) => !p.endsWith('winsw.exe') })
    const res = await mgr.install({
      winswSource: 'C:\\Program Files\\CamStack\\resources\\service\\winsw.exe',
      spec,
      agentConfigSource: null,
    })
    expect(res.ok).toBe(false)
    expect(res.ok === false && res.reason).toMatch(/wrapper is missing/)
    expect(exec).not.toHaveBeenCalled()
  })

  it('refuses to install without the bundled Node — the service cannot run on Electron', async () => {
    const { mgr } = manager({ fileExists: (p) => !p.endsWith('node.exe') })
    const res = await mgr.install({ winswSource: 'w.exe', spec, agentConfigSource: null })
    expect(res.ok === false && res.reason).toMatch(/bundled Node is missing/)
  })

  it('installs through ONE elevated PowerShell', async () => {
    const { mgr, exec } = manager()
    expect(await mgr.install({ winswSource: 'w.exe', spec, agentConfigSource: null })).toEqual({
      ok: true,
    })
    expect(exec).toHaveBeenCalledTimes(1)
    const call = exec.mock.calls[0] as unknown as [string, string[]]
    expect(call[1].join(' ')).toContain('-Verb RunAs')
  })

  it("explains a failed install from the elevated script's own log", async () => {
    const { mgr } = manager({
      exec: async () => ({ code: 1, stdout: '' }),
      readFile: () => 'failed: install (exit 1052)\n',
    })
    const res = await mgr.install({ winswSource: 'w.exe', spec, agentConfigSource: null })
    expect(res).toEqual({ ok: false, reason: 'failed: install (exit 1052)' })
  })

  it('says UAC was declined when there is nothing in the log', async () => {
    const { mgr } = manager({ exec: async () => ({ code: 1, stdout: '' }), readFile: () => 'ok' })
    const res = await mgr.install({ winswSource: 'w.exe', spec, agentConfigSource: null })
    expect(res.ok === false && res.reason).toMatch(/declined/)
  })

  it('REFUSES to run SYSTEM code from a folder the user can write (a per-user install)', async () => {
    const { mgr, exec } = manager()
    const perUser = {
      ...spec,
      nodeExe: 'C:\\Users\\alice\\AppData\\Local\\Programs\\CamStack\\resources\\node\\node.exe',
    }
    const res = await mgr.install({ winswSource: 'w.exe', spec: perUser, agentConfigSource: null })
    expect(res.ok === false && res.reason).toMatch(/for all users/)
    expect(exec).not.toHaveBeenCalled()
  })

  it('gives the service its own data dir under ProgramData, not the user profile', () => {
    expect(manager().mgr.dataDir).toBe('C:\\ProgramData\\CamStack\\agent-data')
  })
})

describe('isUnderProtectedRoot', () => {
  const roots = ['C:\\Program Files', 'C:\\Program Files (x86)']

  it('is inside, whatever the case or the slash direction', () => {
    expect(isUnderProtectedRoot('c:/program files/camstack/resources/node/node.exe', roots)).toBe(
      true,
    )
    expect(isUnderProtectedRoot('C:\\PROGRAM FILES (X86)\\CamStack\\node.exe', roots)).toBe(true)
  })

  it('is not a sibling that merely shares the prefix, nor a user folder', () => {
    expect(isUnderProtectedRoot('C:\\Program Files Evil\\node.exe', roots)).toBe(false)
    expect(isUnderProtectedRoot('C:\\Users\\a\\AppData\\Local\\Programs\\node.exe', roots)).toBe(
      false,
    )
    expect(isUnderProtectedRoot('C:\\Program Files\\x\\node.exe', [])).toBe(false)
  })
})
