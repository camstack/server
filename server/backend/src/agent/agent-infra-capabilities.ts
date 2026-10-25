/**
 * Which infra capabilities an AGENT boots — and the one it no longer does.
 *
 * ## What changed, and why it is a boot-level fact
 *
 * `AGENT_INFRA` used to be `INFRA_CAPABILITIES`, unfiltered. That list carries
 * `{ name: 'data-store-provider', required: true }`; `sqlite-settings` is the
 * only addon in the tree that declares it, and it lives inside the
 * `@camstack/system` closure the agent scans. So an agent could not boot
 * without opening a database of its own — not a setting, a PRECONDITION.
 *
 * Persistence belongs to the hub. Every addon FORKED on an agent already
 * reaches the hub's store (`ipcParentLink` → the agent's `onUnownedCall` →
 * `$hub-cap-fwd`), and per-node values already live inside the hub's blob as
 * `<key>@<nodeId>`. The only writers of the agent's own file were the handful
 * of infra addons that boot inside agent-main, whose `ctx.settings` resolved
 * `settingsStore` through `localProviderLink` — i.e. against the local door.
 * The commit before this one gave that door the hub as its remote, so dropping
 * the engine leaves nothing stranded.
 *
 * Measured on `agent-a` before the change: 17 tables, 33 objects, one
 * page each. Every `*:addon-settings` table — `hub-forwarder`,
 * `metrics-native`, `platform-probe`, `storage-orchestrator`, and the shared
 * `addon-settings` — held **0 rows**. The only non-empty tables were
 * `system-settings` (21 rows, all boot-seeded defaults) and `storage_locations`
 * (4 rows, every one `is_system=1 is_default=1`, re-derived from declarations
 * at every boot). Nothing to migrate, and that is a measurement, not an
 * assumption.
 *
 * ## The rollback is an env var, deliberately
 *
 * This path has cost three boot holes already — 1.2.149 (the skip-infra
 * shortcut), 1.2.151 (the D44×D87 crash-loop), 1.2.152 (the `resolveConfig`
 * hang). A change to agent boot that can only be undone by shipping a build is
 * a change that stays broken for a release cycle.
 *
 * **To roll back:** set `CAMSTACK_AGENT_LOCAL_DATA_STORE=1` in the agent
 * container's environment and restart it. That restores `INFRA_CAPABILITIES`
 * EXACTLY (same entries, same order, same `required` flags) minus the hub-only
 * `keychain`, which no flag brings to an agent — so the agent boots its own `sqlite-settings` again and the data door resolves that engine
 * instead of the hub (a local engine always wins over the remote; see
 * `data-store-dispatch.ts`). No redeploy, no revert, and the other two commits
 * in this series stay in place: commit 1 is inert whenever a local engine
 * exists, and commit 3 is documentation.
 */
import { INFRA_CAPABILITIES, type InfraCapability } from '@camstack/system'

/**
 * The env var that puts the local engine back. Named for what it restores, not
 * for what it disables, so an operator reading a container's environment can
 * tell what it does without this file.
 */
export const AGENT_LOCAL_DATA_STORE_ENV = 'CAMSTACK_AGENT_LOCAL_DATA_STORE'

/** The capability an agent no longer boots. */
const DATA_STORE_PROVIDER = 'data-store-provider'

/**
 * The keychain (D787) is the HUB's, always — whatever the rollback flag says.
 *
 * Booting it on an agent was the bug that locked the hub on 2026-10-08: the
 * agent's settings door forwards to the hub, so an agent's keychain wrote the
 * `keychain:keys` row INTO THE HUB'S DATABASE while writing the master key to
 * the AGENT's `<dataDir>/.keychain/master.key`. The Mac agent booted first,
 * generated the key on the Mac, and the hub's next boot found a wrapped data
 * key and no key file under `/data` — `key-missing`, locked. An agent-local
 * keychain also shadowed `$hub-cap-fwd` for the agent's own forked addons, so
 * their secrets resolved against a keychain that could only ever be locked.
 *
 * An agent reaches the keychain the way it reaches every hub cap: forwarded.
 */
const HUB_ONLY_INFRA: ReadonlySet<string> = new Set(['keychain'])

/**
 * Truthy spellings an operator actually types into a docker `-e`. Anything
 * else — including the empty string a declared-but-unset variable produces —
 * is false, because an accidentally-empty variable must not silently restore
 * a local database.
 */
function isEnabled(raw: string | undefined): boolean {
  const value = (raw ?? '').trim().toLowerCase()
  return value === '1' || value === 'true' || value === 'yes'
}

/**
 * The ordered infra list Phase 1 walks on an agent.
 *
 * Order is load-bearing (`storage-provider` before `storage`, the door after
 * both), so this FILTERS the canonical list rather than rebuilding it — a
 * hand-written copy would drift the first time a capability was added to
 * `INFRA_CAPABILITIES`, and the drift would be a missing provider at boot.
 *
 * `INFRA_CAPABILITIES` itself is never touched: the hub reads the same array.
 */
export function resolveAgentInfraCapabilities(env: NodeJS.ProcessEnv): readonly InfraCapability[] {
  const keepLocalStore = isEnabled(env[AGENT_LOCAL_DATA_STORE_ENV])
  return INFRA_CAPABILITIES.filter(
    (cap) => !HUB_ONLY_INFRA.has(cap.name) && (keepLocalStore || cap.name !== DATA_STORE_PROVIDER),
  )
}
