/**
 * The runtime labels on a `pipeline stats` line (D463).
 *
 * These say WHICH accelerators and WHICH models produced the timings on the
 * same line. Without them an inference figure is unreadable: 300 ms means one
 * thing on a CPU fallback and another on an NPU.
 *
 * **Built from what is RESIDENT, never from what was configured.**
 * `getSelectedEngine` answers "what did this node select", and the first
 * version of this file printed that — `openvino/npu` on a hub that holds TWO
 * complete pools, `npu` (kind `runtime`) and `gpu` (kind `device-pool`), with
 * the same ten models in each. It named one and hid the other. A configured
 * value printed on a telemetry line reads as a measurement, and is not one.
 *
 * Pure on purpose: the read that feeds it is a cap call that can fail, and what
 * a FAILED read prints is exactly the decision worth pinning in a test. It
 * prints nothing — an absent field says "not known", where `null` had been
 * indistinguishable from "no engine at all".
 */

/** One pool currently resident, as `pipelineExecutor.listLoadedEngines` reports it. */
export interface ResidentEngine {
  readonly backend: string
  readonly device?: string
  /** `runtime` is the main camera-serving pool; the others run beside it. */
  readonly kind: 'runtime' | 'device-pool'
  readonly modelsLoaded: readonly string[]
}

export interface RuntimeLabels {
  readonly pipelineRuntime?: string
  readonly pipelineModels?: readonly string[]
}

/**
 * `null` means the read FAILED; `[]` means nothing is resident. Both omit the
 * fields, but they are different facts and the caller logs the failure.
 *
 * The `runtime` pool is named first because it is the one serving cameras; the
 * rest follow in arrival order. `python` is deliberately NOT printed: every
 * engine available on this cluster is python, and a token that cannot vary
 * costs a column and tells the reader nothing.
 */
export function buildRuntimeLabels(engines: readonly ResidentEngine[] | null): RuntimeLabels {
  if (engines === null || engines.length === 0) return {}

  // Runtime pool first, everything else in the order it arrived.
  const ordered = [
    ...engines.filter((e) => e.kind === 'runtime'),
    ...engines.filter((e) => e.kind !== 'runtime'),
  ]

  const devices = [...new Set(ordered.map((e) => e.device).filter((d): d is string => !!d))]
  const backends = [...new Set(ordered.map((e) => e.backend))]
  // Two backends resident at once cannot be named in one token, and choosing a
  // winner would repeat the defect this file exists to fix.
  const backend = backends.length === 1 ? backends[0] : 'mixed'
  const runtime = devices.length === 0 ? backend : `${backend}/${devices.join('+')}`

  // A model every pool holds is stated once. One that only SOME pool holds is
  // suffixed with that pool's device — otherwise the list would claim the
  // accelerators are interchangeable when they are not.
  const primary = ordered[0]
  if (primary === undefined) return {}
  const models: string[] = []
  for (const engine of ordered) {
    for (const model of engine.modelsLoaded) {
      if (models.includes(model)) continue
      if (engine === primary || primary.modelsLoaded.includes(model)) models.push(model)
      else models.push(engine.device === undefined ? model : `${model}@${engine.device}`)
    }
  }
  return { pipelineRuntime: runtime, pipelineModels: models }
}
