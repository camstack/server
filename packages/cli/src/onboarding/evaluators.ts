/**
 * How each step of the onboarding flow is judged against the facts.
 *
 * The STEPS — their order, titles, pages and actions — are written in the
 * public docs and arrive through the manifest. What lives here, keyed by step
 * id, is only the judgement: done, missing, suggested, not needed, or unknown
 * with the reason. A step id the manifest has and this table does not is
 * answered `unknown` ("update the CLI") by the caller; a guard keeps the two
 * lists equal for the manifest this CLI ships with.
 *
 * `missing` means the READ ANSWERED and the thing is not there. A read that
 * failed is `unknown` with its reason, never `missing` (D315).
 */
import { mayWriteToLocation, ruleKindOf, type NcRuleKind } from '@camstack/types'
import type { Read } from '../mcp/ops-hub.js'
import type { RuleFact } from '../mcp/setup-wizard-reads.js'
import type { VersionProbe } from '../mcp/version-probe.js'
import type { HubFacts, NodeCapacity, OnboardingFacts } from './facts.js'

export type StepStatus = 'done' | 'missing' | 'suggested' | 'not-needed' | 'unknown'

export interface StepJudgement {
  readonly status: StepStatus
  readonly detail: string
  /** Why the step could not be judged; only with `unknown`. */
  readonly reason?: string
  /** The action of the step to start from, by its id in the manifest. */
  readonly focusAction?: string
}

export type StepEvaluator = (facts: OnboardingFacts) => StepJudgement

const UNCOVERED_LIMIT = 10
const ADMIN_ALERT_KINDS: readonly NcRuleKind[] = ['system', 'device-events', 'alarm', 'mixed']
const RECORDINGS_TYPE = 'recordings'

const unknown = (reason: string): StepJudgement => ({
  status: 'unknown',
  detail: 'could not be read',
  reason,
})

const failed = <T>(read: Read<T>): string | null => (read.ok ? null : read.reason)

/** A step that can only be judged against a hub. */
function onHub(judge: (hub: HubFacts, facts: OnboardingFacts) => StepJudgement): StepEvaluator {
  return (facts) =>
    facts.session.ok
      ? judge(facts.session.hub, facts)
      : {
          status: 'unknown',
          detail: 'judged once this machine has a session on the hub',
          reason: facts.session.message,
        }
}

const feasibility: StepEvaluator = (facts) => {
  const r = facts.remembered
  if (r !== null) {
    return {
      status: 'done',
      detail: `checked for ${r.cameras} camera(s): ${r.verdict} (provisional${r.measured ? '' : ', hardware not in the measured tables'})`,
    }
  }
  if (facts.session.ok) {
    return {
      status: 'done',
      detail:
        'a hub is already installed and answering; what it carries is measured in the detection step',
    }
  }
  return {
    status: 'missing',
    detail: 'this machine was not checked yet',
    focusAction: 'host-check',
  }
}

const install: StepEvaluator = (facts) => {
  if (facts.session.ok) {
    return {
      status: 'done',
      detail: `the hub at ${facts.session.hub.server} answers`,
    }
  }
  if (facts.remembered?.verdict === 'not-a-hub') {
    return {
      status: 'missing',
      detail: `the check said this machine should not be the hub (${facts.remembered.reasons[0] ?? 'see the feasibility answer'}); install the hub on another machine, or connect to one that exists. ${facts.session.message}`,
      focusAction: 'find-the-hub',
    }
  }
  return {
    status: 'missing',
    detail: `no hub answers from this machine (${facts.session.message}). Not installed yet: install it. Already installed: find it and connect.`,
    focusAction: 'install-guide',
  }
}

