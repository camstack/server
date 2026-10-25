/**
 * The real-OS wiring of `WindowsServiceManager`: child processes and the
 * filesystem. Kept apart from the manager so everything with a decision in it
 * stays testable without either.
 */
import { execFile } from 'node:child_process'
import * as fs from 'node:fs'
import { WindowsServiceManager, type ExecResult } from './service-manager'

const EXEC_TIMEOUT_MS = 10 * 60_000 // the operator may sit on the UAC prompt

function exec(file: string, args: readonly string[]): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(
      file,
      [...args],
      { encoding: 'utf8', timeout: EXEC_TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        if (error === null) return resolve({ code: 0, stdout })
        const code: unknown = Reflect.get(error, 'code')
        resolve({ code: typeof code === 'number' ? code : null, stdout })
      },
    )
  })
}

export function createWindowsServiceManager(): WindowsServiceManager {
  return new WindowsServiceManager({
    platform: process.platform,
    programData: process.env['ProgramData'],
    systemRoot: process.env['SystemRoot'],
    exec,
    fileExists: (p) => fs.existsSync(p),
    protectedRoots: [
      process.env['ProgramFiles'],
      process.env['ProgramFiles(x86)'],
      process.env['ProgramW6432'],
    ].filter((p): p is string => typeof p === 'string' && p.length > 0),
    readFile: (p) => {
      try {
        return fs.readFileSync(p, 'utf8')
      } catch {
        return null
      }
    },
  })
}
