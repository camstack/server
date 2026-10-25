/**
 * Task G5 (Gate B) — pure helper backing `validatePipeline`'s
 * `unknown-addon` issue kind.
 *
 * `collectZeroBuildIssues` already skips unknown/custom addonIds (no
 * registered `StepDefinition`) rather than throwing — that's correct for
 * ITS purpose (a step it can't check is not a zero-build issue), but Gate B
 * needs those skipped addonIds surfaced as their OWN hard issue so an
 * operator sees "this addonId doesn't exist" instead of silence. This is
 * the seam: recurse the input tree (mirrors `collectSubstitutions`'
 * recursion pattern) and report one issue per addonId whose
 * `StepDefinition` lookup throws.
 */
import { describe, it, expect } from 'vitest'
import { collectUnknownAddonIssues, type ResolvableStep } from '../step-resolution.js'

describe('collectUnknownAddonIssues', () => {
  it('returns empty for a tree of known addonIds', () => {
    const tree: ResolvableStep[] = [
      { addonId: 'object-detection', modelId: undefined, enabled: true },
    ]
    const result = collectUnknownAddonIssues(tree, () => ({}) as never)
    expect(result).toEqual([])
  })

  it('flags a root step with no registered StepDefinition', () => {
    const tree: ResolvableStep[] = [{ addonId: 'no-such-addon', modelId: undefined, enabled: true }]
    const throwing = (): never => {
      throw new Error('unknown step')
    }
    const result = collectUnknownAddonIssues(tree, throwing)
    expect(result).toEqual([{ addonId: 'no-such-addon' }])
  })

  it('recurses into children and flags an unknown addonId nested below a known one', () => {
    const tree: ResolvableStep[] = [
      {
        addonId: 'object-detection',
        modelId: undefined,
        enabled: true,
        children: [{ addonId: 'no-such-child', modelId: undefined, enabled: true }],
      },
    ]
    const getStepDef = (addonId: string): unknown => {
      if (addonId === 'object-detection') return {}
      throw new Error('unknown step')
    }
    const result = collectUnknownAddonIssues(tree, getStepDef as never)
    expect(result).toEqual([{ addonId: 'no-such-child' }])
  })

  it('does not throw for a fully unknown tree', () => {
    const tree: ResolvableStep[] = [{ addonId: 'ghost', modelId: undefined, enabled: true }]
    const throwing = (): never => {
      throw new Error('unknown step')
    }
    expect(() => collectUnknownAddonIssues(tree, throwing)).not.toThrow()
  })
})
