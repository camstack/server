/**
 * `setup_wizard`: what a freshly installed hub still lacks, in the order an
 * operator should do it. Read-only; each step carries its own status, the
 * reason when it could not be judged, and the existing tool or UI page that
 * comes next.
 *
 * A read that failed is `unknown` with its reason and a `null` count, never
 * `missing` or `0` (D315, D393). Nothing secret is read or returned.
 */
import type { HubConnection } from '@camstack/develop'
import { ruleKindOf, type NcRuleKind } from '@camstack/types'
import type { McpContext } from './context.js'
import { readCameras, type CameraRef } from './configure-common.js'
import { readTargets, type TargetRef } from './configure-hub-reads.js'
import { ADMIN_ONLY_NOTE, readQuery, withHub, type NoSessionResult, type Read } from './ops-hub.js'
import { TopologySchema } from './ops-status.js'
import {
  readBackupDestinations,
  readDefaultPasswordInUse,
  readPasskeyCount,
  readPublicEndpoint,
  readRemoteAccessStatus,
  readRules,
  readUsers,
  type BackupFact,
  type RemoteAccessFact,
  type RuleFact,
  type UserFact,
} from './setup-wizard-reads.js'
import { probeVersions, type VersionProbe } from './version-probe.js'

export type StepStatus = 'done' | 'missing' | 'unknown' | 'suggested'

export type WizardNext =
  | { readonly tool: string; readonly args?: { readonly [key: string]: unknown } }
  | { readonly ui: string }
  | null

export interface WizardStep {
  readonly id: string
  readonly title: string
  readonly status: StepStatus
  readonly detail: string
  readonly reason?: string
  readonly next: WizardNext
}

export const PASSKEY_ADMIN_LIMIT = 10
const UNCOVERED_LIMIT = 10
const ADMIN_ALERT_KINDS: readonly NcRuleKind[] = ['system', 'device-events', 'alarm', 'mixed']

/** Everything the steps are judged from. `null` counts live inside a failed `Read`. */
export interface WizardReads {
  readonly users: Read<readonly UserFact[]>
  /** Passkey count per admin id; an admin whose read failed is absent. */
  readonly passkeys: ReadonlyMap<string, number>
  readonly passkeysFailed: number
  readonly passkeysSkipped: number
  /** Whether an admin still has the first-boot password (D728, D797). */
  readonly defaultPassword: Read<boolean>
  readonly publicEndpoint: Read<boolean>
  readonly remoteAccess: Read<RemoteAccessFact>
  readonly backups: Read<readonly BackupFact[]>
  readonly cameras: Read<readonly CameraRef[]>
  readonly agents: Read<number>
  readonly targets: Read<readonly TargetRef[]>
  readonly rules: Read<readonly RuleFact[]>
  readonly versions: VersionProbe | null
}

function failed<T>(read: Read<T>): string | null {
  return read.ok ? null : read.reason
}

function unknownStep(id: string, title: string, reason: string, next: WizardNext): WizardStep {
  return { id, title, status: 'unknown', detail: 'could not be read', reason, next }
}

function adminStep(reads: WizardReads): WizardStep {
  const id = 'admin-account'
  const title = 'Admin account and two-factor sign-in'
  const next: WizardNext = { ui: 'System → Users' }
  if (!reads.users.ok) return unknownStep(id, title, reads.users.reason, next)
  const admins = reads.users.value.filter((u) => u.isAdmin)
  const protectedAdmins = admins.filter((u) => u.totpEnabled || (reads.passkeys.get(u.id) ?? 0) > 0)
  if (admins.length === 0) {
    return { id, title, status: 'missing', detail: 'no admin account exists', next }
  }
  if (reads.defaultPassword.ok && reads.defaultPassword.value) {
    return {
      id,
      title,
      status: 'missing',
      detail: 'an admin account still has the default password (admin / changeme)',
      next,
    }
  }
  if (protectedAdmins.length > 0) {
    if (!reads.defaultPassword.ok) {
      return unknownStep(id, title, reads.defaultPassword.reason, next)
    }
    return {
      id,
      title,
      status: 'done',
      detail: `${protectedAdmins.length} of ${admins.length} admin(s) sign in with 2FA or a passkey; the default password was replaced`,
      next,
    }
  }
  if (reads.passkeysFailed > 0) {
    return unknownStep(id, title, `${reads.passkeysFailed} passkey read(s) failed`, next)
  }
  const skipped =
    reads.passkeysSkipped > 0 ? ` (${reads.passkeysSkipped} admin(s) not checked for passkeys)` : ''
  return {
    id,
    title,
    status: 'missing',
    detail: `no admin has 2FA or a passkey${skipped}`,
    next,
  }
}

