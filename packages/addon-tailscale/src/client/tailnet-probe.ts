/**
 * The connection check of a tailnet instance (`testInstance`). It never joins anything: it asks
 * the local daemon whether it answers and whether the key LOOKS like a Tailscale key, so a
 * `validated` is "the daemon is reachable and the key is well-formed", never "the control plane
 * accepted it". The key is read, never echoed: no result field carries it.
 */
import type { IntegrationTestConnectionResult } from '@camstack/types'

/** The two key prefixes the Tailscale admin console issues. */
const KEY_PREFIXES: readonly string[] = ['tskey-auth-', 'tskey-client-']

/** What the probe needs of the CLI wrapper. */
export interface TailnetProbeCli {
  version(): Promise<string>
  status(): Promise<{ readonly MagicDNSSuffix?: string }>
}

export interface TailnetProbeResult {
  readonly ok: boolean
  readonly tenant?: string
  readonly daemonVersion?: string
  readonly error?: string
  /** How the failure reads: `rejected` is the key's fault, `inconclusive` is the daemon's. */
  readonly verdict: 'validated' | 'rejected' | 'inconclusive'
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** Replace every occurrence of the key in a text, so no error can carry it back. */
export function scrubKey(text: string, key: string | undefined): string {
  const secret = key?.trim() ?? ''
  return secret.length === 0 ? text : text.split(secret).join('[redacted]')
}

/**
 * `authKey` undefined checks the daemon alone (the old no-argument call). A key is judged on its
 * shape; an unreachable or timed-out CLI is `inconclusive`, never a verdict on the key.
 */
export async function probeTailnet(
  cli: TailnetProbeCli,
  authKey: string | undefined,
): Promise<TailnetProbeResult> {
  let daemonVersion: string | undefined
  try {
    daemonVersion = await cli.version()
  } catch (err) {
    return {
      ok: false,
      verdict: 'inconclusive',
      error: scrubKey(
        `tailscaled CLI not reachable: ${errorText(err)}. Install Tailscale on the host.`,
        authKey,
      ),
    }
  }

  let tenant: string | undefined
  try {
    const status = await cli.status()
    if (status.MagicDNSSuffix) tenant = status.MagicDNSSuffix
  } catch {
    /* ignore — daemon may not yet be running */
  }
  const known = {
    ...(tenant ? { tenant } : {}),
    ...(daemonVersion ? { daemonVersion } : {}),
  }

  if (authKey !== undefined) {
    const trimmed = authKey.trim()
    if (!trimmed) {
      return {
        ok: false,
        verdict: 'rejected',
        ...known,
        error: 'Auth key is empty.',
      }
    }
    if (!KEY_PREFIXES.some((prefix) => trimmed.startsWith(prefix))) {
      return {
        ok: false,
        verdict: 'rejected',
        ...known,
        error:
          'Auth key does not look like a Tailscale key (expected prefix `tskey-auth-` or `tskey-client-`).',
      }
    }
  }
  return { ok: true, verdict: 'validated', ...known }
}

/** The tri-state `testInstance` answer for a probe result. */
export function toTestResult(
  probe: TailnetProbeResult,
  latencyMs: number,
): IntegrationTestConnectionResult {
  if (probe.ok) {
    return {
      success: true,
      status: 'validated',
      latencyMs,
      ...(probe.tenant ? { detail: probe.tenant } : {}),
    }
  }
  return {
    success: false,
    status: probe.verdict === 'rejected' ? 'rejected' : 'inconclusive',
    ...(probe.error ? { error: probe.error } : {}),
  }
}
