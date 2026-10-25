import { describe, expect, it } from 'vitest'
import {
  deriveAlertSummary,
  isSyntheticDeviceKey,
  NOTIFICATION_CENTER_STABLE_ID,
  projectSynthetic,
  ruleEntity,
  ruleIdFromEntity,
  SERVER_STABLE_ID,
  type AlertSummaryInput,
  type SyntheticInput,
  syntheticPlans,
} from '../synthetic-devices.js'

const INPUT: SyntheticInput = {
  rules: [
    { id: 'rule-driveway', name: 'Persona su Uscio', enabled: true },
    { id: 'rule-garden', name: 'Animale su Aiuola', enabled: false },
  ],
  lastTrigger: null,
  lastTriggerByRule: new Map(),
  nodes: [
    {
      id: 'hub',
      name: 'Hub',
      online: true,
      cpuPercent: 41.6,
      memoryPercent: 77.2,
      uptimeMs: 3_600_000,
      isHub: true,
      footageUsedBytes: 128_000_000_000,
      footageFreePercent: 42.3,
      rootPackageVersion: '1.2.86',
      updateAvailable: false,
    },
    {
      id: 'agent-a',
      name: 'ci-runner',
      online: false,
      cpuPercent: 0,
      memoryPercent: 0,
      uptimeMs: 0,
      isHub: false,
      footageUsedBytes: null,
      footageFreePercent: null,
      rootPackageVersion: null,
      updateAvailable: null,
    },
  ],
  addonsRunning: 62,
  addonsFailed: 1,
  serverVersion: '1.2.86',
  updateAvailable: false,
  alertsActive: false,
  alertsActiveCount: 0,
  alertsLastTitle: null,
  oldestFootageMs: null,
  imageContractState: null,
}

const NOW = 1786288056692

function at(
  values: readonly { topic: string; value: string }[],
  topic: string,
): string | undefined {
  return values.find((v) => v.topic === topic)?.value
}

