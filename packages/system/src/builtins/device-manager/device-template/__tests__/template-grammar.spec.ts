import { DEVICE_TEMPLATE_FILTERS, DEVICE_TEMPLATE_MAX_LENGTH } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { nunjucksNodeFields } from '../nunjucks-internals.js'
import { analyzeTemplate, NODE_POLICY } from '../template-grammar.js'

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
    ['foo(5)', 'forbidden-syntax'],
    ['range.constructor(5)', 'forbidden-syntax'],
    ['range(a.b, k=1)', 'syntax'],
    ['range()', 'syntax'],
    ['a | safe', 'unknown-filter'],
    ['a | dump', 'unknown-filter'],
    ['a | escape', 'unknown-filter'],
    ['a | groupby(1)', 'unknown-filter'],
    ['a | selectattr(1)', 'unknown-filter'],
    ['a | rejectattr(1)', 'unknown-filter'],
    ["a | join(',', 'name')", 'syntax'],
    ["a | join(',', attribute='name')", 'syntax'],
    ["a | sort(false, false, 'name')", 'syntax'],
    ["a | sum('x')", 'syntax'],
    // `is` tests: the right side is vetted, not skipped.
    [
      "1 is divisibleby('a'.constructor.constructor('globalThis.PWNED=typeof process')())",
      'forbidden-syntax',
    ],
    ['1 is divisibleby(range.constructor)', 'forbidden-member'],
    ['1 is divisibleby(x.y())', 'forbidden-syntax'],
    ['1 is callable', 'forbidden-syntax'],
    ['1 is foo', 'forbidden-syntax'],
    ['1 is foo(2)', 'forbidden-syntax'],
  ])('refuses the payload {{ %s }}', (expr, reason) => {
    expect(refused(`{{ ${expr} }}`)).toBe(reason)
  })

  it('refuses the {% if %} form of the `is` payload and the Set capture body', () => {
    expect(
      refused(
        "{% if 1 is divisibleby('a'.constructor.constructor('globalThis.PWNED=typeof process')()) %}x{% endif %}",
      ),
    ).toBe('forbidden-syntax')
    expect(refused('{% set x %}y{% endset %}')).toBe('forbidden-syntax')
  })

  it('accepts the allowed tests, the pure filters and the capped range', () => {
    for (const ok of [
      '{{ a.b is defined }}',
      '{{ a.n is divisibleby(3) }}',
      '{{ a.list | join(", ") | upper }}',
      "{{ a.s | replace('a', 'b') | truncate(5) }}",
      '{{ a.list | sort | reverse | first }}',
      '{{ a.list | sum | string }}',
      '{{ a.x | d("n/a") }}',
      '{% for i in range(3) %}{{ i }}{% endfor %}',
    ]) {
      const out = vet(ok)
      if (!out.ok) throw new Error(`${ok}: ${out.refusal.message}`)
    }
  })

  it('has a field policy for every node kind that matches nunjucks, so a missed child cannot hide', () => {
    const declared = nunjucksNodeFields()
    for (const [kind, policy] of Object.entries(NODE_POLICY)) {
      const mine = [...policy.walk, ...policy.data, ...policy.special].sort()
      expect([kind, [...(declared.get(kind) ?? [])].sort()]).toEqual([kind, mine])
    }
    // Every kind the policy does not name is refused (default-deny): spot-check the dangerous ones.
    for (const kind of [
      'Capture',
      'Macro',
      'Caller',
      'Import',
      'FromImport',
      'Include',
      'Extends',
      'Block',
      'Super',
      'CallExtension',
      'Switch',
    ]) {
      expect(NODE_POLICY[kind]).toBeUndefined()
      expect(declared.has(kind)).toBe(true)
    }
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
