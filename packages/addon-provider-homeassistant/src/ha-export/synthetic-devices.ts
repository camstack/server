/**
 * Synthetic devices — what belongs to the SERVER, exported as devices that
 * exist inside Home Assistant and nowhere else.
 *
 * They are **not camstack devices**, deliberately (operator, 2026-08-04 and
 * again 2026-08-09). They carry rule switches, cluster monitoring and addon
 * health, none of which is a device in camstack's model; putting them in the
 * device list would fill it with things that are not devices. So they are built
 * HERE, by the exporter, and they have no `deviceId`.
 *
 * A LIST, not two special cases. The spec is explicit that the concept is
 * repeatable and more will be added when something needs a home — a one-off
 * would have to be refactored the first time a third is wanted. Adding one is
 * adding an entry to {@link SYNTHETIC_DEVICES} plus its projection.
 *
 * **Their values are RECONCILE-ONLY, on purpose.** Cluster CPU, memory, addon
 * counts and rule state are polled statistics, not events: there is no
 * `nodes.cpu-changed` to subscribe to, and inventing one to make this look
 * event-driven would be a second authority for numbers the topology already
 * owns. They refresh on the reconcile cadence (`reconcileIntervalSec`, 300s by
 * default), which is also what makes them self-healing after a Home Assistant
 * restart.
 *
 * The identity rules are the same wire format as every other device
 * (`../CLAUDE.md`), with the one difference the category forces: a real device
 * is keyed on its NUMERIC id (`device_id` `camstack-<deviceId>`, `unique_id`
 * `<deviceId>_<entity>`) and these have no numeric id at all, so their own
 * `synthetic-…` id is their identity — `device_id` is `camstack-<syntheticId>`
 * and `unique_id` is `<syntheticId>_<entity>`, built through
 * {@link syntheticDeviceKeyFor}. The ids are prefixed `synthetic-` so they can
 * never collide with a numeric key, whatever the counter reaches.
 */

import {
  commandTopic,
  stateTopic,
  syntheticDeviceKeyFor,
  toComponentKey,
  toSlug,
} from './topics.js'
import type { HaComponent, HaDevicePlan, HaPlatform } from './types.js'

/** The stable id of the notification-centre device. A WIRE FORMAT. */
export const NOTIFICATION_CENTER_STABLE_ID = 'synthetic-notification-center'
/** The stable id of the server device. A WIRE FORMAT. */
export const SERVER_STABLE_ID = 'synthetic-server'

export const SYNTHETIC_STABLE_IDS: readonly string[] = [
  NOTIFICATION_CENTER_STABLE_ID,
  SERVER_STABLE_ID,
]

/** Is this device key one of ours? Used by the command route. */
export function isSyntheticDeviceKey(deviceKey: string): boolean {
  return SYNTHETIC_STABLE_IDS.some((id) => syntheticDeviceKeyFor(id) === deviceKey)
}

// ── Alerts (Task D1) ────────────────────────────────────────────────────

/** The fields `deriveAlertSummary` needs from one `alerts.list` row. */
export interface AlertSummaryInput {
  readonly status: string
  readonly severity: string
  readonly title: string
  readonly updatedAt: number
}

/** The three `alerts_*` entities' values, derived from a raw `alerts.list` answer. */
export interface AlertSummary {
  readonly active: boolean
  readonly count: number
  /** The most recently updated relevant alert's title. `null` = none. */
  readonly lastTitle: string | null
}

/**
 * Pure derivation of the three alert entities (Task D1) — the conditions
 * nobody said, surfaced from `alerts.list`.
 *
 * Counts and raises the badge ONLY on `status: 'active'` alerts whose
 * `severity` is `warning` or `error`. `info` moves neither: a badge that
 * lights up on `info` teaches an operator to ignore it, which is how the
 * 2026-08-08 four-hour blackout produced not one visible alert despite the
 * liveness monitor's findings running the whole time.
 */