const firstLogin: StepEvaluator = (facts) => {
  if (!facts.session.ok) {
    return {
      status: 'missing',
      detail: `this machine is not signed in to a hub: ${facts.session.action}`,
      focusAction: 'sign-in',
    }
  }
  const hub = facts.session.hub
  if (hub.tier !== 'admin') {
    return {
      status: 'missing',
      detail: `this session is not an administrator's, so the rest of the setup cannot be read.${hub.adminHint === null ? '' : ` ${hub.adminHint}`}`,
      focusAction: 'sign-in',
    }
  }
  if (!hub.users.ok) return unknown(hub.users.reason)
  const admins = hub.users.value.filter((u) => u.isAdmin)
  if (admins.length === 0) return { status: 'missing', detail: 'no admin account exists' }
  if (hub.defaultPassword.ok && hub.defaultPassword.value) {
    return {
      status: 'missing',
      detail: 'an admin account still has the default password (admin / changeme)',
      focusAction: 'secure-admin',
    }
  }
  const secured = admins.filter((u) => u.totpEnabled || (hub.passkeys.get(u.id) ?? 0) > 0)
  if (secured.length > 0) {
    if (!hub.defaultPassword.ok) return unknown(hub.defaultPassword.reason)
    return {
      status: 'done',
      detail: `${secured.length} of ${admins.length} admin(s) sign in with 2FA or a passkey; the default password was replaced`,
    }
  }
  if (hub.passkeysFailed > 0) return unknown(`${hub.passkeysFailed} passkey read(s) failed`)
  const skipped =
    hub.passkeysSkipped > 0 ? ` (${hub.passkeysSkipped} admin(s) not checked for passkeys)` : ''
  return {
    status: 'missing',
    detail: `no admin has 2FA or a passkey${skipped}`,
    focusAction: 'secure-admin',
  }
}

/** The hub's own measured capacity, when the benchmark ran on it. */
export function hubCapacity(hub: HubFacts): NodeCapacity | null {
  if (!hub.capacity.ok) return null
  const hubId = hub.nodes.ok ? hub.nodes.value.hubId : null
  const own = hub.capacity.value.find((n) => n.nodeId === (hubId ?? 'hub'))
  return own !== undefined && own.capacity !== null ? own : null
}

const agents: StepEvaluator = onHub((hub, facts) => {
  if (!hub.nodes.ok) return unknown(hub.nodes.reason)
  const { agents: count, agentsOnline } = hub.nodes.value
  if (count > 0) {
    return {
      status: agentsOnline === count ? 'done' : 'missing',
      detail:
        agentsOnline === count
          ? `${count} agent(s), all online`
          : `${count - agentsOnline} of ${count} agent(s) are offline`,
    }
  }
  const measured = hubCapacity(hub)
  if (measured !== null && measured.capacity !== null && hub.cameras.ok) {
    const cameras = hub.cameras.value.length
    return cameras > measured.capacity
      ? {
          status: 'missing',
          detail: `the hub was measured at ${measured.capacity} camera(s) (limited by ${measured.limitedBy ?? 'an unmeasured plane'}) and holds ${cameras}: the rest need an agent`,
        }
      : {
          status: 'not-needed',
          detail: `the hub was measured at ${measured.capacity} camera(s) and holds ${cameras}: hub only`,
        }
  }
  if (facts.remembered?.verdict === 'hub-plus-agents') {
    return {
      status: 'suggested',
      detail: `the check before install said hub plus agents (${facts.remembered.reasons[0] ?? 'provisional'}); that was an estimate — the node benchmark in the detection step measures it and settles this`,
    }
  }
  return {
    status: 'not-needed',
    detail:
      'nothing measured says this hub needs an agent yet; the node benchmark in the detection step settles it',
  }
})

const storage: StepEvaluator = onHub((hub) => {
  if (!hub.locations.ok) return unknown(hub.locations.reason)
  const recordings = hub.locations.value.filter((l) => l.type === RECORDINGS_TYPE)
  if (recordings.length === 0) {
    return {
      status: 'missing',
      detail: 'no location holds recordings',
      focusAction: 'add-location',
    }
  }
  if (!recordings.some((l) => mayWriteToLocation(l))) {
    return {
      status: 'missing',
      detail: 'no recordings location accepts writes',
      focusAction: 'set-modes',
    }
  }
  if (recordings.every((l) => l.isSystem)) {
    return {
      status: 'suggested',
      detail:
        'recordings go to the default data folder of the install; add a location to put them on a dedicated disk',
      focusAction: 'add-location',
    }
  }
  return {
    status: 'done',
    detail: `${recordings.length} recordings location(s), ${hub.locations.value.length} location(s) in all`,
  }
})

