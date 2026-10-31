/**
 * `camstack mcp doctor` — read-only checks of everything `camstack mcp` needs,
 * each ok / fail / unknown with the one command that fixes it. Nothing is
 * written, and no token value is ever printed (only its scope).
 */
import {
  explainTlsFailure,
  hubCaFileForServer,
  resolveHubTls,
  type ConnectOutcome,
} from '@camstack/develop'
import type { FetchFn } from './context.js'
import { isOlder } from './ops-update-cli.js'
import { latestOnNpm } from './setup-tools.js'

export type DoctorStatus = 'ok' | 'fail' | 'unknown'

export interface DoctorCheck {
  readonly id: 'node' | 'hub' | 'ca' | 'session' | 'scope' | 'version'
  readonly label: string
  readonly status: DoctorStatus
  readonly detail: string
  readonly fix?: string
}

export interface HubProbe {
  readonly reachable: boolean
  readonly error?: string
  /** The raw error, so a TLS failure can be told from a plain outage. */
  readonly cause?: unknown
}

export interface DoctorDeps {
  readonly cliVersion: string
  readonly nodeVersion: string
  readonly connect: () => Promise<ConnectOutcome>
  readonly probeHub: (server: string) => Promise<HubProbe>
  readonly fetch: FetchFn
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly sessionDir?: string
}

const MIN_NODE_MAJOR = 24

function nodeCheck(version: string): DoctorCheck {
  const major = Number.parseInt(version.replace(/^v/, '').split('.')[0] ?? '', 10)
  if (Number.isNaN(major)) {
    return {
      id: 'node',
      label: 'Node.js version',
      status: 'unknown',
      detail: `cannot read "${version}"`,
    }
  }
  if (major >= MIN_NODE_MAJOR) {
    return {
      id: 'node',
      label: 'Node.js version',
      status: 'ok',
      detail: `${version} (>= ${MIN_NODE_MAJOR})`,
    }
  }
  return {
    id: 'node',
    label: 'Node.js version',
    status: 'fail',
    detail: `${version} is older than the required ${MIN_NODE_MAJOR}`,
    fix: `Install Node.js ${MIN_NODE_MAJOR} or newer, then reinstall: npm install -g camstack@latest`,
  }
}

async function versionCheck(deps: DoctorDeps): Promise<DoctorCheck> {
  const latest = await latestOnNpm('camstack', deps.fetch)
  if (latest.latest === null) {
    return {
      id: 'version',
      label: 'CLI version',
      status: 'unknown',
      detail: `${deps.cliVersion} installed; npm latest unreadable (${latest.error ?? 'no answer'})`,
    }
  }
  if (isOlder(deps.cliVersion, latest.latest)) {
    return {
      id: 'version',
      label: 'CLI version',
      status: 'fail',
      detail: `${deps.cliVersion} installed, ${latest.latest} is on npm`,
      fix: 'npm install -g camstack@latest, then restart the MCP in your client (OpenCode and similar keep the old process).',
    }
  }
  return {
    id: 'version',
    label: 'CLI version',
    status: 'ok',
    detail: `${deps.cliVersion} (npm latest ${latest.latest})`,
  }
}

const NO_HUB = 'no hub to check (see the session line)'

export async function runDoctorChecks(deps: DoctorDeps): Promise<readonly DoctorCheck[]> {
  const checks: DoctorCheck[] = [nodeCheck(deps.nodeVersion)]
  let outcome: ConnectOutcome
  try {
    outcome = await deps.connect()
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const tls = explainTlsFailure('the hub', err)
    outcome = {
      ok: false,
      reason: 'no-session',
      message: tls ?? message,
      action: 'camstack login <host>',
    }
  }

  if (!outcome.ok) {
    checks.push(
      { id: 'hub', label: 'Hub reachable', status: 'unknown', detail: NO_HUB },
      { id: 'ca', label: 'Hub CA pinned', status: 'unknown', detail: NO_HUB },
      {
        id: 'session',
        label: 'Session or token file',
        status: 'fail',
        detail: outcome.message,
        fix: `${outcome.action}; without a TTY: camstack login <host> --token-file <path-to-0600-file>`,
      },
      { id: 'scope', label: 'Token scope', status: 'unknown', detail: 'no credential to inspect' },
      await versionCheck(deps),
    )
    return checks
  }

  const { connection } = outcome
  const server = connection.server
  const probe = await deps.probeHub(server)
  const tlsExplained = probe.reachable ? null : explainTlsFailure(server, probe.cause)
  checks.push(
    probe.reachable
      ? { id: 'hub', label: 'Hub reachable', status: 'ok', detail: server }
      : {
          id: 'hub',
          label: 'Hub reachable',
          status: 'fail',
          detail: `${server}: ${probe.error ?? 'no answer'}`,
          fix:
            tlsExplained === null
              ? 'Check the hub is running and the address is right (camstack login <host>).'
              : 'Pin the hub CA (see the next line).',
        },
  )

  const pinned = resolveHubTls(server, deps.env ?? process.env, deps.sessionDir)
  if (!server.startsWith('https:')) {
    checks.push({
      id: 'ca',
      label: 'Hub CA pinned',
      status: 'unknown',
      detail: 'plain http hub: TLS is not used',
    })
  } else if (pinned.ca) {
    checks.push({
      id: 'ca',
      label: 'Hub CA pinned',
      status: 'ok',
      detail: pinned.caFile ?? 'pinned',
    })
  } else if (tlsExplained !== null) {
    checks.push({
      id: 'ca',
      label: 'Hub CA pinned',
      status: 'fail',
      detail: 'no pinned CA and the hub certificate is not publicly trusted',
      fix: `Save the hub's certificate or CA PEM to ${hubCaFileForServer(server, deps.sessionDir)} (or set $CAMSTACK_HUB_CA_FILE).`,
    })
  } else {
    checks.push({
      id: 'ca',
      label: 'Hub CA pinned',
      status: 'unknown',
      detail: 'no pin; fine while the hub certificate is publicly trusted',
    })
  }

  checks.push({
    id: 'session',
    label: 'Session or token file',
    status: 'ok',
    detail: `usable credential from ${connection.source}`,
  })
  checks.push(
    connection.tier === 'admin'
      ? { id: 'scope', label: 'Token scope', status: 'ok', detail: 'admin' }
      : {
          id: 'scope',
          label: 'Token scope',
          status: 'unknown',
          detail: 'not admin: read tools work, configure and update tools are refused',
          fix: connection.adminHint ?? 'camstack login <host> as an administrator',
        },
  )
  checks.push(await versionCheck(deps))
  return checks
}

const MARK: Readonly<Record<DoctorStatus, string>> = {
  ok: 'ok     ',
  fail: 'FAIL   ',
  unknown: 'unknown',
}

export function formatDoctor(checks: readonly DoctorCheck[]): string {
  const lines: string[] = ['camstack mcp doctor', '']
  for (const c of checks) {
    lines.push(`[${MARK[c.status]}] ${c.label}: ${c.detail}`)
    if (c.fix && c.status !== 'ok') lines.push(`          fix: ${c.fix}`)
  }
  const failed = checks.filter((c) => c.status === 'fail').length
  lines.push('', failed === 0 ? 'No failing check.' : `${failed} failing check(s).`)
  return lines.join('\n')
}

export function doctorExitCode(checks: readonly DoctorCheck[]): number {
  return checks.some((c) => c.status === 'fail') ? 1 : 0
}
