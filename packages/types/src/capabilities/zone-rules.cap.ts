import { z } from 'zod'
import { method, type CapabilityDefinition, type InferProvider } from './capability-definition.js'
import { DeviceType } from '../device/device-type.js'
import { ZoneRuleSchema } from './schemas/zone-rule.js'

/**
 * Stages a {@link ZoneRule} can apply to. Discriminator on the rules
 * cap so a single CRUD surface backs every consumer; each stage has
 * its own dev-state mirror slice (`motion-zone-rules`,
 * `detection-zone-rules`, …) so consumer addons subscribe independently.
 *
 * Extend the enum here when a new gating consumer comes online (audio
 * gating, alert filtering, …) — no other surface needs to change.
 */
export const ZoneRuleStageEnum = z.enum(['motion', 'detection', 'package'])
export type ZoneRuleStage = z.infer<typeof ZoneRuleStageEnum>

/**
 * Zone rules capability — per-camera CRUD over the {@link ZoneRule}
 * arrays that decide how each pipeline stage uses the polygon zones.
 *
 * Hosted by `addon-pipeline-orchestrator` alongside the zones provider
 * so the operator has a single hub-side source of truth for both
 * geometry and behaviour. Per-stage rules are stored under the
 * `zoneRules.<stage>` key in the orchestrator's per-device store and
 * mirrored to the device-state slice `<stage>-zone-rules` on every
 * mutation; consumer addons (analytics, motion-wasm, pipeline-executor)
 * subscribe to that slice and refresh their gating without
 * round-tripping the cap.
 *
 * Sets are bulk-replace — the operator UI sends the new rule list
 * wholesale, so reordering / batch enable-toggle / drag-drop CRUD lives
 * naturally in the rule editor without per-rule mutation chatter.
 */
export const zoneRulesCapability = {
  name: 'zone-rules',
  scope: 'device',
  mode: 'singleton',
  deviceTypes: [DeviceType.Camera],
  methods: {
    /** Read the full rule list for a given stage (empty when no rules
     *  are defined yet). */
    listRules: method(
      z.object({ deviceId: z.number(), stage: ZoneRuleStageEnum }),
      z.array(ZoneRuleSchema).readonly(),
    ),
    /** Bulk-replace the rule list for one stage. The provider validates
     *  each entry against {@link ZoneRuleSchema} (zoneIds non-empty,
     *  thresholds in range) and rejects the whole patch if any entry
     *  is invalid — partial writes are a configuration footgun. */
    setRules: method(
      z.object({
        deviceId: z.number(),
        stage: ZoneRuleStageEnum,
        rules: z.array(ZoneRuleSchema).readonly(),
      }),
      z.void(),
      { kind: 'mutation', auth: 'admin' },
    ),
  },
  /**
   * Runtime-state slice — every stage mirrored together so consumers
   * see one reactive handle (`device.state.zoneRules.value`) instead
   * of one per stage. Bulk-replace mutations on any stage write the full
   * `{motion, detection, package}` shape, so subscribers always get the
   * complete current set. Consumers that only care about one stage
   * just read the matching property.
   *
   * `package` backs the package-drop detector — a package zone is a
   * `ZoneRule` on the `'package'` stage referencing drawn polygons
   * (see docs/superpowers/specs/2026-07-17-package-zones-design.md §3.1).
   * The orchestrator provider writes this stage as a first-class slice
   * (Phase 4): every mutation mirrors the full `{motion, detection,
   * package}` shape, so consumers read the current package rules directly
   * off `device.state.zoneRules.value.package`.
   */
  runtimeState: z.object({
    motion: z.array(ZoneRuleSchema).readonly(),
    detection: z.array(ZoneRuleSchema).readonly(),
    package: z.array(ZoneRuleSchema).readonly(),
  }),

  /**
   * Runtime-state durability: **restored** — operator intent, mutation-only, same argument as `zones`.
   *
   * See `RuntimeStateDurability`. Enforced by
   * `scripts/check-runtime-state-durability.ts`.
   */
  durability: 'restored',
  /**
   * History (D850): none — configuration arrays.
   */
  history: 'none',
} as const satisfies CapabilityDefinition

export type IZoneRulesProvider = InferProvider<typeof zoneRulesCapability>