describe('syntheticPlans', () => {
  it('builds a LIST of devices, each with its own identity', () => {
    const plans = syntheticPlans(INPUT)
    expect(plans.map((p) => p.dev.name)).toEqual(['Notification Center', 'CamStack Server'])
    expect(plans.every((p) => p.deviceId === null)).toBe(true)
    expect(plans[0]?.deviceKey).toBe(`camstack-${NOTIFICATION_CENTER_STABLE_ID}`)
    expect(plans[1]?.deviceKey).toBe(`camstack-${SERVER_STABLE_ID}`)
  })

  it('gives every notification rule a writable switch', () => {
    const nc = syntheticPlans(INPUT)[0]
    const keys = Object.keys(nc?.cmps ?? {})
    expect(keys).toContain('switch-rule-rule-driveway')
    expect(nc?.cmps['switch-rule-rule-driveway']?.command_topic).toBeDefined()
  })

  /**
   * A renamed rule must keep its automations. The identity comes from the rule
   * ID; the name is only the friendly label.
   */
  it('derives the unique_id from the rule ID, never its name', () => {
    const renamed = syntheticPlans({
      ...INPUT,
      rules: [{ id: 'rule-driveway', name: 'COMPLETELY DIFFERENT', enabled: true }],
    })[0]
    expect(renamed?.cmps['switch-rule-rule-driveway']?.unique_id).toBe(
      `${NOTIFICATION_CENTER_STABLE_ID}_${ruleEntity('rule-driveway')}`,
    )
  })

  it('puts every node on ONE device rather than a device per node', () => {
    const srv = syntheticPlans(INPUT)[1]
    const keys = Object.keys(srv?.cmps ?? {})
    expect(keys).toContain('binary_sensor-hub-online')
    expect(keys).toContain('binary_sensor-agent-a-online')
    expect(syntheticPlans(INPUT)).toHaveLength(2)
  })

  /**
   * The count that decides whether this design is good (operator constraint,
   * 2026-08-25): a handful on ONE device, never one per camera or per rule.
   * Six FIXED entities — the two rule/select controls plus the per-rule
   * switch fan-out (already existed) are untouched by this count.
   */
  /** The GLOBAL six live at `<platform>-last-trigger-*`; every per-rule one
   *  is `<platform>-rule-<slug>-last-trigger-*` — the `-rule-` segment tells
   *  them apart without depending on rule-id naming in the fixture. */
  const isGlobalLastTrigger = (k: string): boolean =>
    k.includes('last-trigger') && !k.includes('-rule-')

  it('adds exactly six fixed last-trigger entities, none of them per-camera or per-rule', () => {
    const nc = syntheticPlans(INPUT)[0]
    const lastTriggerKeys = Object.keys(nc?.cmps ?? {}).filter(isGlobalLastTrigger)
    expect(lastTriggerKeys.sort()).toEqual(
      [
        'sensor-last-trigger-at',
        'sensor-last-trigger-camera',
        'sensor-last-trigger-label',
        'sensor-last-trigger-rule',
        'sensor-last-trigger-status',
        'image-last-trigger-image',
      ].sort(),
    )
    // Same six regardless of how many rules exist — proof there is no
    // per-rule or per-camera fan-out hiding in THIS set (the per-rule set is
    // its own, tested below).
    const manyRules = syntheticPlans({
      ...INPUT,
      rules: Array.from({ length: 40 }, (_, i) => ({
        id: `rule-${i}`,
        name: `Rule ${i}`,
        enabled: true,
      })),
    })[0]
    const withManyRules = Object.keys(manyRules?.cmps ?? {}).filter(isGlobalLastTrigger)
    expect(withManyRules).toHaveLength(6)
  })

  /**
   * The property the operator's task pins (2026-08-27): the per-rule last
   * trigger scales with the RULE count, never with cameras — this module
   * takes no camera/`deviceId` dimension at all in `SyntheticInput`, so a
   * camera fleet of any size cannot move this number. Five entities
   * (`at`/`camera`/`label`/`status`/`image`) per rule, growing linearly.
   */
  it('adds exactly five last-trigger entities PER RULE, scaling linearly with rule count', () => {
    const isRuleLastTrigger = (k: string): boolean =>
      k.includes('last-trigger') && k.includes('-rule-')

    // INPUT has two rules.
    expect(
      Object.keys(syntheticPlans(INPUT)[0]?.cmps ?? {}).filter(isRuleLastTrigger),
    ).toHaveLength(2 * 5)

    for (const ruleCount of [5, 15, 40]) {
      const nc = syntheticPlans({
        ...INPUT,
        rules: Array.from({ length: ruleCount }, (_, i) => ({
          id: `rule-${i}`,
          name: `Rule ${i}`,
          enabled: true,
        })),
      })[0]
      const keys = Object.keys(nc?.cmps ?? {}).filter(isRuleLastTrigger)
      expect(keys).toHaveLength(ruleCount * 5)
    }
  })

  /**
   * A disabled rule keeps its entities declared — same identity rule as the
   * switch, so disabling a rule never orphans an automation pointed at its
   * last-trigger sensors. Only the STATE goes stale (tested in
   * `projectSynthetic`, below); the entity itself never disappears.
   */
  it('declares the switch AND the five trigger entities for a DISABLED rule', () => {
    const disabled = syntheticPlans({
      ...INPUT,
      rules: [{ id: 'rule-off', name: 'Off rule', enabled: false }],
    })[0]
    const keys = Object.keys(disabled?.cmps ?? {})
    expect(keys).toContain('switch-rule-rule-off')
    expect(keys).toContain('sensor-rule-rule-off-last-trigger-at')
    expect(keys).toContain('sensor-rule-rule-off-last-trigger-camera')
    expect(keys).toContain('sensor-rule-rule-off-last-trigger-label')
    expect(keys).toContain('sensor-rule-rule-off-last-trigger-status')
    expect(keys).toContain('image-rule-rule-off-last-trigger-image')
  })
})

