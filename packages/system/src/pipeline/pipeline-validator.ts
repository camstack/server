import type {
  PipelineConfig,
  PipelineNode,
  ValidationIssue,
  ValidationResult,
} from '@camstack/types'

export type { ValidationIssue, ValidationResult }

/**
 * Check if a pipeline step is available in the system.
 * Implementations should check the capability registry for `pipeline-step:{stepId}`.
 */
export type StepExistsFn = (stepId: string) => boolean

export class PipelineValidator {
  constructor(private readonly stepExists: StepExistsFn) {}

  validate(config: PipelineConfig): ValidationResult {
    const errors: ValidationIssue[] = []
    const warnings: ValidationIssue[] = []

    for (const node of config.video) {
      this.validateNode(node, errors, warnings)
    }

    if (config.audio) {
      this.validateNode(config.audio, errors, warnings)
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    }
  }

  private validateNode(
    node: PipelineNode,
    errors: ValidationIssue[],
    warnings: ValidationIssue[],
  ): void {
    if (!this.stepExists(node.addon)) {
      errors.push({
        step: node.step,
        addon: node.addon,
        message: `Step "${node.addon}" has no provider — the addon that provided it may have been removed`,
        severity: 'error',
      })
      return
    }

    if (node.children) {
      for (const child of node.children) {
        this.validateNode(child, errors, warnings)
      }
    }
  }
}
