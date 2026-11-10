import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { DeviceTemplateView } from '@camstack/types'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DeviceTemplateRenderer, type DeviceTemplateResolver } from '../template-renderer.js'

const WORKER = fileURLToPath(new URL('../template-worker.ts', import.meta.url))
const NOW = Date.parse('2026-11-08T12:00:00Z')

const veranda: DeviceTemplateView = {
  deviceId: 7,
  addonId: 'ecowitt',
  stableId: 'veranda',
  slices: {
    'temperature-sensor': { temperature: 21.5, humidity: 40 },
    'humidity-sensor': { humidity: 55 },
    switch: { on: true, lastSeen: NOW - 5 * 60_000 },
    big: { items: Array.from({ length: 3000 }, (_, i) => i) },
    empty: { reading: null },
  },
  unitOf: (cap, field) =>
    cap === 'temperature-sensor' && field[0] === 'temperature' ? '°C' : undefined,
}

const resolver: DeviceTemplateResolver = {
  viewOf: (alias) => (alias === 'stufa_veranda' ? veranda : undefined),
}

let renderer: DeviceTemplateRenderer
beforeAll(() => {
  renderer = new DeviceTemplateRenderer({
    workerPath: WORKER,
    workerExecArgv: ['--import', 'tsx'],
    budgetMs: 2000,
    now: () => NOW,
  })
})
afterAll(() => renderer.dispose())

async function text(source: string): Promise<string> {
  const out = await renderer.render(source, resolver)
  if (!out.ok) throw new Error(`${out.refusal.reason}: ${out.refusal.message}`)
  return out.text
}

describe('device template renderer', () => {
  it('converts from the base unit, rounds and appends the symbol', async () => {
    expect(await text("{{ stufa_veranda.temperature | unit('°F') | round(1) }}")).toBe('70.7 °F')
    expect(await text('{{ stufa_veranda.temperature | round(0) }}')).toBe('22')
  })

  it('trunc cuts toward zero where round would carry', async () => {
    expect(await text('{{ 19.99 | trunc(1) }}|{{ 19.99 | round(1) }}')).toBe('19.9|20')
    expect(await text('{{ 21.96 | trunc(1) }}|{{ 21.96 | round(1) }}')).toBe('21.9|22')
    expect(await text('{{ -3.75 | trunc(1) }}|{{ 19.99 | trunc(0) }}')).toBe('-3.7|19')
    expect(await text("{{ stufa_veranda.temperature | unit('°F') | trunc(1) }}")).toBe('70.7 °F')
    expect(await text("{{ 'abc' | trunc(1) }}")).toBe('abc')
  })

  it('onoff reads a boolean as ON/OFF and leaves a number or a string alone', async () => {
    expect(await text('{{ stufa_veranda.switch.on | onoff }}')).toBe('ON')
    expect(
      await text('{{ false | onoff }}|{{ 1 | onoff }}|{{ 0 | onoff }}|{{ 20 | onoff | trunc(1) }}'),
    ).toBe('OFF|1|0|20')
    expect(await text("{{ 'high' | onoff }}")).toBe('high')
  })

  it('runs conditionals, loops and the other filters', async () => {
    expect(await text("{{ 'on' if stufa_veranda.switch.on else 'off' }}")).toBe('on')
    expect(await text('{% if stufa_veranda.temperature > 20 %}warm{% else %}cold{% endif %}')).toBe(
      'warm',
    )
    expect(
      await text(
        '{% for i in stufa_veranda.big.items %}{% if i < 3 %}{{ i }}{% endif %}{% endfor %}',
      ),
    ).toBe('012')
    expect(
      await text(
        '{{ stufa_veranda.switch.lastSeen | ago }}|{{ stufa_veranda.switch.lastSeen | since }}',
      ),
    ).toBe('5 min ago|5 min')
    expect(await text("{{ stufa_veranda.temperature | format('%.2f') }}")).toBe('21.50')
    expect(await text("{{ stufa_veranda.empty.reading | default('n/a') }}")).toBe('n/a')
  })

  it('renders an unknown alias, field or null as the unavailable text and traces it', async () => {
    const out = await renderer.render(
      '{{ nobody.temp }} {{ stufa_veranda.nope }} {{ stufa_veranda.empty.reading }}',
      resolver,
    )
    if (!out.ok) throw new Error(out.refusal.message)
    expect(out.text).toBe('— — —')
    expect(out.trace).toEqual([
      { ref: 'nobody.temp', reason: 'unknown-alias' },
      { ref: 'stufa_veranda.nope', reason: 'unknown-field' },
      { ref: 'stufa_veranda.empty.reading', reason: 'unavailable' },
    ])
  })

  it('refuses an ambiguous alias.field by name and accepts the cap-qualified spelling', async () => {
    const out = await renderer.render('{{ stufa_veranda.humidity }}', resolver)
    if (out.ok) throw new Error('expected a refusal')
    expect(out.refusal.reason).toBe('ambiguous-field')
    expect(out.refusal.message).toContain('temperature-sensor')
    expect(out.refusal.message).toContain('humidity-sensor')
    expect(
      await text(
        '{{ stufa_veranda.humidity_sensor.humidity }} {{ stufa_veranda.temperature_sensor.humidity }}',
      ),
    ).toBe('55 40')
  })

  it('refuses output over the cap', async () => {
    const out = await renderer.render(
      '{% for i in stufa_veranda.big.items %}{% for j in [1,2,3] %}xxxxxxxx{% endfor %}{% endfor %}',
      resolver,
    )
    if (out.ok) throw new Error('expected a refusal')
    expect(out.refusal.reason).toBe('output-too-large')
  })
})

