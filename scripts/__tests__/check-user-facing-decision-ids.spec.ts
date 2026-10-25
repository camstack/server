/**
 * The user-facing decision-id guard judges only text that reaches a screen:
 * comments, identifiers and log lines keep their ids; JSX text, UI props,
 * schema descriptions, error messages and manifest descriptions may not.
 */
import { describe, expect, it } from 'vitest'
import { scanManifest, scanSource } from '../check-user-facing-decision-ids.js'

const hits = (rel: string, src: string): readonly string[] =>
  scanSource(rel, src).map((f) => f.where)

describe('what the guard flags', () => {
  it('flags JSX text and a UI prop in a .tsx', () => {
    const src = 'export const A = () => <div>See D15 <Field label="x (D17)" /></div>\n'
    expect(hits('packages/addon-x/src/a.tsx', src)).toEqual(['JSX text', 'label='])
  })

  it('flags a schema description, a zod describe and an error message in a .ts', () => {
    const src = [
      "const s = { description: 'see D20' }",
      "z.string().describe('a knob (D23)')",
      'throw new TypeError(`bad (ADR-0550)`)',
    ].join('\n')
    expect(hits('packages/addon-x/src/a.ts', src)).toEqual([
      'description:',
      '.describe()',
      'new TypeError()',
    ])
  })

  it('flags a manifest description', () => {
    const src = JSON.stringify(
      { camstack: { addons: [{ description: 'refused (D296).' }] } },
      null,
      2,
    )
    expect(scanManifest('packages/addon-x/package.json', src).map((f) => f.where)).toEqual([
      'manifest description',
    ])
  })
})

describe('what the guard leaves alone', () => {
  it('ignores comments, identifiers, log lines and non-UI properties', () => {
    const src = [
      '// D12 in a comment',
      '/** D13 in a doc comment */',
      'const D14 = 1',
      "logger.info('D19 in a log line')",
      "const r = { reason: 'D21 internal' }",
    ].join('\n')
    expect(hits('packages/addon-x/src/a.ts', src)).toEqual([])
  })

  it('ignores a JSX comment and a log line in a .tsx', () => {
    const src = "logger.warn('D19')\nexport const A = () => <div>{/* D16 */}ok</div>\n"
    expect(hits('packages/addon-x/src/a.tsx', src)).toEqual([])
  })

  it('does not read D3D11VA-style tokens as an id', () => {
    expect(hits('packages/addon-x/src/a.ts', "const s = { label: 'D3D11VA' }")).toEqual([])
  })
})