function addressStep(reads: WizardReads): WizardStep {
  const id = 'hub-address-remote-access'
  const title = 'Hub address and remote access'
  const next: WizardNext = { tool: 'configure_remote_access' }
  const endpoint = reads.publicEndpoint
  const access = reads.remoteAccess
  if ((endpoint.ok && endpoint.value) || (access.ok && access.value.hasEndpoint)) {
    return {
      id,
      title,
      status: 'done',
      detail:
        access.ok && access.value.connected
          ? 'a public endpoint is set and connected'
          : 'a public endpoint is set',
      next,
    }
  }
  if (!endpoint.ok || !access.ok) {
    return unknownStep(
      id,
      title,
      [failed(endpoint), failed(access)].filter(Boolean).join('; '),
      next,
    )
  }
  return {
    id,
    title,
    status: 'missing',
    detail: 'no public endpoint and no remote access configured',
    next,
  }
}

function backupStep(reads: WizardReads): WizardStep {
  const id = 'backups'
  const title = 'Backups'
  const next: WizardNext = { ui: 'Data → Backup' }
  if (!reads.backups.ok) return unknownStep(id, title, reads.backups.reason, next)
  const active = reads.backups.value.filter((d) => d.enabled && d.scheduled)
  if (active.length === 0) {
    return { id, title, status: 'missing', detail: 'no enabled destination with a schedule', next }
  }
  const last = Math.max(0, ...active.map((d) => d.lastSuccessAt ?? 0))
  const lastText =
    last > 0 ? `last success ${new Date(last).toISOString()}` : 'no successful backup yet'
  return {
    id,
    title,
    status: 'done',
    detail: `${active.length} scheduled destination(s); ${lastText}`,
    next,
  }
}

function camerasStep(reads: WizardReads): WizardStep {
  const id = 'cameras-and-agents'
  const title = 'Cameras and agents'
  const providersNext: WizardNext = { tool: 'configure_camera_providers' }
  if (!reads.cameras.ok) return unknownStep(id, title, reads.cameras.reason, providersNext)
  const agents = reads.agents.ok
    ? `${reads.agents.value} agent node(s)`
    : `agents unknown (${reads.agents.reason})`
  const count = reads.cameras.value.length
  if (count === 0) {
    return { id, title, status: 'missing', detail: `no camera yet; ${agents}`, next: providersNext }
  }
  return {
    id,
    title,
    status: 'done',
    detail: `${count} camera(s); ${agents}`,
    next: { tool: 'configure_camera_discover' },
  }
}

function notifiersStep(reads: WizardReads): WizardStep {
  const id = 'notifiers'
  const title = 'Notification targets'
  const next: WizardNext = { tool: 'configure_notification_targets' }
  if (!reads.targets.ok) return unknownStep(id, title, reads.targets.reason, next)
  const enabled = reads.targets.value.filter((t) => t.enabled).length
  if (enabled === 0)
    return { id, title, status: 'missing', detail: 'no enabled notification target', next }
  return { id, title, status: 'done', detail: `${enabled} enabled target(s)`, next }
}

function ruleKind(rule: RuleFact): NcRuleKind {
  return ruleKindOf({ delivery: rule.delivery, conditions: rule.conditions })
}

function adminAlertStep(reads: WizardReads): WizardStep {
  const id = 'admin-alert-rules'
  const title = 'Alerts for the administrator'
  const next: WizardNext = {
    tool: 'configure_notification_rule_questionnaire',
    args: { kind: 'system' },
  }
  if (!reads.rules.ok) return unknownStep(id, title, reads.rules.reason, next)
  const count = reads.rules.value.filter(
    (r) => r.enabled && ADMIN_ALERT_KINDS.includes(ruleKind(r)),
  ).length
  if (count === 0)
    return { id, title, status: 'missing', detail: 'no enabled system or alarm rule', next }
  return { id, title, status: 'done', detail: `${count} enabled rule(s)`, next }
}

function householdStep(reads: WizardReads): WizardStep {
  const id = 'household-rules'
  const title = 'Detection rules per camera'
  const next: WizardNext = {
    tool: 'configure_notification_rule_questionnaire',
    args: { kind: 'detection' },
  }
  if (!reads.rules.ok) return unknownStep(id, title, reads.rules.reason, next)
  if (!reads.cameras.ok) return unknownStep(id, title, reads.cameras.reason, next)
  const cameras = reads.cameras.value
  if (cameras.length === 0) {
    return {
      id,
      title,
      status: 'missing',
      detail: 'no camera to cover yet',
      next: { tool: 'configure_camera_providers' },
    }
  }
  const detection = reads.rules.value.filter((r) => r.enabled && ruleKind(r) === 'detection')
  const coversAll = detection.some((r) => r.devices === null)
  const covered = new Set(detection.flatMap((r) => r.devices ?? []))
  const uncovered = coversAll ? [] : cameras.filter((c) => !covered.has(c.id))
  if (uncovered.length === 0) {
    return {
      id,
      title,
      status: 'done',
      detail: `all ${cameras.length} camera(s) are covered`,
      next,
    }
  }
  const shown = uncovered.slice(0, UNCOVERED_LIMIT).map((c) => `${c.name} (${c.id})`)
  const more = uncovered.length > shown.length ? ` and ${uncovered.length - shown.length} more` : ''
  return {
    id,
    title,
    status: 'missing',
    detail: `${uncovered.length} camera(s) without a detection rule: ${shown.join(', ')}${more}`,
    next,
  }
}