export function deriveAlertSummary(alerts: readonly AlertSummaryInput[]): AlertSummary {
  const relevant = alerts.filter(
    (a) => a.status === 'active' && (a.severity === 'warning' || a.severity === 'error'),
  )
  const last = relevant.reduce<AlertSummaryInput | null>(
    (top, a) => (top === null || a.updatedAt > top.updatedAt ? a : top),
    null,
  )
  return { active: relevant.length > 0, count: relevant.length, lastTitle: last?.title ?? null }
}

// ── Inputs ──────────────────────────────────────────────────────────────

export interface SyntheticRule {
  readonly id: string
  readonly name: string
  readonly enabled: boolean
}

export interface SyntheticNode {
  readonly id: string
  readonly name: string
  readonly online: boolean
  readonly cpuPercent: number
  readonly memoryPercent: number
  /** Milliseconds since the node booted — the topology's `uptime` is `Date.now() - connectedSince`. */
  readonly uptimeMs: number
  /** `nodes.topology[].isHub` — the hub already carries `server_version` /
   *  `update_available` of its own, so D3's per-node rows are agent-only. */
  readonly isHub: boolean
  /** `recording.getStorageUsage().totalUsedBytes`, attributed to the node the singleton
   *  recorder answered from (`footageForNode`). `null` = unread this pass. */
  readonly footageUsedBytes: number | null
  /**
   * Percent free on the location with the LEAST free space on this node —
   * the one an operator's "disk over 90%" alert has to fire on. `null` when
   * the node's recorder predates `locations`, or the read failed.
   */
  readonly footageFreePercent: number | null
  /** `nodes.topology[].rootPackage.version` — already in the topology payload
   *  this pass downloads regardless, so this costs zero extra calls. */
  readonly rootPackageVersion: string | null
  /** `serverManagement.getServerPackageStatus({ nodeId }).updateAvailable`.
   *  `null` = unread this pass — never published as a guessed `false`. */
  readonly updateAvailable: boolean | null
}

/**
 * The most recent `notificationRules.getHistory` row, reduced to what the
 * five `last_trigger_*` entities and the image need — "conoscere gli ultimi
 * trigger, le ultime immagini... e da quale label" [know the latest triggers, the latest images... and from which label] (operator, 2026-08-25).
 */
export interface SyntheticLastTrigger {
  /** Fire time (the outbox row's `createdAt`), epoch ms. */
  readonly at: number
  readonly ruleName: string
  readonly deviceName: string
  /**
   * The identified label when the pipeline resolved one, else the detected
   * class — ALWAYS non-empty, so the entity never has to skip a trigger for
   * want of a value. "A person" and "Alice" are both an honest answer to
   * "which label fired this".
   */
  readonly label: string
  readonly status: 'pending' | 'sent' | 'dead'
  /**
   * A FRESH signed URL for the trigger's still, minted this pass through
   * `notificationRules.resolveArtifactUrl` — never carried over from a
   * previous pass. `null` on three indistinguishable causes (no artefact was
   * indexed for this trigger, the artefact has expired past the retained
   * shelf's own age bound, or this install has no externally-reachable base
   * URL): `projectSynthetic` renders every one of them by NOT publishing a
   * value, which leaves the `image` entity at its last-known state (or
   * `unknown`) rather than advertising a link that 404s.
   */
  readonly imageUrl: string | null
}

export interface SyntheticInput {
  readonly rules: readonly SyntheticRule[]

