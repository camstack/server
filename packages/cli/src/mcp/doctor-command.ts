import { parseArgs } from 'node:util'
import { tryConnectHub } from '@camstack/develop'
import { hubRequest } from '../http/hub-http.js'
import { doctorExitCode, formatDoctor, runDoctorChecks, type HubProbe } from './doctor.js'

async function probeHub(server: string): Promise<HubProbe> {
  try {
    const res = await hubRequest(`${server}/health`, { timeoutMs: 5_000 })
    return res.ok ? { reachable: true } : { reachable: false, error: `answered ${res.status}` }
  } catch (err) {
    return {
      reachable: false,
      error: err instanceof Error ? err.message : String(err),
      cause: err instanceof Error && err.cause !== undefined ? err.cause : err,
    }
  }
}

/** `camstack mcp doctor [-s <host>] [--token-file <p>]`; the exit code is 1 on a failing check. */
export async function runDoctorCommand(
  args: readonly string[],
  cliVersion: string,
): Promise<number> {
  const parsed = parseArgs({
    args: [...args],
    options: { server: { type: 'string', short: 's' }, 'token-file': { type: 'string' } },
    allowPositionals: false,
    strict: true,
  })
  const server = parsed.values.server
  const tokenFile = parsed.values['token-file']
  const checks = await runDoctorChecks({
    cliVersion,
    nodeVersion: process.version,
    connect: () =>
      tryConnectHub({
        workspaceRoot: process.cwd(),
        ...(server ? { server } : {}),
        ...(tokenFile ? { tokenFile } : {}),
      }),
    probeHub,
    fetch: (url, init) => fetch(url, init),
  })
  process.stdout.write(`${formatDoctor(checks)}\n`)
  return doctorExitCode(checks)
}