const coreAddons: StepEvaluator = onHub((hub) => {
  const { groups, nextAction } = hub.coreAddons
  if (nextAction !== null) {
    const group = groups.find((g) => g.id === nextAction.group)
    const blocking = group !== undefined && group.status !== 'suggested'
    return {
      status: blocking ? 'missing' : 'suggested',
      detail: `${group?.title ?? nextAction.group}: ${nextAction.text}`,
      focusAction: 'read-core-addons',
    }
  }
  const unread = groups.find((g) => g.status === 'unknown')
  if (unread !== undefined) return unknown(unread.reason ?? `${unread.title} could not be read`)
  const optional = groups.filter((g) => g.status === 'suggested').map((g) => g.title)
  return {
    status: 'done',
    detail:
      optional.length === 0
        ? 'everything a working install needs is set up'
        : `everything required is set up; optional: ${optional.join(', ')}`,
  }
})

const cameras: StepEvaluator = onHub((hub) => {
  if (!hub.cameras.ok) return unknown(hub.cameras.reason)
  const count = hub.cameras.value.length
  return count === 0
    ? {
        status: 'missing',
        detail: 'no camera yet',
        focusAction: 'camera-providers',
      }
    : { status: 'done', detail: `${count} camera(s)` }
})

function capacityLine(node: NodeCapacity): string {
  const decode =
    node.decode === null
      ? 'decode not measured'
      : `decodes ${node.decode.maxStreams} stream(s) at ${node.decode.profile.width}x${node.decode.profile.height}@${node.decode.profile.fps} ${node.decode.profile.codec} (${node.decode.hardware ? 'hardware' : 'software'}, ${node.decode.decoder})`
  const detection =
    node.detection === null
      ? 'detection not measured'
      : `runs ${node.detection.maxSessions} detection session(s)`
  const limit =
    node.capacity === null
      ? 'capacity unknown until both are measured'
      : `carries ${node.capacity} camera(s), limited by ${node.limitedBy ?? 'neither'}`
  return `${decode}; ${detection}; ${limit}`
}

/** The benchmark of every node, one line each, with no node id (for a public report). */
export function benchmarkLines(nodes: readonly NodeCapacity[]): readonly string[] {
  return nodes
    .filter((n) => n.decode !== null || n.detection !== null)
    .map((n, i) => `node ${i + 1}: ${capacityLine(n)}`)
}

const detection: StepEvaluator = onHub((hub) => {
  if (!hub.capacity.ok) return unknown(hub.capacity.reason)
  const nodes = hub.capacity.value
  const unmeasured = nodes.filter((n) => !n.complete)
  if (nodes.length === 0 || unmeasured.length > 0) {
    return {
      status: 'missing',
      detail:
        nodes.length === 0
          ? 'the node benchmark has not run on any node: nothing is known about what this install carries'
          : `the node benchmark is incomplete on ${unmeasured.map((n) => n.nodeId).join(', ')} (it must measure both decoding and detection)`,
      focusAction: 'read-benchmark',
    }
  }
  const total = nodes.reduce((sum, n) => sum + (n.capacity ?? 0), 0)
  const held = hub.cameras.ok ? hub.cameras.value.length : null
  const lines = nodes.map((n) => `${n.nodeId} ${capacityLine(n)}`).join(' | ')
  if (held !== null && held > total) {
    return {
      status: 'missing',
      detail: `measured capacity is ${total} camera(s) and the install holds ${held}: ${lines}`,
      focusAction: 'read-pipeline',
    }
  }
  return { status: 'done', detail: `measured: ${lines}` }
})

const remoteAccess: StepEvaluator = onHub((hub, facts) => {
  const endpoint = hub.publicEndpoint
  const access = hub.remoteAccess
  if ((endpoint.ok && endpoint.value) || (access.ok && access.value.hasEndpoint)) {
    return {
      status: 'done',
      detail:
        access.ok && access.value.connected
          ? 'a public endpoint is set and connected'
          : 'a public endpoint is set',
    }
  }
  if (!endpoint.ok || !access.ok) {
    return unknown([failed(endpoint), failed(access)].filter(Boolean).join('; '))
  }
  if (facts.remoteAccess === false) {
    return { status: 'not-needed', detail: 'the hub is used at home only' }
  }
  // A hub that works on the LAN is a working hub: an address for outside is offered, not owed.
  return {
    status: facts.remoteAccess === true ? 'missing' : 'suggested',
    detail:
      'the hub is reachable on the local network only; no public endpoint and no remote access',
    focusAction: 'read-remote-access',
  }
})