  /**
   * The most recent trigger across every rule, or `null` when nothing has
   * fired yet or the read failed this pass (never invented — see D62's
   * "unknown is the truth" posture, applied here to the same effect as
   * `oldestFootageMs`).
   */
  readonly lastTrigger: SyntheticLastTrigger | null
  /**
   * The most recent trigger PER RULE — "l'ultimo trigger PER REGOLA, con
   * immagine e metadati" [the latest trigger PER RULE, with image and metadata] (operator, 2026-08-27). Keyed by rule id, so a
   * renamed rule keeps its entity. Reduced from the SAME `getHistory` read
   * `lastTrigger` already made (`rule-triggers.ts`'s whole point): one query
   * serves both, never one per rule.
   *
   * A rule with NO entry here (never fired, or its last fire fell outside
   * the page this pass could afford) publishes nothing for that rule —
   * `unknown`, never an invented value. A DISABLED rule keeps its entry: the
   * entities are declared for every rule regardless of `enabled` (mirroring
   * the per-rule switch, which already does this), so disabling a rule never
   * makes its entities disappear — only stop refreshing, which is an honest
   * "here is what it last did".
   */
  readonly lastTriggerByRule: ReadonlyMap<string, SyntheticLastTrigger>
  readonly nodes: readonly SyntheticNode[]
  readonly addonsRunning: number
  readonly addonsFailed: number
  readonly serverVersion: string
  readonly updateAvailable: boolean
  /**
   * The `alerts.list` fan-out (Task D1) — only the `active` alerts whose
   * `severity` is `warning` or `error`. `info` never raises the badge or
   * inflates the count; a badge that lights up on `info` teaches an operator
   * to ignore it.
   */
  readonly alertsActive: boolean
  readonly alertsActiveCount: number
  /** The most recently updated active alert's title. `null` = none. */
  readonly alertsLastTitle: string | null
  /**
   * The oldest ARCHIVED footage across every node's every camera — the
   * minimum of every `RecordingDeviceUsage.oldestMs` this pass could read.
   * Since D418 that field is the durable hour ledger's own oldest, so this
   * sensor tracks retention; before it, it tracked how long ago the recorder
   * process restarted.
   * `null` when no node answered with a usable value.
   */
  readonly oldestFootageMs: number | null
  /**
   * The HUB's seed-vs-contract verdict (`ServerPackageStatus.imageContract.state`)
   * — the 2026-08-02 guasto (`runningVersion` current, container image weeks
   * old). `null` = absent (a hub whose framework train predates the field) or
   * unread this pass.
   */
  readonly imageContractState: string | null
}

// ── Plan building ───────────────────────────────────────────────────────

interface SyntheticSpec {
  readonly entity: string
  readonly platform: HaPlatform
  readonly label: string
  readonly deviceClass?: string
  readonly unit?: string
  readonly icon?: string
  readonly writable?: boolean
  readonly options?: readonly string[]
  readonly entityCategory?: 'config' | 'diagnostic'
}

/**
 * Everything a synthetic device exports arrives ENABLED.
 *
 * The pressure valve exists for the camera fan-out — three zones is ~73
 * entities and the fleet is ~880. There is no fan-out here: the largest of
 * these is one switch per notification rule, and a rule the operator wrote is
 * a rule they want to reach. Shipping them disabled would repeat the bug that
 * exported a thermometer's temperature switched off.
 */
function buildComponents(
  syntheticId: string,
  specs: readonly SyntheticSpec[],
): HaDevicePlan['cmps'] {
  const deviceKey = syntheticDeviceKeyFor(syntheticId)
  const cmps: Record<string, HaComponent> = {}
  for (const spec of specs) {
    cmps[toComponentKey(spec.platform, spec.entity)] = {
      platform: spec.platform,
      unique_id: `${syntheticId}_${spec.entity}`,
      name: spec.label,
      ...(spec.platform === 'button' ? {} : { state_topic: stateTopic(deviceKey, spec.entity) }),
      ...(spec.writable === true ? { command_topic: commandTopic(deviceKey, spec.entity) } : {}),
      ...(spec.deviceClass !== undefined ? { device_class: spec.deviceClass } : {}),
      ...(spec.unit !== undefined ? { unit_of_measurement: spec.unit } : {}),
      ...(spec.icon !== undefined ? { icon: spec.icon } : {}),
      ...(spec.options !== undefined ? { options: spec.options } : {}),
      ...(spec.entityCategory !== undefined ? { entity_category: spec.entityCategory } : {}),
      ...(spec.platform === 'binary_sensor' || spec.platform === 'switch'
        ? { payload_on: 'true', payload_off: 'false' }
        : {}),
    }
  }
  return cmps
}

