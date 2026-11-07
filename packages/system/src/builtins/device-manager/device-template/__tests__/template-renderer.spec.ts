import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { DeviceTemplateView } from '@camstack/types'
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
