import {
  assertNoRemovedTokenFlags,
  REMOVED_TOKEN_FLAG_OPTIONS,
} from '../commands/removed-token-flags.js'
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

/** `camstack mcp doctor [-s <host>] [--json]`; the exit code is 1 on a failing check. */
export async function runDoctorCommand(
  args: readonly string[],
  cliVersion: string,
): Promise<number> {
  const parsed = parseArgs({
    args: [...args],
    options: {
      server: { type: 'string', short: 's' },
      ...REMOVED_TOKEN_FLAG_OPTIONS,
      json: { type: 'boolean' },
    },
    allowPositionals: false,
    strict: true,
  })
  assertNoRemovedTokenFlags(parsed.values)
  const server = parsed.values.server
  const checks = await runDoctorChecks({
    cliVersion,
    nodeVersion: process.version,
    connect: () =>
      tryConnectHub({
        workspaceRoot: process.cwd(),
        ...(server ? { server } : {}),
      }),
    probeHub,
    fetch: (url, init) => fetch(url, init),
  })
  process.stdout.write(
    parsed.values.json === true ? `${JSON.stringify(checks)}\n` : `${formatDoctor(checks)}\n`,
  )
  return doctorExitCode(checks)
}