function plan(syntheticId: string, name: string, specs: readonly SyntheticSpec[]): HaDevicePlan {
  return {
    deviceKey: syntheticDeviceKeyFor(syntheticId),
    // `null` is the type's own word for "synthetic": these have no camstack
    // device behind them, which is the whole point of the category.
    deviceId: null,
    dev: {
      ids: [syntheticDeviceKeyFor(syntheticId)],
      name,
      mf: 'CamStack',
      mdl: 'Synthetic',
    },
    cmps: buildComponents(syntheticId, specs),
  }
}

/**
 * The rule switch entity for a rule id.
 *
 * Slugged, because a rule id is free text and an entity segment is not. The
 * `unique_id` is derived from the rule ID and never its NAME, so a renamed rule
 * keeps every automation pointed at it — the friendly name changes in Home
 * Assistant and nothing else does.
 */
export function ruleEntity(ruleId: string): string {
  return `rule_${toSlug(ruleId)}`
}

/** `rule_<slug>` → the rule id it came from, or null. */
export function ruleIdFromEntity(entity: string, rules: readonly SyntheticRule[]): string | null {
  return rules.find((rule) => ruleEntity(rule.id) === entity)?.id ?? null
}

/** The five suffixes a per-rule last-trigger fact publishes to — mirrors the
 *  global `last_trigger_*` entities one-for-one, minus `rule` (redundant:
 *  the rule is the device grouping the entity is already under). */
const RULE_TRIGGER_SUFFIXES = ['at', 'camera', 'label', 'status', 'image'] as const
type RuleTriggerSuffix = (typeof RULE_TRIGGER_SUFFIXES)[number]

/** The entity id of one per-rule last-trigger fact. Derived from the rule
 *  ID, same identity rule as {@link ruleEntity}. */
export function ruleTriggerEntity(ruleId: string, suffix: RuleTriggerSuffix): string {
  return `${ruleEntity(ruleId)}_last_trigger_${suffix}`
}

