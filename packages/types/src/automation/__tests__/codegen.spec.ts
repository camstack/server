import { describe, expect, it } from 'vitest'
import { generateAutomationBlock } from '../codegen.js'
import type { AutomationRecipe } from '../recipe.js'
import { NIGHT_CLOSE_AND_ARM } from './recipe.spec.js'

const GEN = generateAutomationBlock({ name: 'Notte: chiudi e arma', recipe: NIGHT_CLOSE_AND_ARM })

describe('generated block — the contract the runner enforces', () => {
  it('satisfies the block contract the package wrapper checks by name', () => {
    expect(GEN).toContain('export default function block(ctx: AddonContext)')
    expect(GEN).toMatch(/return \(\) => \{/)
  })

  it('never emits a dynamic evaluation path', () => {
    for (const banned of ['eval(', 'new Function', 'node:vm', 'require(']) {
      expect(GEN).not.toContain(banned)
    }
  })

  it('carries the recipe as the authored artefact so the editor can round-trip', () => {
    expect(GEN).toContain('AUTOMATION_RECIPE')
    const match = GEN.match(/const AUTOMATION_RECIPE = (\{[\s\S]*?\}) as const/)
    expect(match).not.toBeNull()
    expect(JSON.parse(match![1]!)).toEqual(NIGHT_CLOSE_AND_ARM)
  })
})

describe('triggers', () => {
  it('emits a SELF-CONTAINED schedule — a block cannot resolve croner', () => {
    expect(GEN).toContain('"30 23 * * *"')
    expect(GEN).toContain('disposers.push')
    // Proven on the live hub 2026-08-09: a block importing 'croner' spawns and
    // dies in a crash loop, while an identical block without it runs. And
    // coreBlocks.compile returns ok:true for that code, so compiling is not a
    // sufficient gate. The scheduler is therefore emitted inline.
    expect(GEN).not.toContain("from 'croner'")
    expect(GEN).not.toContain('new Cron(')
    expect(GEN).toContain('cronMatches')
  })

  it('re-arms the schedule from the wall clock each minute, so it cannot drift', () => {
    expect(GEN).toContain('nextMinuteBoundary')
  })

  it('imports nothing a block cannot resolve', () => {
    const imports = [...GEN.matchAll(/from '([^']+)'/g)].map((m) => m[1])
    expect(imports.sort()).toEqual(['@camstack/types', '@camstack/types'])
  })

  it('subscribes to the event bus for a device-event trigger', () => {
    const g = generateAutomationBlock({
      name: 'x',
      recipe: {
        triggers: [{ kind: 'device-event', category: 'doorbell.on-pressed', deviceId: 101 }],
        actions: [{ kind: 'cap', deviceId: 616, cap: 'siren', method: 'on' }],
      },
    })
    expect(g).toContain('ctx.eventBus.subscribe')
    expect(g).toContain('doorbell.on-pressed')
  })

  it('reads a device-state trigger off the mirror, so a dropped event delays and never loses', () => {
    const g = generateAutomationBlock({
      name: 'x',
      recipe: {
        triggers: [
          {
            kind: 'device-state',
            deviceId: 1023,
            cap: 'alarm-panel',
            fieldPath: 'state',
            becomes: 'armed-away',
            edge: true,
          },
        ],
        actions: [{ kind: 'cap', deviceId: 616, cap: 'siren', method: 'on' }],
      },
    })
    expect(g).toContain('deviceState.getCapSlice')
    expect(g).toContain('RECONCILE_MS')
    // The parameter is `capName`, NOT `cap`. Proven live 2026-08-09: with the
    // wrong name the call rejects, readField returns undefined, and EVERY
    // condition leaf is false forever — an automation that can never fire.
    expect(g).toContain('getCapSlice.query({ deviceId, capName: cap })')
  })
})

describe('conditions', () => {
  it('short-circuits left-to-right through generated combinators', () => {
    expect(GEN).toContain('async function allOf')
    expect(GEN).toContain('async function anyOf')
    // short-circuit: allOf returns early on the first false
    expect(GEN).toMatch(/if \(!\(await c\(\)\)\) return false/)
  })

  it('makes an unresolvable leaf FALSE and logs it, never throws the pass away', () => {
    expect(GEN).toContain('condition leaf unresolvable')
    expect(GEN).toContain('tags: { deviceId }')
  })

  it('evaluates the expression leaf through the bounded engine, not inline JS', () => {
    expect(GEN).toContain('evaluateExpressionSource')
    expect(GEN).toContain('outdoor < 5')
  })
})

describe('actions', () => {
  it('emits the steps in authored order', () => {
    // Scoped to the emitted sequence: the AUTOMATION_RECIPE literal at the top
    // of the file also contains these strings, in the same order, so an
    // unscoped search would pass without the switch being generated at all.
    const body = GEN.slice(GEN.indexOf('async function runActions'))
    const close = body.indexOf('"close"')
    const wait = body.indexOf('await sleep(20000)')
    const arm = body.indexOf('"arm"')
    expect(close).toBeGreaterThan(-1)
    expect(wait).toBeGreaterThan(close)
    expect(arm).toBeGreaterThan(wait)
  })

  it('routes a cap action through the camelCase ctx.api key, not the kebab cap name', () => {
    // ctx.api is keyed by ROUTER name (`alarmPanel`); a cap is named
    // `alarm-panel`. Indexing ctx.api with the kebab name yields undefined and
    // every action throws "no such device method" — an automation whose THEN
    // half can never run. Found by the UI agent reading the generated actuate.
    expect(GEN).toContain('function capToRouterKey')
    expect(GEN).toContain('capToRouterKey(cap)')
  })

  it('stops at the first failure, like the NC runner it mirrors', () => {
    expect(GEN).toContain('stopping the sequence')
  })

  it('resolves a {$var} target before dispatch so the runner still sees a number', () => {
    const g = generateAutomationBlock({
      name: 'x',
      recipe: {
        triggers: [{ kind: 'device-event', category: 'motion.on-motion-changed' }],
        actions: [{ kind: 'cap', deviceId: { $var: 'deviceId' }, cap: 'siren', method: 'on' }],
      },
    })
    expect(g).toContain('resolveTarget')
    expect(g).toContain('resolveTarget(vars, "deviceId")')
  })

  it('fans out a same-family multi-device cap action across each id', () => {
    const g = generateAutomationBlock({
      name: 'x',
      recipe: {
        triggers: [{ kind: 'manual' }],
        actions: [
          {
            kind: 'cap',
            deviceId: [101, 102],
            cap: 'lock-control',
            method: 'lock',
            args: {},
          },
        ],
      },
    })
    expect(g).toContain('for (const deviceId of [101,102])')
    expect(g).toContain('actuate(deviceId, "lock-control", "lock"')
  })
})

describe('refusals', () => {
  it('refuses to generate from an out-of-bounds recipe', () => {
    const tooDeep: AutomationRecipe = {
      ...NIGHT_CLOSE_AND_ARM,
      conditions: {
        kind: 'all',
        children: [
          { kind: 'all', children: [{ kind: 'all', children: [{ kind: 'all', children: [] }] }] },
        ],
      },
    }
    expect(() => generateAutomationBlock({ name: 'x', recipe: tooDeep })).toThrow()
  })
})
