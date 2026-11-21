/**
 * The bundled onboarding manifest against THIS CLI (D1077). The docs name tools
 * and their arguments; a tool renamed here would turn every assistant action
 * into "do it by hand" without one red test — the wizard hides a tool it does
 * not serve by design. This is where that is caught.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { STEP_EVALUATORS } from '../onboarding/evaluators.js'
import { bundledManifest } from '../onboarding/manifest.js'
import { isToolRendering } from '../onboarding/manifest-schema.js'
import { connectPublic, fakeHub } from './onboarding-fixtures.js'

const MANIFEST = bundledManifest()
const InputSchema = z.object({
  properties: z.record(z.string(), z.unknown()).optional(),
})

const toolActions = MANIFEST.steps.flatMap((step) =>
  step.actions.flatMap((action) =>
    isToolRendering(action.agent)
      ? [
          {
            where: `${step.id}/${action.id}`,
            tool: action.agent.tool,
            args: action.agent.args ?? {},
          },
        ]
      : [],
  ),
)

describe('the bundled onboarding manifest against this CLI', () => {
  it('judges exactly the steps the docs list', () => {
    expect(Object.keys(STEP_EVALUATORS).toSorted()).toEqual(
      MANIFEST.steps.map((s) => s.id).toSorted(),
    )
  })

  it('every tool the docs name is served, with only arguments that tool takes', async () => {
    expect(toolActions.length).toBeGreaterThan(15)
    const client = await connectPublic(fakeHub({}).ctx)
    const tools = new Map(
      (await client.listTools()).tools.map((t) => [
        t.name,
        new Set(Object.keys(InputSchema.parse(t.inputSchema).properties ?? {})),
      ]),
    )

    const problems = toolActions.flatMap(({ where, tool, args }) => {
      const accepted = tools.get(tool)
      if (accepted === undefined) return [`${where}: no tool ${tool}`]
      return Object.keys(args)
        .filter((key) => !accepted.has(key))
        .map((key) => `${where}: ${tool} takes no argument ${key}`)
    })

    expect(problems).toEqual([])
  })

  it('every action an evaluator points at is an action of that step', () => {
    const source = readFileSync(new URL('../onboarding/evaluators.ts', import.meta.url), 'utf8')
    const pointed = [...source.matchAll(/focusAction: '([a-z-]+)'/g)].flatMap((m) =>
      m[1] === undefined ? [] : [m[1]],
    )
    const known = new Set(MANIFEST.steps.flatMap((s) => s.actions.map((a) => a.id)))

    expect(pointed.length).toBeGreaterThan(5)
    expect(pointed.filter((id) => !known.has(id))).toEqual([])
  })

  it('no step is empty, and every page is a path on the docs site', () => {
    for (const step of MANIFEST.steps) {
      expect(step.actions.length, step.id).toBeGreaterThan(0)
      expect(step.page, step.id).toMatch(/^\/docs\/get-started/)
    }
    for (const group of MANIFEST.coreAddons) expect(group.page).toMatch(/^\/docs\//)
  })

  it('the sizing figures are the measured ones, never zero', () => {
    for (const value of Object.values(MANIFEST.sizing)) {
      if (typeof value === 'number') expect(value).toBeGreaterThan(0)
    }
  })
})