function notificationCenterSpecs(input: SyntheticInput): readonly SyntheticSpec[] {
  return [
    {
      entity: 'rules_enabled',
      platform: 'sensor',
      label: 'Rules enabled',
      icon: 'mdi:counter',
      entityCategory: 'diagnostic',
    },
    /**
     * The last trigger, six entities: five facts plus its picture — "conoscere
     * gli ultimi trigger, le ultime immagini... e da quale label" [know the latest triggers, the latest images... and from which label] (operator,
     * 2026-08-25). ENABLED by default like every other entity on this device
     * (see {@link buildComponents}'s docblock): a rule the operator wrote is a
     * rule they want to watch fire.
     *
     * Fixed count regardless of camera fleet size — the fan-out this design
     * explicitly avoids (960 entities at 30 cameras × 32 rules) lives ONLY in
     * the per-rule switches and per-rule trigger facts below, which scale
     * with the RULE count only (this module has no camera dimension at all).
     * These six are on ONE synthetic device and never repeat per camera or
     * per rule.
     */
    {
      entity: 'last_trigger_at',
      platform: 'sensor',
      label: 'Last trigger',
      deviceClass: 'timestamp',
    },
    {
      entity: 'last_trigger_rule',
      platform: 'sensor',
      label: 'Last trigger rule',
      icon: 'mdi:bell-ring-outline',
    },
    {
      entity: 'last_trigger_camera',
      platform: 'sensor',
      label: 'Last trigger camera',
      icon: 'mdi:cctv',
    },
    /** The identified label, or the detected class when none was resolved —
     *  see {@link SyntheticLastTrigger.label}. Never blank. */
    {
      entity: 'last_trigger_label',
      platform: 'sensor',
      label: 'Last trigger label',
      icon: 'mdi:tag-outline',
    },
    /** `pending` / `sent` / `dead` — the outbox row's own status, straight
     *  from `getHistory`, never a second delivery ledger. */
    {
      entity: 'last_trigger_status',
      platform: 'sensor',
      label: 'Last trigger delivery status',
      icon: 'mdi:send-check-outline',
      entityCategory: 'diagnostic',
    },
    /** See {@link SyntheticLastTrigger.imageUrl} for the expired/unreachable
     *  degrade: no value is published rather than a link that 404s. */
    {
      entity: 'last_trigger_image',
      platform: 'image',
      label: 'Last trigger image',
    },
    ...input.rules.map(
      (rule): SyntheticSpec => ({
        entity: ruleEntity(rule.id),
        platform: 'switch',
        label: rule.name,
        writable: true,
        icon: 'mdi:bell-cog',
      }),
    ),
    /**
     * The per-RULE last trigger — "l'ultimo trigger PER REGOLA, con immagine
     * e metadati" [the latest trigger PER RULE, with image and metadata] (operator, 2026-08-27). Five facts per rule, the same
     * shape as the six global ones above minus `rule` (redundant here: the
     * rule IS the grouping). Declared for EVERY rule regardless of
     * `enabled` — same identity rule as the switch above, and the reason a
     * disabled rule's entities keep existing rather than disappearing (see
     * {@link SyntheticInput.lastTriggerByRule}'s docblock for the choice and
     * why).
     *
     * This is the ONLY per-rule fan-out this design adds. 15 rules measured
     * live × 5 facts = 75 new entities — an order of magnitude under the
     * 960-entity per-(rule,camera) design §5.1 rejected, because the axis
     * here is the rule alone.
     */
    ...input.rules.flatMap((rule): readonly SyntheticSpec[] => [
      {
        entity: ruleTriggerEntity(rule.id, 'at'),
        platform: 'sensor',
        label: `${rule.name} last trigger`,
        deviceClass: 'timestamp',
      },
      {
        entity: ruleTriggerEntity(rule.id, 'camera'),
        platform: 'sensor',
        label: `${rule.name} last trigger camera`,
        icon: 'mdi:cctv',
      },
      /** See {@link SyntheticLastTrigger.label}. Never blank. */
      {
        entity: ruleTriggerEntity(rule.id, 'label'),
        platform: 'sensor',
        label: `${rule.name} last trigger label`,
        icon: 'mdi:tag-outline',
      },
      {
        entity: ruleTriggerEntity(rule.id, 'status'),
        platform: 'sensor',
        label: `${rule.name} last trigger delivery status`,
        icon: 'mdi:send-check-outline',
        entityCategory: 'diagnostic',
      },
      /** See {@link SyntheticLastTrigger.imageUrl} for the expired/
       *  unreachable degrade: no value published rather than a dead link. */
      {
        entity: ruleTriggerEntity(rule.id, 'image'),
        platform: 'image',
        label: `${rule.name} last trigger image`,
      },
    ]),
  ]
}

