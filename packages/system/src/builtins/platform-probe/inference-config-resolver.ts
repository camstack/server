import type {
  PlatformScore,
  HardwareInfo,
  ModelRequirement,
  ResolvedInferenceConfig,
} from '@camstack/types'

export class InferenceConfigResolver {
  constructor(
    private readonly scores: readonly PlatformScore[],
    private readonly hardware: HardwareInfo,
  ) {}

  /**
   * Compute accuracy/backend weights based on available system RAM.
   * availableRAM_MB is now sourced from systeminformation (reliable cross-platform),
   * not os.freemem() which is broken on macOS.
   *
   * - > 16 GB available: prefer larger, more accurate models (accuracy 0.6, backend 0.4)
   * - > 8 GB available:  balanced (accuracy 0.5, backend 0.5)
   * - <= 8 GB available: prefer speed (accuracy 0.4, backend 0.6)
   */
  private getWeights(): { accuracyWeight: number; backendWeight: number } {
    const ramMB = this.hardware.availableRAM_MB
    if (ramMB > 16_384) return { accuracyWeight: 0.6, backendWeight: 0.4 }
    if (ramMB > 8_192) return { accuracyWeight: 0.5, backendWeight: 0.5 }
    return { accuracyWeight: 0.4, backendWeight: 0.6 }
  }

  /**
   * Given an addon's model requirements, pick the best model + runtime + backend.
   *
   * Algorithm:
   * 1. Filter models by available RAM (minRAM_MB < 25% of available RAM)
   * 2. For each remaining model, find the best platform score whose format
   *    is available in the model's formats
   * 3. Pick the model with the highest combined score using RAM-adaptive weights:
   *    - High RAM (>16 GB): accuracy × 0.6 + backend × 0.4  (prefer accuracy)
   *    - Mid RAM  (>8 GB):  accuracy × 0.5 + backend × 0.5  (balanced)
   *    - Low RAM  (<=8 GB): accuracy × 0.4 + backend × 0.6  (prefer speed)
   */
  resolve(requirements: readonly ModelRequirement[]): ResolvedInferenceConfig {
    if (requirements.length === 0) {
      return {
        modelId: '',
        runtime: 'python',
        backend: 'cpu',
        format: 'onnx',
        reason: 'No models declared',
      }
    }

    // Budget: 25% of available RAM (now reliable via systeminformation)
    const ramBudget = this.hardware.availableRAM_MB * 0.25
    const { accuracyWeight, backendWeight } = this.getWeights()

    console.log(
      `[InferenceConfigResolver] availableRAM: ${this.hardware.availableRAM_MB}MB, budget: ${Math.round(ramBudget)}MB, weights: accuracy=${accuracyWeight}, backend=${backendWeight}`,
    )

    // Filter models that fit in memory
    const fits = requirements.filter((m) => m.minRAM_MB < ramBudget)
    const candidates = fits.length > 0 ? fits : [requirements[0]!] // fallback to first/smallest

    console.log(
      `[InferenceConfigResolver] ${candidates.length}/${requirements.length} models fit RAM budget`,
    )

    // For each model, find best compatible platform score
    let bestCombo: { model: ModelRequirement; score: PlatformScore; combined: number } | null = null

    for (const model of candidates) {
      for (const score of this.scores) {
        if (!score.available) continue
        if (!model.formats.includes(score.format)) continue

        const combined = model.accuracyScore * accuracyWeight + score.score * backendWeight

        if (!bestCombo || combined > bestCombo.combined) {
          console.log(
            `[InferenceConfigResolver] New best: ${model.modelId} (accuracy=${model.accuracyScore}) + ${score.backend}/${score.format} (score=${score.score}) → combined=${Math.round(combined)}`,
          )
          bestCombo = { model, score, combined }
        }
      }
    }

    if (!bestCombo) {
      return {
        modelId: candidates[0]!.modelId,
        runtime: 'python',
        backend: 'cpu',
        format: 'onnx',
        reason: 'No compatible backend — CPU fallback',
      }
    }

    return {
      modelId: bestCombo.model.modelId,
      runtime: bestCombo.score.runtime,
      backend: bestCombo.score.backend,
      format: bestCombo.score.format,
      reason: `${bestCombo.model.name} on ${bestCombo.score.reason} (score: ${Math.round(bestCombo.combined)})`,
    }
  }
}
