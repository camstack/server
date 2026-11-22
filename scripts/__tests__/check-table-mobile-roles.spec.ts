import { describe, expect, it } from 'vitest'
import {
  checkFile,
  findRawTables,
  findRoleViolations,
  findWrappingCells,
  inScope,
} from '../check-table-mobile-roles'

function column(role: string, key: string): string {
  return `{ mobile: '${role}', key: '${key}', render: (r) => r.${key} }`
}

describe('check-table-mobile-roles', () => {
  it('looks at package sources and skips specs', () => {
    expect(inScope('packages/addon-admin-ui/src/pages/Devices.tsx')).toBe(true)
    expect(inScope('packages/ui-library/src/composites/data-table.tsx')).toBe(true)
    expect(inScope('packages/addon-admin-ui/src/pages/__tests__/Devices.spec.tsx')).toBe(false)
    expect(inScope('packages/ui-library/src/composites/x.test.tsx')).toBe(false)
    expect(inScope('scripts/ui/shots/run.ts')).toBe(false)
  })

  it('flags a raw <table>, multi-line opener included, and leaves prose and DataTable alone', () => {
    const src = [
      '<table className="w-full">',
      '<table',
      '  className="w-full"',
      '>',
      '// a <table> in prose',
      ' * <table> in a doc block',
      '<DataTable columns={columns} rows={rows} />',
      'const m: Map<string, tableRow> = new Map()',
    ].join('\n')
    expect(findRawTables(src).map((f) => f.line)).toEqual([1, 2])
  })

  it('accepts one primary and up to three keep', () => {
    const src = `const columns = [${[
      column('primary', 'name'),
      column('keep', 'a'),
      column('keep', 'b'),
      column('keep', 'c'),
      column('detail', 'd'),
      column('hidden', 'e'),
    ].join(',')}]`
    expect(findRoleViolations(src)).toEqual([])
  })

  it('flags a whole column list with no primary, however it is bound', () => {
    const body = `[${column('keep', 'a')}, ${column('detail', 'b')}]`
    const bindings = [
      `const columns = ${body}`,
      `const COLUMNS = ${body} as const`,
      `const columns = useMemo(() => ${body}, [])`,
      `function buildResultColumns() { return ${body} }`,
      `const x = <DataTable columns={${body}} rows={rows} />`,
    ]
    for (const src of bindings) {
      expect(
        findRoleViolations(src).map((f) => f.rule),
        src,
      ).toEqual(['roles'])
    }
  })

  it('flags two primaries and a fourth keep', () => {
    const twoPrimary = `const columns = [${column('primary', 'a')}, ${column('primary', 'b')}]`
    expect(findRoleViolations(twoPrimary)[0]?.message).toContain('2 `primary`')
    const fourKeep = `const columns = [${['primary', 'keep', 'keep', 'keep', 'keep']
      .map((role, i) => column(role, `k${i}`))
      .join(',')}]`
    expect(findRoleViolations(fourKeep)[0]?.message).toContain('4 `keep`')
  })

  it('checks only the upper bounds of a fragment or an assembled list', () => {
    const extra = `const extraColumns = [${column('detail', 'node')}]`
    expect(findRoleViolations(extra)).toEqual([])
    const assembled = `const columns = [...base, ${column('keep', 'actions')}]`
    expect(findRoleViolations(assembled)).toEqual([])
    const conditional = `const columns = [${column('primary', 'name')}, ...(wide ? [${column('hidden', 'kind')}] : [])]`
    expect(findRoleViolations(conditional)).toEqual([])
    const tooMany = `const extraColumns = [${['keep', 'keep', 'keep', 'keep']
      .map((role, i) => column(role, `k${i}`))
      .join(',')}]`
    expect(findRoleViolations(tooMany).map((f) => f.rule)).toEqual(['roles'])
  })

  it('ignores arrays that are not column lists', () => {
    expect(findRoleViolations(`const columns = [{ key: 'a' }, { key: 'b' }]`)).toEqual([])
    expect(findRoleViolations(`const columns = [{ mobile: phone, key: 'a' }]`)).toEqual([])
  })

  it('flags a wrapping library cell and accepts a breakpoint-scoped one', () => {
    expect(
      findWrappingCells('const a = <td className="flex flex-wrap gap-1">x</td>').map((f) => f.rule),
    ).toEqual(['wrapping'])
    expect(
      findWrappingCells('const a = <th className={cn("px-2", "whitespace-normal")}>x</th>'),
    ).toHaveLength(1)
    expect(findWrappingCells('const a = <td className="max-sm:whitespace-normal">x</td>')).toEqual(
      [],
    )
    expect(findWrappingCells('const a = <div className="flex-wrap">x</div>')).toEqual([])
  })

  it('applies each rule only where it belongs', () => {
    const table = '<table className="w-full">'
    expect(checkFile('packages/addon-training/src/page/X.tsx', table)).toHaveLength(1)
    expect(checkFile('packages/ui-library/src/composites/data-table.tsx', table)).toEqual([])
    const cell = 'const a = <td className="flex-wrap">x</td>'
    expect(checkFile('packages/ui-library/src/composites/x.tsx', cell)).toHaveLength(1)
    expect(checkFile('packages/addon-admin-ui/src/pages/X.tsx', cell)).toEqual([])
    expect(checkFile('packages/addon-admin-ui/src/pages/X.spec.tsx', table)).toEqual([])
  })
})