function serverSpecs(input: SyntheticInput): readonly SyntheticSpec[] {
  return [
    {
      entity: 'cluster_healthy',
      platform: 'binary_sensor',
      label: 'Cluster healthy',
      // NO `device_class: problem`. That class is INVERTED by contract — `on`
      // means there IS a problem — and the spec asks for `cluster_healthy`,
      // off when any node is offline. Pairing the positive name with the
      // inverted class would put a red badge on a working cluster and read as
      // healthy on a broken one. The name is the spec's; the semantics follow
      // the name.
      icon: 'mdi:server-network',
    },
    { entity: 'nodes_online', platform: 'sensor', label: 'Nodes online', icon: 'mdi:server' },
    { entity: 'nodes_total', platform: 'sensor', label: 'Nodes total', icon: 'mdi:server' },
    {
      entity: 'addons_healthy',
      platform: 'binary_sensor',
      label: 'Addons healthy',
      icon: 'mdi:puzzle-check',
    },
    { entity: 'addons_running', platform: 'sensor', label: 'Addons running', icon: 'mdi:puzzle' },
    {
      entity: 'addons_failed',
      platform: 'sensor',
      label: 'Addons failed',
      icon: 'mdi:puzzle-remove',
    },
    {
      entity: 'server_version',
      platform: 'sensor',
      label: 'Server version',
      icon: 'mdi:tag',
      entityCategory: 'diagnostic',
    },
    {
      entity: 'update_available',
      platform: 'binary_sensor',
      label: 'Update available',
      deviceClass: 'update',
      entityCategory: 'diagnostic',
    },
    /**
     * The conditions nobody said (Task D1) — `alerts.list`'s active,
     * warning-or-error findings. `info` never raises `alerts_active` or
     * inflates the count: a badge that lights up on `info` teaches an
     * operator to ignore it, which is how the four-hour blackout stayed
     * quiet through every liveness finding it produced.
     */
    {
      entity: 'alerts_active',
      platform: 'binary_sensor',
      label: 'Alerts active',
      deviceClass: 'problem',
    },
    {
      entity: 'alerts_active_count',
      platform: 'sensor',
      label: 'Active alerts',
      icon: 'mdi:alert',
    },
    {
      entity: 'alerts_last_title',
      platform: 'sensor',
      label: 'Last active alert',
      icon: 'mdi:alert-circle-outline',
      entityCategory: 'diagnostic',
    },
    /** The oldest footage across the whole cluster (Task D2). */
    {
      entity: 'oldest_footage',
      platform: 'sensor',
      label: 'Oldest footage',
      deviceClass: 'timestamp',
      entityCategory: 'diagnostic',
    },
    /**
     * The seed-vs-contract verdict (Task D3, D3's `image_contract`) — the
     * 2026-08-02 guasto, where `runningVersion` was current while the
     * container image was weeks old from a renamed repository nothing
     * rebuilt. Hub only: it describes THIS process's own image.
     */
    {
      entity: 'image_contract',
      platform: 'sensor',
      label: 'Image contract',
      icon: 'mdi:package-variant-closed-check',
      entityCategory: 'diagnostic',
    },
    /**
     * Per NODE, on the ONE device rather than a device per node. Nodes are few
     * and stable, and a device per node would double the export's identity
     * problem for no gain (spec).
     */
    ...input.nodes.flatMap((node): readonly SyntheticSpec[] => {
      const slug = toSlug(node.id)
      return [
        {
          entity: `${slug}_online`,
          platform: 'binary_sensor',
          label: `${node.name} online`,
          deviceClass: 'connectivity',
        },
        {
          entity: `${slug}_cpu`,
          platform: 'sensor',
          label: `${node.name} CPU`,
          unit: '%',
          icon: 'mdi:cpu-64-bit',
        },
        {
          entity: `${slug}_memory`,
          platform: 'sensor',
          label: `${node.name} memory`,
          unit: '%',
          icon: 'mdi:memory',
        },
        {
          entity: `${slug}_uptime`,
          platform: 'sensor',
          label: `${node.name} uptime`,
          deviceClass: 'timestamp',
        },
        /** The disk (Task D2) — every node, hub included: every node records. */
        {
          entity: `${slug}_footage_used_bytes`,
          platform: 'sensor',
          label: `${node.name} footage used`,
          deviceClass: 'data_size',
          unit: 'B',
          entityCategory: 'diagnostic',
        },
        {
          entity: `${slug}_footage_free_percent`,
          platform: 'sensor',
          label: `${node.name} footage free`,
          unit: '%',
          icon: 'mdi:harddisk',
          entityCategory: 'diagnostic',
        },
        /**
         * The agents that stay behind (Task D3) — never the hub, which
         * already carries `server_version` / `update_available` of its own;
         * a second pair saying the same thing is a second pair that can
         * disagree with the first.
         */
        ...(node.isHub
          ? []
          : ([
              {
                entity: `${slug}_version`,
                platform: 'sensor',
                label: `${node.name} version`,
                icon: 'mdi:tag',
                entityCategory: 'diagnostic',
              },
              {
                entity: `${slug}_update_available`,
                platform: 'binary_sensor',
                label: `${node.name} update available`,
                deviceClass: 'update',
                entityCategory: 'diagnostic',
              },
            ] satisfies readonly SyntheticSpec[])),
      ]
    }),
  ]
}