describe('device template additions', () => {
  it('prints the unavailable text for a whole expression with an unavailable operand of + or ~, and traces it', async () => {
    const out = await renderer.render(
      "{{ 'x ' + stufa_veranda.nope }}|{{ 'x' ~ stufa_veranda.empty.reading }}|{{ 1 + 2 }}|{{ 'a' + 'b' }}",
      resolver,
    )
    if (!out.ok) throw new Error(out.refusal.message)
    expect(out.text).toBe('—|—|3|ab')
    expect(out.trace.filter((t) => t.ref === '<expression>')).toHaveLength(2)
  })

  it('runs the pure filters and the capped range', async () => {
    expect(await text('{% for i in range(3) %}{{ i }}{% endfor %}')).toBe('012')
    expect(
      await text(
        "{{ [3, 1, 2] | sort | join('-') }}|{{ [1,2,3] | first }}|{{ [1,2,3] | last }}|{{ [1,2] | sum }}",
      ),
    ).toBe('1-2-3|1|3|3')
    expect(await text("{{ 'hello' | replace('l', 'L') | truncate(4, true, '') | upper }}")).toBe(
      'HELL',
    )
    expect(await text("{{ stufa_veranda.nope | d('n/a') }}")).toBe('n/a')
    const out = await renderer.render('{% for i in range(5000) %}{% endfor %}', resolver)
    if (out.ok) throw new Error('expected a refusal')
    expect(out.refusal.reason).toBe('render-failed')
  })

  it('does not run the is-test payload (host and worker both refuse it)', async () => {
    const payload =
      "{% if 1 is divisibleby('a'.constructor.constructor('globalThis.PWNED=typeof process')()) %}x{% endif %}"
    const out = await renderer.render(payload, resolver)
    expect(out.ok).toBe(false)
    const bypass = new DeviceTemplateRenderer({
      workerPath: WORKER,
      workerExecArgv: ['--import', 'tsx'],
      budgetMs: 2000,
      now: () => NOW,
    })
    Reflect.set(bypass, 'validate', () => ({ ok: true, refs: [], unitSites: [] }))
    const inside = await bypass.render(payload, resolver)
    bypass.dispose()
    expect(inside.ok).toBe(false)
    if (!inside.ok) expect(inside.refusal.reason).toBe('forbidden-syntax')
  })
})

