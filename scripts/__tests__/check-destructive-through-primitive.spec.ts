import { describe, expect, it } from 'vitest'
import { bareDestructiveCalls, findViolations } from '../check-destructive-through-primitive.js'

const UI = 'packages/addon-admin-ui/src/'
const file = (p: string, text: string) => ({ path: UI + p, text })
const EMPTY = { families: {} }

const CONFIRM_THEN_MUTATE = file(
  'pages/Widgets.tsx',
  `const ok = await confirm({ title: 'Delete?', message: 'm', variant: 'danger' })
if (!ok) return
removeWidget.mutate({ id })`,
)
const CONFIRM_WITH_ACTION = file(
  'pages/Widgets.tsx',
  `await confirm({
  title: 'Delete?',
  message: 'm',
  variant: 'danger',
  action: () => removeWidget.mutateAsync({ id }),
})`,
)
const TABLE_ROW = file(
  'pages/Rows.tsx',
  `render: (row, _i, table) => (
  <Btn onClick={() => table.destructive(row, {
    title: 't',
    message: 'm',
    run: async () => {
      await system.trpcClient.things.deleteThing.mutate({ id: row.id })
    },
  })} />
)`,
)
const MUTATION_DEFINITION = file(
  'pages/Defs.tsx',
  `const remove = useMutation({
  mutationFn: (id: string) => trpcClient.things.delete.mutate({ id }),
})`,
)

describe('check-destructive-through-primitive', () => {
  it('refuses a confirm that closes and then fires the mutation bare', () => {
    expect(bareDestructiveCalls(CONFIRM_THEN_MUTATE)).toEqual([3])
    expect(findViolations([CONFIRM_THEN_MUTATE], EMPTY)).toHaveLength(1)
  })

  it('accepts the two approved paths and a mutation definition', () => {
    for (const ok of [CONFIRM_WITH_ACTION, TABLE_ROW, MUTATION_DEFINITION]) {
      expect(bareDestructiveCalls(ok)).toEqual([])
    }
  })

  it('skips specs and files outside the admin UI pages and components', () => {
    expect(
      bareDestructiveCalls({ ...CONFIRM_THEN_MUTATE, path: `${UI}pages/__tests__/x.tsx` }),
    ).toEqual([])
    expect(bareDestructiveCalls({ ...CONFIRM_THEN_MUTATE, path: 'packages/other/x.tsx' })).toEqual(
      [],
    )
  })

  it('lets a listed file pass, and refuses a listed file that no longer breaks the rule', () => {
    const listed = { families: { legacy: { [CONFIRM_THEN_MUTATE.path]: 'not migrated yet' } } }
    expect(findViolations([CONFIRM_THEN_MUTATE], listed)).toEqual([])
    expect(findViolations([CONFIRM_WITH_ACTION], listed)).toHaveLength(1)
  })
})