/** Every synthetic device, in declaration order. */
export function syntheticPlans(input: SyntheticInput): readonly HaDevicePlan[] {
  return [
    plan(NOTIFICATION_CENTER_STABLE_ID, 'Notification Center', notificationCenterSpecs(input)),
    plan(SERVER_STABLE_ID, 'CamStack Server', serverSpecs(input)),
  ]
}

// ── Projection ──────────────────────────────────────────────────────────

export interface SyntheticStateValue {
  readonly topic: string
  readonly value: string
}

/**
 * The four state facts plus the picture, shared by the GLOBAL `last_trigger_*`
 * entities and every per-rule `rule_<slug>_last_trigger_*` one. `entityFor` is
 * the SAME function that named the entity in `notificationCenterSpecs` — a
 * `sensor` whose declared `state_topic` and its published topic come from two
 * different expressions is exactly the class of bug
 * `camera-entity-feeds.spec.ts` exists to catch on the camera side.
 */
function projectTriggerFacts(
  deviceKey: string,
  entityFor: (suffix: RuleTriggerSuffix) => string,
  t: SyntheticLastTrigger,
): readonly SyntheticStateValue[] {
  const values: SyntheticStateValue[] = [
    { topic: stateTopic(deviceKey, entityFor('at')), value: new Date(t.at).toISOString() },
    { topic: stateTopic(deviceKey, entityFor('camera')), value: t.deviceName },
    { topic: stateTopic(deviceKey, entityFor('label')), value: t.label },
    { topic: stateTopic(deviceKey, entityFor('status')), value: t.status },
  ]
  // The DECLARED degrade (`SyntheticLastTrigger.imageUrl`'s docblock): no
  // value published, ever, for a URL this pass could not mint — never a
  // link that 404s. The entity then holds its previous known picture (or
  // `unknown` if it never had one) until a later pass mints a fresh one.
  if (t.imageUrl !== null) {
    values.push({ topic: stateTopic(deviceKey, entityFor('image')), value: t.imageUrl })
  }
  return values
}

/**
 * Every synthetic value, for the reconcile to push.
 *
 * Uptime is published as an ISO timestamp of the BOOT INSTANT, not as a
 * seconds counter: HA's `timestamp` device class renders "3 days ago" and keeps
 * doing so between reconciles, whereas a seconds number would sit frozen at
 * whatever it was 300 seconds ago and read as a stalled machine.
 */
