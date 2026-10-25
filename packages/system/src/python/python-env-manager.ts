import { userError } from '@camstack/types'
import type { IPythonEnvironment, PythonProbeResult, PythonEnvReady } from '@camstack/types'
import { execFile, spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { promisify } from 'node:util'
import * as fs from 'node:fs'
import * as path from 'node:path'

const execFileAsync = promisify(execFile)

export class PythonEnvManager implements IPythonEnvironment {
  private venvPath: string
  private cachedProbe: PythonProbeResult | null = null

  constructor(dataDir: string) {
    this.venvPath = path.join(dataDir, '.venv')
  }

  async probe(): Promise<PythonProbeResult> {
    if (this.cachedProbe) return this.cachedProbe

    // Try python3, then python
    for (const cmd of ['python3', 'python']) {
      try {
        const { stdout } = await execFileAsync(cmd, ['--version'])
        const version = stdout.trim().replace('Python ', '')
        const major = parseInt(version.split('.')[0] ?? '0', 10)
        const minor = parseInt(version.split('.')[1] ?? '0', 10)

        if (major < 3 || (major === 3 && minor < 10)) continue

        // Get path
        const { stdout: pathOut } = await execFileAsync(cmd, [
          '-c',
          'import sys; print(sys.executable)',
        ])

        this.cachedProbe = {
          available: true,
          version,
          path: pathOut.trim(),
        }
        return this.cachedProbe
      } catch {
        continue
      }
    }

    this.cachedProbe = { available: false }
    return this.cachedProbe
  }

  async ensure(options: { packages: readonly string[] }): Promise<PythonEnvReady> {
    const probe = await this.probe()
    if (!probe.available || !probe.path) {
      throw userError(
        'system.python-required',
        undefined,
        'Python 3.10+ is required but not found on this system',
      )
    }

    // Create venv if needed
    if (!fs.existsSync(path.join(this.venvPath, 'bin', 'python'))) {
      await execFileAsync(probe.path, ['-m', 'venv', this.venvPath])
    }

    const venvPython = path.join(this.venvPath, 'bin', 'python')

    // Install packages
    if (options.packages.length > 0) {
      await execFileAsync(venvPython, ['-m', 'pip', 'install', '-q', ...options.packages])
    }

    return {
      pythonPath: venvPython,
      venvPath: this.venvPath,
      spawn: (script: string, args: readonly string[]) => {
        return spawn(venvPython, [script, ...args])
      },
    }
  }

  spawn(script: string, args: readonly string[]): ChildProcess {
    const venvPython = path.join(this.venvPath, 'bin', 'python')
    if (!fs.existsSync(venvPython)) {
      throw new Error('Python venv not initialized. Call ensure() first.')
    }
    return spawn(venvPython, [script, ...args])
  }
}
