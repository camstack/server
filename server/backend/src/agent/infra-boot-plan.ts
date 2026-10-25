/**
 * Plan the infra boot pass: which addon serves each capability, and — the
 * part that took two agents down on 2026-08-08 — which of those entries
 * actually INITIALIZES the addon.
 *
 * `INFRA_CAPABILITIES` is a list of CAPABILITIES, and since D44 one addon
 * legitimately serves several of them (`storage-orchestrator` owns both
 * `storage` and `settings-store` — the list's own comment says the second
 * entry exists so "a deployment missing the door fails here, loudly", i.e.
 * it expects the addon to ALREADY be booted). The boot loop instead did
 * `new addonClass()` + `initialize()` once PER CAPABILITY: the second
 * initialize re-registered the same provider, `CapabilityRegistry` threw
 * its double-registration error, and — with the D87 guard promoting a
 * required-infra failure to a boot abort — every agent whose builtins
 * carried D44 crash-looped on 1.2.74 until rolled back.
 *
 * Resolution stays per-capability (the guard needs every missing required
 * cap named); initialization is deduped per ADDON, first capability wins.
 */
import type { InfraCapability } from '@camstack/system'
import type { InfraResolution } from './infra-boot-guard.js'

/** The subset of a loaded addon declaration this planner reads. */
export interface PlannableAddon {
  readonly id: string
  readonly capabilities: readonly string[]
}

export interface InfraBootStep {
  readonly capName: string
  readonly required: boolean
  /** `null` when no installed addon declares the capability. */
  readonly addonId: string | null
  /**
   * True on the FIRST step naming this addon — the only step that
   * constructs and initializes it. Later steps for the same addon are
   * resolution-only: the capability is served by an instance that already
   * registered its providers.
   */
  readonly initialize: boolean
}

/**
 * `log-destination` prefers `hub-forwarder` (ships agent logs to the hub)
 * over a local winston — mirrors the historical inline choice.
 */
function pickCandidate(
  capName: string,
  candidates: readonly PlannableAddon[],
): PlannableAddon | undefined {
  if (capName === 'log-destination') {
    return candidates.find((a) => a.id === 'hub-forwarder') ?? candidates[0]
  }
  return candidates[0]
}

export function planInfraBoot(
  addons: readonly PlannableAddon[],
  infraList: readonly InfraCapability[],
): readonly InfraBootStep[] {
  const initialized = new Set<string>()
  const steps: InfraBootStep[] = []
  for (const infra of infraList) {
    const candidates = addons.filter((a) => a.capabilities.includes(infra.name))
    const chosen = pickCandidate(infra.name, candidates)
    if (!chosen) {
      steps.push({
        capName: infra.name,
        required: infra.required,
        addonId: null,
        initialize: false,
      })
      continue
    }
    const first = !initialized.has(chosen.id)
    if (first) initialized.add(chosen.id)
    steps.push({
      capName: infra.name,
      required: infra.required,
      addonId: chosen.id,
      initialize: first,
    })
  }
  return steps
}

/** Project a plan onto the guard's resolution shape. */
export function planToResolutions(steps: readonly InfraBootStep[]): InfraResolution[] {
  return steps.map((s) => ({ name: s.capName, required: s.required, addonId: s.addonId }))
}