export function projectSynthetic(
  input: SyntheticInput,
  nowMs: number,
): readonly SyntheticStateValue[] {
  const nc = syntheticDeviceKeyFor(NOTIFICATION_CENTER_STABLE_ID)
  const srv = syntheticDeviceKeyFor(SERVER_STABLE_ID)
  const online = input.nodes.filter((node) => node.online)

  const values: SyntheticStateValue[] = [
    {
      topic: stateTopic(nc, 'rules_enabled'),
      value: String(input.rules.filter((rule) => rule.enabled).length),
    },
    ...input.rules.map((rule) => ({
      topic: stateTopic(nc, ruleEntity(rule.id)),
      value: String(rule.enabled),
    })),
    // Positive polarity, matching the entity's NAME: on = every node is up.
    {
      topic: stateTopic(srv, 'cluster_healthy'),
      value: String(online.length === input.nodes.length),
    },
    { topic: stateTopic(srv, 'nodes_online'), value: String(online.length) },
    { topic: stateTopic(srv, 'nodes_total'), value: String(input.nodes.length) },
    { topic: stateTopic(srv, 'addons_healthy'), value: String(input.addonsFailed === 0) },
    { topic: stateTopic(srv, 'addons_running'), value: String(input.addonsRunning) },
    { topic: stateTopic(srv, 'addons_failed'), value: String(input.addonsFailed) },
    { topic: stateTopic(srv, 'server_version'), value: input.serverVersion },
    { topic: stateTopic(srv, 'update_available'), value: String(input.updateAvailable) },
    { topic: stateTopic(srv, 'alerts_active'), value: String(input.alertsActive) },
    { topic: stateTopic(srv, 'alerts_active_count'), value: String(input.alertsActiveCount) },
  ]

  // The last trigger, five facts plus its picture — absent entirely when
  // nothing has fired yet (or the read failed this pass), which leaves every
  // one of the six entities at `unknown` rather than at an invented value.
  if (input.lastTrigger !== null) {
    values.push({ topic: stateTopic(nc, 'last_trigger_rule'), value: input.lastTrigger.ruleName })
    values.push(...projectTriggerFacts(nc, (suffix) => `last_trigger_${suffix}`, input.lastTrigger))
  }

  // The per-rule last trigger — the SAME four facts plus picture, on the
  // SAME entity-naming function (`ruleTriggerEntity`) that declared the
  // entity in `notificationCenterSpecs`, so a topic here can never drift
  // from what was announced. A rule with no entry in `lastTriggerByRule`
  // publishes NOTHING: `unknown`, never an invented value — this includes a
  // rule that has never fired, and a DISABLED rule keeps its entities (see
  // `SyntheticInput.lastTriggerByRule`'s docblock): `enabled` never gates
  // whether the entity exists, only whether new triggers keep feeding it.
  for (const rule of input.rules) {
    const t = input.lastTriggerByRule.get(rule.id)
    if (t === undefined) continue
    values.push(...projectTriggerFacts(nc, (suffix) => ruleTriggerEntity(rule.id, suffix), t))
  }

  // Never `''`: HA renders an empty string as a valid state, so "no alert" has
  // to be silence on this one topic rather than a blank sensor.
  if (input.alertsLastTitle !== null) {
    values.push({ topic: stateTopic(srv, 'alerts_last_title'), value: input.alertsLastTitle })
  }
  if (input.oldestFootageMs !== null) {
    values.push({
      topic: stateTopic(srv, 'oldest_footage'),
      value: new Date(input.oldestFootageMs).toISOString(),
    })
  }
  if (input.imageContractState !== null) {
    values.push({ topic: stateTopic(srv, 'image_contract'), value: input.imageContractState })
  }

  for (const node of input.nodes) {
    const slug = toSlug(node.id)
    values.push(
      { topic: stateTopic(srv, `${slug}_online`), value: String(node.online) },
      { topic: stateTopic(srv, `${slug}_cpu`), value: String(Math.round(node.cpuPercent)) },
      { topic: stateTopic(srv, `${slug}_memory`), value: String(Math.round(node.memoryPercent)) },
    )
    // A node that is offline has no meaningful boot instant to publish, and a
    // stale one would read as an uptime that keeps growing while the machine is
    // down. Absent renders as `unknown`, which is what it is.
    if (node.online && node.uptimeMs > 0) {
      values.push({
        topic: stateTopic(srv, `${slug}_uptime`),
        value: new Date(nowMs - node.uptimeMs).toISOString(),
      })
    }
    // `locations` is optional on the wire (D2): a hub on an older train never
    // sends it, and no `NaN`/`0` may stand in for "disk fill unknown" — `0`
    // reads as "the disk is full", the opposite of the truth.
    if (node.footageUsedBytes !== null) {
      values.push({
        topic: stateTopic(srv, `${slug}_footage_used_bytes`),
        value: String(node.footageUsedBytes),
      })
    }
    if (node.footageFreePercent !== null) {
      values.push({
        topic: stateTopic(srv, `${slug}_footage_free_percent`),
        value: String(Math.round(node.footageFreePercent * 10) / 10),
      })
    }
    if (!node.isHub) {
      if (node.rootPackageVersion !== null) {
        values.push({ topic: stateTopic(srv, `${slug}_version`), value: node.rootPackageVersion })
      }
      if (node.updateAvailable !== null) {
        values.push({
          topic: stateTopic(srv, `${slug}_update_available`),
          value: String(node.updateAvailable),
        })
      }
    }
  }
  return values
}