describe('device template sandbox', () => {
  it.each([
    '{{ range.constructor("return process")() }}',
    '{{ cycler.constructor("return process")() }}',
    '{{ joiner.constructor("return process")() }}',
    "{{ ''.constructor.constructor('return process')() }}",
    '{{ stufa_veranda.constructor.constructor("return process")() }}',
    "{% include '/etc/passwd' %}",
    "{% import 'x' as y %}",
  ])('refuses %s before it reaches the engine', async (source) => {
    const out = await renderer.render(source, resolver)
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(['forbidden-syntax', 'forbidden-member']).toContain(out.refusal.reason)
  })

  it('also refuses it INSIDE the worker (defence in depth)', async () => {
    // The host check is bypassed on purpose: the worker's own check must hold alone.
    const bypass = new DeviceTemplateRenderer({
      workerPath: WORKER,
      workerExecArgv: ['--import', 'tsx'],
      budgetMs: 2000,
      now: () => NOW,
    })
    Reflect.set(bypass, 'validate', () => ({ ok: true, refs: [], unitSites: [] }))
    const out = await bypass.render('{{ range.constructor("return process")() }}', resolver)
    bypass.dispose()
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.refusal.reason).toBe('forbidden-syntax')
  })

  it('terminates a render that overruns the budget and serves the next one', async () => {
    const tight = new DeviceTemplateRenderer({
      workerPath: WORKER,
      workerExecArgv: ['--import', 'tsx'],
      budgetMs: 150,
      now: () => NOW,
    })
    try {
      expect(await tight.render('{{ 1 }}', resolver)).toMatchObject({ ok: true, text: '1' })
      const slow =
        '{% for a in stufa_veranda.big.items %}{% for b in stufa_veranda.big.items %}{% for c in stufa_veranda.big.items %}{% endfor %}{% endfor %}{% endfor %}'
      const started = Date.now()
      const out = await tight.render(slow, resolver)
      expect(Date.now() - started).toBeLessThan(2000)
      if (out.ok) throw new Error('expected a timeout')
      expect(out.refusal.reason).toBe('timeout')
      expect(await tight.render('{{ 2 }}', resolver)).toMatchObject({ ok: true, text: '2' })
    } finally {
      tight.dispose()
    }
  }, 20_000)
})

describe('device template renderer operations', () => {
  const make = (extra: ConstructorParameters<typeof DeviceTemplateRenderer>[0] = {}) =>
    new DeviceTemplateRenderer({
      workerPath: WORKER,
      workerExecArgv: ['--import', 'tsx'],
      budgetMs: 2000,
      now: () => NOW,
      ...extra,
    })
  const slow =
    '{% for a in stufa_veranda.big.items %}{% for b in stufa_veranda.big.items %}{% for c in stufa_veranda.big.items %}{% endfor %}{% endfor %}{% endfor %}'

  it('does not charge the worker cold start to the render budget', async () => {
    const cold = make({ budgetMs: 30 })
    try {
      expect(await cold.render('{{ 1 }}', resolver)).toMatchObject({ ok: true, text: '1' })
    } finally {
      cold.dispose()
    }
  }, 20_000)

  it('refuses with `busy` once the queue is full', async () => {
    const r = make({ maxQueue: 1 })
    try {
      const [first, second] = await Promise.all([
        r.render('{{ 1 }}', resolver),
        r.render('{{ 2 }}', resolver),
      ])
      expect(first.ok).toBe(true)
      if (second.ok) throw new Error('expected busy')
      expect(second.refusal.reason).toBe('busy')
    } finally {
      r.dispose()
    }
  }, 20_000)

  it('stops running a template that keeps overrunning, and still runs others', async () => {
    const r = make({ budgetMs: 150, breakerThreshold: 2, breakerWindowMs: 60_000 })
    try {
      for (let i = 0; i < 2; i += 1) {
        const out = await r.render(slow, resolver)
        if (out.ok) throw new Error('expected a timeout')
        expect(out.refusal.reason).toBe('timeout')
      }
      const started = Date.now()
      const tripped = await r.render(slow, resolver)
      if (tripped.ok) throw new Error('expected a refusal')
      expect(tripped.refusal.reason).toBe('budget-exceeded')
      expect(Date.now() - started).toBeLessThan(100)
      expect(await r.render('{{ 3 }}', resolver)).toMatchObject({ ok: true, text: '3' })
    } finally {
      r.dispose()
    }
  }, 30_000)

  it('kills a worker that never says ready and respawns on the next render', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tpl-spawn-'))
    const marker = path.join(dir, 'first-launch')
    const script = path.join(dir, 'worker.mjs')
    fs.writeFileSync(
      script,
      `import fs from 'node:fs'
if (!fs.existsSync(${JSON.stringify(marker)})) { fs.writeFileSync(${JSON.stringify(marker)}, '1'); setInterval(() => {}, 1000) }
else await import(${JSON.stringify(WORKER)})
`,
    )
    const r = make({ workerPath: script, spawnTimeoutMs: 2500 })
    try {
      const first = await r.render('{{ 1 }}', resolver)
      expect(first.ok).toBe(false)
      const second = await r.render('{{ 2 }}', resolver)
      expect(JSON.stringify(second)).toContain('"text":"2"')
    } finally {
      r.dispose()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)
})