describe('projectSynthetic', () => {
  it('reports rule state and the enabled count', () => {
    const v = projectSynthetic(INPUT, NOW)
    const nc = `camstack-${NOTIFICATION_CENTER_STABLE_ID}`
    expect(at(v, `camstack/${nc}/${ruleEntity('rule-driveway')}`)).toBe('true')
    expect(at(v, `camstack/${nc}/${ruleEntity('rule-garden')}`)).toBe('false')
    expect(at(v, `camstack/${nc}/rules_enabled`)).toBe('1')
  })

  /**
   * Positive polarity, matching the entity NAME. Pairing `cluster_healthy`
   * with HA's inverted `problem` device class would put a red badge on a
   * working cluster — the reason that class is deliberately not declared.
   */
  it('is healthy only when every node is up', () => {
    const srv = `camstack-${SERVER_STABLE_ID}`
    expect(at(projectSynthetic(INPUT, NOW), `camstack/${srv}/cluster_healthy`)).toBe('false')
    expect(at(projectSynthetic(INPUT, NOW), `camstack/${srv}/nodes_online`)).toBe('1')
    expect(at(projectSynthetic(INPUT, NOW), `camstack/${srv}/nodes_total`)).toBe('2')

    const allUp = projectSynthetic(
      { ...INPUT, nodes: INPUT.nodes.map((n) => ({ ...n, online: true })) },
      NOW,
    )
    expect(at(allUp, `camstack/${srv}/cluster_healthy`)).toBe('true')
  })

  it('is addon-healthy only with zero failures', () => {
    const srv = `camstack-${SERVER_STABLE_ID}`
    expect(at(projectSynthetic(INPUT, NOW), `camstack/${srv}/addons_healthy`)).toBe('false')
    expect(
      at(projectSynthetic({ ...INPUT, addonsFailed: 0 }, NOW), `camstack/${srv}/addons_healthy`),
    ).toBe('true')
  })

  /**
   * The BOOT INSTANT, not a seconds counter: HA's timestamp class renders
   * "1 hour ago" and keeps counting between reconciles, whereas a number would
   * sit frozen for 300s and read as a stalled machine.
   */
  it('publishes uptime as the boot instant, and none for an offline node (topology uptime is MILLISECONDS)', () => {
    const v = projectSynthetic(INPUT, NOW)
    const srv = `camstack-${SERVER_STABLE_ID}`
    expect(at(v, `camstack/${srv}/hub_uptime`)).toBe(new Date(NOW - 3_600_000).toISOString())
    expect(at(v, `camstack/${srv}/agent_a_uptime`)).toBeUndefined()
  })

  it('the boot instant does not move between two passes five minutes apart', () => {
    const later = {
      ...INPUT,
      nodes: INPUT.nodes.map((n) => (n.online ? { ...n, uptimeMs: n.uptimeMs + 300_000 } : n)),
    }
    const srv = `camstack-${SERVER_STABLE_ID}`
    const a = at(projectSynthetic(INPUT, NOW), `camstack/${srv}/hub_uptime`)
    const b = at(projectSynthetic(later, NOW + 300_000), `camstack/${srv}/hub_uptime`)
    expect(b).toBe(a)
  })

  describe('alerts (Task D1)', () => {
    const srv = `camstack-${SERVER_STABLE_ID}`

    it('no alert publishes false, 0, and no last_title — never an empty string', () => {
      const v = projectSynthetic(INPUT, NOW)
      expect(at(v, `camstack/${srv}/alerts_active`)).toBe('false')
      expect(at(v, `camstack/${srv}/alerts_active_count`)).toBe('0')
      expect(at(v, `camstack/${srv}/alerts_last_title`)).toBeUndefined()
    })

    it('publishes the active count and the last title when there are alerts', () => {
      const v = projectSynthetic(
        { ...INPUT, alertsActive: true, alertsActiveCount: 2, alertsLastTitle: 'Disk almost full' },
        NOW,
      )
      expect(at(v, `camstack/${srv}/alerts_active`)).toBe('true')
      expect(at(v, `camstack/${srv}/alerts_active_count`)).toBe('2')
      expect(at(v, `camstack/${srv}/alerts_last_title`)).toBe('Disk almost full')
    })
  })

  describe('disk (Task D2)', () => {
    const srv = `camstack-${SERVER_STABLE_ID}`

    it('publishes per-node footage only when it could be read, never a guessed 0', () => {
      const v = projectSynthetic(INPUT, NOW)
      expect(at(v, `camstack/${srv}/hub_footage_used_bytes`)).toBe('128000000000')
      expect(at(v, `camstack/${srv}/hub_footage_free_percent`)).toBe('42.3')
      expect(at(v, `camstack/${srv}/agent_a_footage_used_bytes`)).toBeUndefined()
      expect(at(v, `camstack/${srv}/agent_a_footage_free_percent`)).toBeUndefined()
    })

    it('publishes oldest_footage only when a minimum could be computed', () => {
      expect(at(projectSynthetic(INPUT, NOW), `camstack/${srv}/oldest_footage`)).toBeUndefined()
      const withOldest = projectSynthetic({ ...INPUT, oldestFootageMs: NOW - 86_400_000 }, NOW)
      expect(at(withOldest, `camstack/${srv}/oldest_footage`)).toBe(
        new Date(NOW - 86_400_000).toISOString(),
      )
    })
  })

  describe('node updates and image contract (Task D3)', () => {
    const srv = `camstack-${SERVER_STABLE_ID}`

    it('publishes version and update_available for a non-hub node only', () => {
      const v = projectSynthetic(
        {
          ...INPUT,
          nodes: INPUT.nodes.map((n) =>
            n.id === 'agent-a' ? { ...n, rootPackageVersion: '1.2.80', updateAvailable: true } : n,
          ),
        },
        NOW,
      )
      expect(at(v, `camstack/${srv}/agent_a_version`)).toBe('1.2.80')
      expect(at(v, `camstack/${srv}/agent_a_update_available`)).toBe('true')
      // The hub never gets these two — it already has server_version /
      // update_available of its own, and a second pair can disagree with it.
      expect(at(v, `camstack/${srv}/hub_version`)).toBeUndefined()
      expect(at(v, `camstack/${srv}/hub_update_available`)).toBeUndefined()
    })

    it('publishes image_contract only when the hub answered with one', () => {
      expect(at(projectSynthetic(INPUT, NOW), `camstack/${srv}/image_contract`)).toBeUndefined()
      const withContract = projectSynthetic({ ...INPUT, imageContractState: 'behind-series' }, NOW)
      expect(at(withContract, `camstack/${srv}/image_contract`)).toBe('behind-series')
    })
  })

  describe('last trigger', () => {
    const nc = `camstack-${NOTIFICATION_CENTER_STABLE_ID}`
    const TRIGGER_AT = NOW - 42_000

    it('publishes nothing at all when nothing has fired yet — every entity stays unknown', () => {
      const v = projectSynthetic(INPUT, NOW)
      expect(at(v, `camstack/${nc}/last_trigger_at`)).toBeUndefined()
      expect(at(v, `camstack/${nc}/last_trigger_rule`)).toBeUndefined()
      expect(at(v, `camstack/${nc}/last_trigger_camera`)).toBeUndefined()
      expect(at(v, `camstack/${nc}/last_trigger_label`)).toBeUndefined()
      expect(at(v, `camstack/${nc}/last_trigger_status`)).toBeUndefined()
      expect(at(v, `camstack/${nc}/last_trigger_image`)).toBeUndefined()
    })

    it('publishes the five facts when a trigger is known', () => {
      const v = projectSynthetic(
        {
          ...INPUT,
          lastTrigger: {
            at: TRIGGER_AT,
            ruleName: 'Persona su Uscio',
            deviceName: 'Front door',
            label: 'Alice',
            status: 'sent',
            imageUrl: 'https://hub.lan:4443/addon/pipeline-analytics/nc-artifact/a?exp=1&sig=x',
          },
        },
        NOW,
      )
      expect(at(v, `camstack/${nc}/last_trigger_at`)).toBe(new Date(TRIGGER_AT).toISOString())
      expect(at(v, `camstack/${nc}/last_trigger_rule`)).toBe('Persona su Uscio')
      expect(at(v, `camstack/${nc}/last_trigger_camera`)).toBe('Front door')
      expect(at(v, `camstack/${nc}/last_trigger_label`)).toBe('Alice')
      expect(at(v, `camstack/${nc}/last_trigger_status`)).toBe('sent')
      expect(at(v, `camstack/${nc}/last_trigger_image`)).toBe(
        'https://hub.lan:4443/addon/pipeline-analytics/nc-artifact/a?exp=1&sig=x',
      )
    })

    it('falls back the label to the detected class when no identity was resolved', () => {
      const v = projectSynthetic(
        {
          ...INPUT,
          lastTrigger: {
            at: TRIGGER_AT,
            ruleName: 'Animale su Aiuola',
            deviceName: 'Garden',
            label: 'cat',
            status: 'pending',
            imageUrl: null,
          },
        },
        NOW,
      )
      expect(at(v, `camstack/${nc}/last_trigger_label`)).toBe('cat')
    })

    /**
     * The DECLARED degrade (2026-08-26): an artefact this pass could not
     * resolve a URL for (expired, pruned, or unreachable install) publishes
     * NOTHING on `last_trigger_image` — never a broken link. The other five
     * facts still move; only the picture holds its previous known state.
     */
    it('never publishes a broken image link — an unresolved artefact leaves the image entity alone', () => {
      const v = projectSynthetic(
        {
          ...INPUT,
          lastTrigger: {
            at: TRIGGER_AT,
            ruleName: 'Persona su Uscio',
            deviceName: 'Front door',
            label: 'person',
            status: 'sent',
            imageUrl: null,
          },
        },
        NOW,
      )
      expect(at(v, `camstack/${nc}/last_trigger_rule`)).toBe('Persona su Uscio')
      expect(at(v, `camstack/${nc}/last_trigger_image`)).toBeUndefined()
    })
  })

  /**
   * Per-rule last trigger (operator, 2026-08-27). Same shape and same
   * degrade rules as the global six above, minus `rule` (redundant — the
   * rule IS the device grouping) and keyed by rule id instead of the fixed
   * `last_trigger` prefix.
   */
  describe('per-rule last trigger', () => {
    const nc = `camstack-${NOTIFICATION_CENTER_STABLE_ID}`
    const TRIGGER_AT = NOW - 42_000
    const RULES: SyntheticInput['rules'] = [
      { id: 'rule-driveway', name: 'Persona su Uscio', enabled: true },
      { id: 'rule-garden', name: 'Animale su Aiuola', enabled: false },
    ]

    it('a rule with no history publishes nothing — stays unknown, never invented', () => {
      const v = projectSynthetic({ ...INPUT, rules: RULES }, NOW)
      for (const suffix of ['at', 'camera', 'label', 'status', 'image']) {
        expect(
          at(v, `camstack/${nc}/${ruleEntity('rule-driveway')}_last_trigger_${suffix}`),
        ).toBeUndefined()
      }
    })

    it('publishes the four facts plus image for the rule that has a trigger', () => {
      const v = projectSynthetic(
        {
          ...INPUT,
          rules: RULES,
          lastTriggerByRule: new Map([
            [
              'rule-driveway',
              {
                at: TRIGGER_AT,
                ruleName: 'Persona su Uscio',
                deviceName: 'Front door',
                label: 'Alice',
                status: 'sent',
                imageUrl: 'https://hub.lan:4443/addon/pipeline-analytics/nc-artifact/a?exp=1&sig=x',
              },
            ],
          ]),
        },
        NOW,
      )
      const base = `camstack/${nc}/${ruleEntity('rule-driveway')}_last_trigger`
      expect(at(v, `${base}_at`)).toBe(new Date(TRIGGER_AT).toISOString())
      expect(at(v, `${base}_camera`)).toBe('Front door')
      expect(at(v, `${base}_label`)).toBe('Alice')
      expect(at(v, `${base}_status`)).toBe('sent')
      expect(at(v, `${base}_image`)).toBe(
        'https://hub.lan:4443/addon/pipeline-analytics/nc-artifact/a?exp=1&sig=x',
      )
      // A DIFFERENT rule with no entry in the map is untouched.
      const gardenBase = `camstack/${nc}/${ruleEntity('rule-garden')}_last_trigger`
      expect(at(v, `${gardenBase}_at`)).toBeUndefined()
    })

    /** The same declared degrade as the global entity: no value for a URL
     *  this pass could not mint, ever — never a link that 404s. */
    it('never publishes a broken per-rule image link', () => {
      const v = projectSynthetic(
        {
          ...INPUT,
          rules: RULES,
          lastTriggerByRule: new Map([
            [
              'rule-driveway',
              {
                at: TRIGGER_AT,
                ruleName: 'Persona su Uscio',
                deviceName: 'Front door',
                label: 'person',
                status: 'sent',
                imageUrl: null,
              },
            ],
          ]),
        },
        NOW,
      )
      const base = `camstack/${nc}/${ruleEntity('rule-driveway')}_last_trigger`
      expect(at(v, `${base}_status`)).toBe('sent')
      expect(at(v, `${base}_image`)).toBeUndefined()
    })

    /**
     * A DISABLED rule's last known trigger keeps publishing — decided
     * explicitly (2026-08-27): the entity never disappears (see
     * `syntheticPlans`'s test above), and its state is the honest "here is
     * what it last did" rather than a value that vanishes the moment an
     * operator flips the switch off.
     */
    it('a disabled rule still publishes its last known trigger', () => {
      const v = projectSynthetic(
        {
          ...INPUT,
          rules: RULES,
          lastTriggerByRule: new Map([
            [
              'rule-garden',
              {
                at: TRIGGER_AT,
                ruleName: 'Animale su Aiuola',
                deviceName: 'Garden',
                label: 'cat',
                status: 'sent',
                imageUrl: null,
              },
            ],
          ]),
        },
        NOW,
      )
      expect(at(v, `camstack/${nc}/${ruleEntity('rule-garden')}_last_trigger_label`)).toBe('cat')
    })
  })
})

