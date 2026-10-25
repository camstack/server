/**
 * Install / remove / ask about the agent's Windows service.
 *
 * Every OS touch is a dependency (`exec`, `readFile`, the platform), so the
 * decisions — refuse off Windows, refuse without the packaged WinSW, explain a
 * failure from the elevated script's log — are testable anywhere. What cannot
 * be tested off Windows is WinSW itself and the SCM; see
 * `docs/architecture/windows-agent.md` for what is verified and what is not.
 */
import {
  buildInstallScript,
  buildRemoveScript,
  elevatedInvocation,
  serviceLayout,
  type ServiceLayout,
} from './service-script'
import { SERVICE_ID, type AgentServiceSpec } from './winsw-config'

export interface ExecResult {
  /** Exit code; null when the program could not be started at all. */
  readonly code: number | null
  readonly stdout: string
}

export interface ServiceManagerDeps {
  readonly platform: NodeJS.Platform
  readonly programData: string | undefined
  readonly systemRoot: string | undefined
  readonly exec: (file: string, args: readonly string[]) => Promise<ExecResult>
  readonly fileExists: (path: string) => boolean
  /**
   * Directories only an administrator can write (`%ProgramFiles%` and kin). The
   * service runs the bundled Node as SYSTEM, so it may only run from one.
   */
  readonly protectedRoots: readonly string[]
  readonly readFile: (path: string) => string | null
}

export type ServiceState = 'not-installed' | 'running' | 'stopped' | 'transitioning' | 'unsupported'

export type ServiceActionResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string }

/** `STATE : 4  RUNNING` out of `sc.exe query`. */
export function parseScState(output: string): ServiceState {
  const match = /STATE\s*:\s*(\d+)/i.exec(output)
  if (!match) return 'not-installed'
  switch (match[1]) {
    case '4':
      return 'running'
    case '1':
      return 'stopped'
    default:
      return 'transitioning'
  }
}

/** Case- and separator-insensitive "is `target` inside one of `roots`". */
export function isUnderProtectedRoot(target: string, roots: readonly string[]): boolean {
  const norm = (p: string): string => p.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
  const t = norm(target)
  return roots.some((root) => root.length > 0 && t.startsWith(`${norm(root)}\\`))
}

export class WindowsServiceManager {
  constructor(private readonly deps: ServiceManagerDeps) {}

  private get layout(): ServiceLayout | null {
    return this.deps.programData === undefined ? null : serviceLayout(this.deps.programData)
  }

  /** Whether this host can have the service at all. */
  get supported(): boolean {
    return this.deps.platform === 'win32' && this.layout !== null
  }

  async state(): Promise<ServiceState> {
    if (!this.supported) return 'unsupported'
    const result = await this.deps.exec(
      `${this.deps.systemRoot ?? 'C:\\Windows'}\\System32\\sc.exe`,
      ['query', SERVICE_ID],
    )
    // 1060 = "the specified service does not exist as an installed service".
    if (result.code === 1060) return 'not-installed'
    return parseScState(result.stdout)
  }

  /** The service's own data dir (admin-only), or null off Windows. */
  get dataDir(): string | null {
    return this.layout?.dataDir ?? null
  }

  async install(input: {
    readonly winswSource: string
    readonly spec: AgentServiceSpec
    /** The user's `agent.json` to seed the service's data dir with, if any. */
    readonly agentConfigSource: string | null
  }): Promise<ServiceActionResult> {
    const layout = this.layout
    if (!this.supported || layout === null) {
      return { ok: false, reason: 'The Windows service is only available on Windows.' }
    }
    if (!isUnderProtectedRoot(input.spec.nodeExe, this.deps.protectedRoots)) {
      return {
        ok: false,
        reason:
          'The service needs CamStack installed for all users (under Program Files). This copy ' +
          'runs from a folder your user account can write, and a service running as SYSTEM must ' +
          'not execute code from there. Reinstall choosing "Install for all users".',
      }
    }
    if (!this.deps.fileExists(input.winswSource)) {
      return {
        ok: false,
        reason: `The service wrapper is missing from this build (${input.winswSource}).`,
      }
    }
    if (!this.deps.fileExists(input.spec.nodeExe)) {
      return {
        ok: false,
        reason: `The bundled Node is missing (${input.spec.nodeExe}); the service needs it.`,
      }
    }
    return this.runElevated(
      buildInstallScript({
        layout,
        winswSource: input.winswSource,
        spec: input.spec,
        agentConfigSource: input.agentConfigSource,
      }),
      layout,
    )
  }

  async remove(): Promise<ServiceActionResult> {
    const layout = this.layout
    if (!this.supported || layout === null) {
      return { ok: false, reason: 'The Windows service is only available on Windows.' }
    }
    return this.runElevated(buildRemoveScript(layout), layout)
  }

  private async runElevated(script: string, layout: ServiceLayout): Promise<ServiceActionResult> {
    const [file, args] = elevatedInvocation(script, this.deps.systemRoot)
    const result = await this.deps.exec(file, args)
    if (result.code === 0) return { ok: true }
    // The elevated process cannot report through a pipe; its own log can.
    const detail = this.deps.readFile(layout.lastActionLog)?.trim()
    const reason =
      detail !== undefined && detail.length > 0 && detail !== 'ok'
        ? detail
        : result.code === null
          ? 'PowerShell could not be started.'
          : 'The elevation was declined or the installer failed before it could log.'
    return { ok: false, reason }
  }
}
