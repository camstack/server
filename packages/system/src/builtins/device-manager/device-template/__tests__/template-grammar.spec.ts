import { describe, expect, it } from 'vitest'
import { DEVICE_TEMPLATE_FILTERS, DEVICE_TEMPLATE_MAX_LENGTH } from '@camstack/types'
import { analyzeTemplate } from '../template-grammar.js'

const vet = (source: string) =>
  analyzeTemplate(source, DEVICE_TEMPLATE_FILTERS, DEVICE_TEMPLATE_MAX_LENGTH)

function refused(source: string): string {
  const out = vet(source)
  if (out.ok) throw new Error(`expected a refusal for: ${source}`)
  return out.refusal.reason
}

describe('device template grammar', () => {
  it('lists the references with their literal paths', () => {
    const out = vet(
      "{{ stufa_veranda.temperature | unit('°F') | round(1) }} {{ 'on' if stufa.switch.on else 'off' }} {{ a.list[0].name }}",
    )
    if (!out.ok) throw new Error(out.refusal.message)
    expect(out.refs).toEqual([
      { alias: 'stufa_veranda', path: ['temperature'] },
      { alias: 'stufa', path: ['switch', 'on'] },
      { alias: 'a', path: ['list', 0, 'name'] },
    ])
    expect(out.unitSites).toHaveLength(1)
    expect(out.unitSites[0]?.ref).toEqual({ alias: 'stufa_veranda', path: ['temperature'] })
  })

  it('treats loop variables and set names as locals, not aliases', () => {
    const out = vet(
      '{% for r in rooms.list %}{{ r.name }}{{ loop.index }}{% endfor %}{% set t = a.b %}{{ t }}',
    )
    if (!out.ok) throw new Error(out.refusal.message)
    expect(out.refs.map((r) => r.alias).toSorted()).toEqual(['a', 'rooms'])
  })

  it('does not take an `is` test name or a keyword name for a reference', () => {
    const out = vet('{% if a.b is defined %}{{ a.b | round(digits=1) }}{% endif %}')
    if (!out.ok) throw new Error(out.refusal.message)
    expect(out.refs).toEqual([{ alias: 'a', path: ['b'] }])
  })

  it.each([
    ['range.constructor("return process")()', 'forbidden-syntax'],
    ['cycler.constructor("return process")()', 'forbidden-syntax'],
    ['joiner.constructor("return process")()', 'forbidden-syntax'],
    ["''.constructor.constructor('return process')()", 'forbidden-syntax'],
    ['a.constructor', 'forbidden-member'],
    ["a['constructor']", 'forbidden-member'],
    ['a.__proto__', 'forbidden-member'],
    ['a.b.prototype', 'forbidden-member'],
    ['a[b]', 'forbidden-syntax'],
    ['a.b()', 'forbidden-syntax'],
    ['range(5)', 'forbidden-syntax'],
    ['a | safe', 'unknown-filter'],
    ['a | dump', 'unknown-filter'],
    ['a | list', 'unknown-filter'],
  ])('refuses the payload {{ %s }}', (expr, reason) => {
    expect(refused(`{{ ${expr} }}`)).toBe(reason)
  })

  it.each([
    "{% include 'x' %}",
    "{% import 'x' as y %}",
    "{% extends 'x' %}",
    '{% macro m() %}x{% endmacro %}',
    '{% block b %}x{% endblock %}',
  ])('refuses the block %s', (source) => {
    expect(refused(source)).toBe('forbidden-syntax')
  })

  it('refuses a template that does not parse, and one that is too long', () => {
    expect(refused('{{ a ')).toBe('syntax')
    expect(refused('x'.repeat(DEVICE_TEMPLATE_MAX_LENGTH + 1))).toBe('too-long')
  })

  it('requires unit() to name its target', () => {
    expect(refused('{{ a.b | unit }}')).toBe('syntax')
  })
})