describe('command routing helpers', () => {
  it("recognises its own device keys and nobody else's", () => {
    expect(isSyntheticDeviceKey(`camstack-${SERVER_STABLE_ID}`)).toBe(true)
    expect(isSyntheticDeviceKey('camstack-reolink-101')).toBe(false)
  })

  it('turns a rule entity back into the rule id, and refuses an unknown one', () => {
    expect(ruleIdFromEntity(ruleEntity('rule-driveway'), INPUT.rules)).toBe('rule-driveway')
    expect(ruleIdFromEntity('rule_nope', INPUT.rules)).toBeNull()
  })
})

describe('deriveAlertSummary (Task D1)', () => {
  const alert = (over: Partial<AlertSummaryInput>): AlertSummaryInput => ({
    status: 'active',
    severity: 'warning',
    title: 'Disk almost full',
    updatedAt: 1000,
    ...over,
  })

  it('no alerts → false, 0, no title', () => {
    expect(deriveAlertSummary([])).toEqual({ active: false, count: 0, lastTitle: null })
  })

  it('an `info` alert raises neither the badge nor the count', () => {
    const summary = deriveAlertSummary([alert({ severity: 'info' })])
    expect(summary).toEqual({ active: false, count: 0, lastTitle: null })
  })

  it('a `dismissed` warning does not count — only `active` does', () => {
    const summary = deriveAlertSummary([alert({ status: 'dismissed' })])
    expect(summary).toEqual({ active: false, count: 0, lastTitle: null })
  })

  it('counts warning AND error, and titles the most recently updated one', () => {
    const summary = deriveAlertSummary([
      alert({ severity: 'warning', title: 'Older', updatedAt: 1000 }),
      alert({ severity: 'error', title: 'Newer', updatedAt: 2000 }),
      alert({ severity: 'info', title: 'Ignored' }),
    ])
    expect(summary).toEqual({ active: true, count: 2, lastTitle: 'Newer' })
  })
})
