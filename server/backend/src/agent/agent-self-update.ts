/**
 * An agent keeps its own `@camstack/server` closure current, with nobody driving it.
 *
 * Until now a closure reached an agent only when the HUB called `applyServerUpdate` on it. A
 * freshly installed desktop agent boots the seed closure baked into the app and, being unpaired,
 * had no hub to receive a fix from — not even the fix for its own unpaired boot (D857).
 *
 * The target version:
 *  - UNPAIRED: the npm `latest` of `@camstack/server` — there is no hub to follow;
 *  - PAIRED: the version the HUB runs (carried on the registration ack), never npm latest, so
 *    the cluster has no hub/agent skew.
 *
 * It reuses the one updater (`AgentUpdateService` → stage → `scheduleAgentRestart`, lifecycle =
 * respawn, D5), never downgrades, and treats a failed read as "unknown", never as "up to date"
 * (D49, D393): the reason is logged and nothing changes. The cadence is the update-check
 * constant; there is no retry loop (D3).
 *
 * Off switch: `CAMSTACK_AGENT_SELF_UPDATE=off` (or `0`/`false`).
 */
import { compareSemver } from '../server-root/index.js'

export type AgentSelfUpdateSource = 'npm-latest' | 'hub'

export type NpmLatestRead =
  | { readonly ok: true; readonly version: string }
  | { readonly ok: false; readonly reason: string }

export interface AgentSelfUpdateInput {
  readonly paired: boolean
  readonly running: string | null
  readonly npmLatest: NpmLatestRead
  readonly hubVersion: string | null
  readonly pendingVersion: string | null
}

export type AgentSelfUpdateDecision =
  | {
      readonly action: 'stage'
      readonly version: string
      readonly source: AgentSelfUpdateSource
    }
  | {
      readonly action: 'skip'
      readonly reason: string
      /** The target could not be READ — unknown, not "up to date". */
      readonly failedRead: boolean
    }

function skip(reason: string, failedRead = false): AgentSelfUpdateDecision {
  return { action: 'skip', reason, failedRead }
}

export function decideAgentSelfUpdate(input: AgentSelfUpdateInput): AgentSelfUpdateDecision {
  if (input.running === null) return skip('the running version is unknown', true)
  let target: string
  let source: AgentSelfUpdateSource
  if (input.paired) {
    if (input.hubVersion === null) {
      return skip(
        'paired, but the hub version is unknown (no registration ack carrying it yet, or an older hub)',
        true,
      )
    }
    target = input.hubVersion
    source = 'hub'
  } else {
    if (!input.npmLatest.ok) {
      return skip(`the registry read failed: ${input.npmLatest.reason}`, true)
    }
    target = input.npmLatest.version
    source = 'npm-latest'
  }
  const order = compareSemver(target, input.running)
  if (order === 0) return skip(`already running ${target} (${source})`)
  if (order < 0)
    return skip(
      `target ${target} (${source}) is older than running ${input.running}: never a downgrade`,
    )
  if (input.pendingVersion === target) return skip(`${target} is already staged, awaiting restart`)
  return { action: 'stage', version: target, source }
}

export function agentSelfUpdateEnabled(env: NodeJS.ProcessEnv): boolean {
  const raw = env['CAMSTACK_AGENT_SELF_UPDATE']?.trim().toLowerCase()
  return !(raw === 'off' || raw === '0' || raw === 'false' || raw === 'no')
}

export interface AgentSelfUpdateApplyResult {
  readonly accepted: boolean
  readonly outcome: string
  readonly message: string
}

export interface AgentSelfUpdatePorts {
  readonly enabled: () => boolean
  readonly isPaired: () => boolean
  /** The hub's running `@camstack/server` version from the last registration ack. */
  readonly getHubServerVersion: () => string | null
  readonly runningVersion: () => string | null
  readonly checkLatest: () => Promise<{
    readonly latestVersion: string | null
    readonly error: string | null
    readonly pendingVersion: string | null
  }>
  readonly apply: (version: string) => Promise<AgentSelfUpdateApplyResult>
  readonly log: {
    readonly info: (message: string) => void
    readonly warn: (message: string) => void
  }
}

/** One self-update pass. Every decision is logged with the versions; it never throws. */
export async function runAgentSelfUpdate(ports: AgentSelfUpdatePorts): Promise<void> {
  const { log } = ports
  try {
    if (!ports.enabled()) {
      log.info('agent self-update: off (CAMSTACK_AGENT_SELF_UPDATE) — nothing checked')
      return
    }
    const paired = ports.isPaired()
    const running = ports.runningVersion()
    const hubVersion = ports.getHubServerVersion()
    let npmLatest: NpmLatestRead = { ok: false, reason: 'not needed' }
    let pendingVersion: string | null = null
    if (!paired) {
      const check = await ports.checkLatest()
      pendingVersion = check.pendingVersion
      npmLatest =
        check.error === null && check.latestVersion !== null
          ? { ok: true, version: check.latestVersion }
          : {
              ok: false,
              reason: check.error ?? 'the registry returned no version',
            }
    }
    log.info(
      `agent self-update: checked (${paired ? 'paired' : 'unpaired'}) running=${running ?? 'unknown'} ` +
        `hub=${hubVersion ?? 'unknown'} npmLatest=${npmLatest.ok ? npmLatest.version : 'n/a'}`,
    )
    const decision = decideAgentSelfUpdate({
      paired,
      running,
      npmLatest,
      hubVersion,
      pendingVersion,
    })
    if (decision.action === 'skip') {
      const line = `agent self-update: skip — ${decision.reason}`
      if (decision.failedRead) log.warn(line)
      else log.info(line)
      return
    }
    log.info(
      `agent self-update: staging ${decision.version} (${decision.source}) over ${running ?? 'unknown'}`,
    )
    const result = await ports.apply(decision.version)
    if (result.accepted) {
      log.info(
        `agent self-update: applied ${decision.version} (${result.outcome}) — restarting to swap the closure`,
      )
    } else {
      log.warn(
        `agent self-update: ${decision.version} not applied (${result.outcome}): ${result.message}`,
      )
    }
  } catch (err) {
    log.warn(
      `agent self-update: failed — ${err instanceof Error ? err.message : String(err)}; nothing changed`,
    )
  }
}
