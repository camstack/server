import type { ChildProcess } from 'node:child_process'

export interface PythonProbeResult {
  readonly available: boolean
  readonly version?: string
  readonly path?: string
  readonly installedPackages?: readonly string[]
}

export interface PythonEnvReady {
  readonly pythonPath: string
  readonly venvPath: string
  spawn(script: string, args: readonly string[]): ChildProcess
}

export interface IPythonEnvironment {
  probe(): Promise<PythonProbeResult>
  ensure(options: { readonly packages: readonly string[] }): Promise<PythonEnvReady>
  spawn(script: string, args: readonly string[]): ChildProcess
}