function updatesLine(probe: VersionProbe): string {
  const parts = [
    `server ${probe.server.state}`,
    probe.addons.state === 'behind' && 'count' in probe.addons
      ? `${probe.addons.count} addon update(s)`
      : `addons ${probe.addons.state}`,
    `cli ${probe.cli.state}`,
  ]
  return parts.join('; ')
}

function calibrationStep(reads: WizardReads): WizardStep {
  const detail = reads.versions
    ? `calibrate each camera once; versions: ${updatesLine(reads.versions)}`
    : 'calibrate each camera once, and check for updates; versions could not be probed'
  return {
    id: 'calibration-and-updates',
    title: 'Calibration and updates',
    status: 'suggested',
    detail,
    next: { tool: 'configure_calibrate_camera' },
  }
}

/** The pure part: reads in, ordered steps out. */
export function evaluateSteps(reads: WizardReads): readonly WizardStep[] {
  return [
    adminStep(reads),
    addressStep(reads),
    backupStep(reads),
    camerasStep(reads),
    notifiersStep(reads),
    adminAlertStep(reads),
    householdStep(reads),
    calibrationStep(reads),
  ]
}

export interface WizardResult {
  readonly status: 'ok'
  readonly hub: string
  readonly tier: string
  readonly steps: readonly WizardStep[]
  readonly nextStep: {
    readonly id: string
    readonly title: string
    readonly next: WizardNext
  } | null
  readonly unavailable: { readonly [stepId: string]: string }
}

async function gatherReads(connection: HubConnection, ctx: McpContext): Promise<WizardReads> {
  const { client } = connection
  const admin = connection.tier === 'admin'
  const refused = <T>(path: string): Read<T> => ({
    ok: false,
    reason: ADMIN_ONLY_NOTE(path, connection.adminHint),
  })
  const [
    users,
    backups,
    rules,
    topology,
    publicEndpoint,
    remoteAccess,
    cameras,
    targets,
    versions,
    defaultPassword,
  ] = await Promise.all([
    admin
      ? readUsers(client)
      : Promise.resolve(refused<readonly UserFact[]>('userManagement.listUsers')),
    admin
      ? readBackupDestinations(client)
      : Promise.resolve(refused<readonly BackupFact[]>('backup.listDestinations')),
    admin
      ? readRules(client)
      : Promise.resolve(refused<readonly RuleFact[]>('notificationRules.listRules')),
    admin
      ? readQuery(client, 'nodes.topology', undefined, TopologySchema)
      : Promise.resolve(refused<never>('nodes.topology')),
    readPublicEndpoint(client),
    readRemoteAccessStatus(client),
    readCameras(client),
    readTargets(client),
    probeVersions(ctx).catch(() => null),
    admin
      ? readDefaultPasswordInUse(client)
      : Promise.resolve(refused<boolean>('userManagement.getAdminBootstrapStatus')),
  ])
  const passkeys = new Map<string, number>()
  let passkeysFailed = 0
  let passkeysSkipped = 0
  if (users.ok) {
    const admins = users.value.filter((u) => u.isAdmin && !u.totpEnabled)
    const checked = admins.slice(0, PASSKEY_ADMIN_LIMIT)
    passkeysSkipped = admins.length - checked.length
    const counts = await Promise.all(checked.map((u) => readPasskeyCount(client, u.id)))
    counts.forEach((c, i) => {
      const u = checked[i]
      if (u === undefined) return
      if (c.ok) passkeys.set(u.id, c.value)
      else passkeysFailed += 1
    })
  }
  const agents: Read<number> = topology.ok
    ? { ok: true, value: topology.value.filter((n) => n.isHub !== true).length }
    : topology
  return {
    users,
    passkeys,
    passkeysFailed,
    passkeysSkipped,
    defaultPassword,
    publicEndpoint,
    remoteAccess,
    backups,
    cameras,
    agents,
    targets,
    rules,
    versions,
  }
}

export async function setupWizard(ctx: McpContext): Promise<WizardResult | NoSessionResult> {
  return withHub(ctx, async (connection) => {
    const steps = evaluateSteps(await gatherReads(connection, ctx))
    const unavailable: { [stepId: string]: string } = {}
    for (const s of steps) if (s.status === 'unknown' && s.reason) unavailable[s.id] = s.reason
    const first = steps.find((s) => s.status !== 'done')
    return {
      status: 'ok' as const,
      hub: connection.server,
      tier: connection.tier,
      steps,
      nextStep: first ? { id: first.id, title: first.title, next: first.next } : null,
      unavailable,
    }
  })
}