const ruleKind = (rule: RuleFact): NcRuleKind =>
  ruleKindOf({ delivery: rule.delivery, conditions: rule.conditions })

const notifications: StepEvaluator = onHub((hub) => {
  if (!hub.targets.ok) return unknown(hub.targets.reason)
  const enabled = hub.targets.value.filter((t) => t.enabled).length
  if (enabled === 0) {
    return {
      status: 'missing',
      detail: 'no enabled notification target',
      focusAction: 'read-targets',
    }
  }
  if (!hub.rules.ok) return unknown(hub.rules.reason)
  const live = hub.rules.value.filter((r) => r.enabled)
  if (!live.some((r) => ADMIN_ALERT_KINDS.includes(ruleKind(r)))) {
    return {
      status: 'missing',
      detail: `${enabled} target(s), but no rule tells the administrator when something breaks (a node offline, a disk full)`,
      focusAction: 'draft-rule',
    }
  }
  if (!hub.cameras.ok) return unknown(hub.cameras.reason)
  const detectionRules = live.filter((r) => ruleKind(r) === 'detection')
  const coversAll = detectionRules.some((r) => r.devices === null)
  const covered = new Set(detectionRules.flatMap((r) => r.devices ?? []))
  const uncovered = coversAll ? [] : hub.cameras.value.filter((c) => !covered.has(c.id))
  if (uncovered.length === 0) {
    return {
      status: 'done',
      detail: `${enabled} target(s); administrator alerts and every camera are covered by a rule`,
    }
  }
  const shown = uncovered.slice(0, UNCOVERED_LIMIT).map((c) => `${c.name} (${c.id})`)
  const more = uncovered.length > shown.length ? ` and ${uncovered.length - shown.length} more` : ''
  return {
    status: 'missing',
    detail: `${uncovered.length} camera(s) without a detection rule: ${shown.join(', ')}${more}`,
    focusAction: 'draft-rule',
  }
})

const backups: StepEvaluator = onHub((hub) => {
  if (!hub.backups.ok) return unknown(hub.backups.reason)
  const active = hub.backups.value.filter((d) => d.enabled && d.scheduled)
  if (active.length === 0) {
    return {
      status: 'missing',
      detail: 'no enabled destination with a schedule',
    }
  }
  const last = Math.max(0, ...active.map((d) => d.lastSuccessAt ?? 0))
  return {
    status: 'done',
    detail: `${active.length} scheduled destination(s); ${last > 0 ? `last success ${new Date(last).toISOString()}` : 'no successful backup yet'}`,
  }
})

function versionsLine(probe: VersionProbe): string {
  return [
    `server ${probe.server.state}`,
    probe.addons.state === 'behind' && 'count' in probe.addons
      ? `${probe.addons.count} addon update(s)`
      : `addons ${probe.addons.state}`,
    `cli ${probe.cli.state}`,
  ].join('; ')
}

const keepCurrent: StepEvaluator = onHub((hub) => {
  const probe = hub.versions
  if (probe === null) return unknown('versions could not be probed')
  const states = [probe.server, probe.addons, probe.cli]
  if (states.some((v) => v.state === 'behind')) {
    return {
      status: 'suggested',
      detail: `updates are available: ${versionsLine(probe)}`,
      focusAction: 'updates',
    }
  }
  const unread = states.flatMap((v) => ('reason' in v ? [v.reason] : []))
  if (unread.length > 0) return unknown(unread.join('; '))
  return {
    status: 'done',
    detail: `${versionsLine(probe)}; calibrate a camera whenever its view changes`,
  }
})

/** Keyed by the step ids of the manifest. The order is the manifest's, not this object's. */
export const STEP_EVALUATORS: Readonly<Record<string, StepEvaluator>> = {
  feasibility,
  install,
  'first-login': firstLogin,
  agents,
  storage,
  'core-addons': coreAddons,
  cameras,
  detection,
  'remote-access': remoteAccess,
  notifications,
  backups,
  'keep-current': keepCurrent,
}
