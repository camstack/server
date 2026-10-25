/**
 * The data door is TWO capabilities in series, and their input schemas must
 * agree field for field.
 *
 * A read enters at `settings-store` (the door every addon holds) and is handed
 * to `data-store-provider` (the engine behind it) by `createDataStoreDispatch`,
 * which forwards the input object verbatim. Both hops validate with Zod, and a
 * Zod object STRIPS what it does not declare — silently, with no error. So a
 * field added to the door and forgotten on the engine does not fail: it
 * disappears one hop before the engine and the caller sees the un-narrowed
 * answer and concludes the feature does nothing.
 *
 * That is exactly what happened while `columns` (the SQL column projection) was
 * added to `settings-store.query` alone: the door accepted it, the dispatcher
 * forwarded it, and `data-store-provider.query` parsed it away. The engine
 * received `{ namespace, collection, filter }` and read every column of every
 * row, on a change whose entire purpose was to stop doing that.
 *
 * This compares the KEY SETS, not the types — the two schemas are written
 * independently on purpose, and only their surface has to match.
 */
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { dataStoreProviderCapability } from '../data-store-provider.cap.js'
import { settingsStoreCapability } from '../settings-store.cap.js'

/** The top-level field names of a capability method's input object schema. */
function inputKeys(schema: z.ZodType): readonly string[] {
  if (!(schema instanceof z.ZodObject)) {
    throw new Error('expected an object schema — this test only compares object inputs')
  }
  return Object.keys(schema.shape).toSorted()
}

/** Methods present on BOTH capabilities — the ones the dispatcher forwards. */
const FORWARDED_METHODS = [
  'get',
  'set',
  'query',
  'insert',
  'insertMany',
  'transact',
  'update',
  'delete',
  'deleteWhere',
  'updateWhere',
  'count',
  'histogram',
  'isEmpty',
  'declareCollection',
] as const

describe('settings-store ⇄ data-store-provider input parity', () => {
  it.each(
    FORWARDED_METHODS,
  )('%s declares the same input fields on the door and on the engine', (name) => {
    const door = settingsStoreCapability.methods[name]
    const engine = dataStoreProviderCapability.methods[name]
    expect(
      engine,
      `data-store-provider has no "${name}" — the dispatcher forwards it`,
    ).toBeDefined()
    expect(inputKeys(engine.input)).toEqual(inputKeys(door.input))
  })

  it('query carries the column projection on BOTH — the field that was stripped', () => {
    expect(inputKeys(settingsStoreCapability.methods.query.input)).toContain('columns')
    expect(inputKeys(dataStoreProviderCapability.methods.query.input)).toContain('columns')
  })

  it('the engine really would strip an undeclared field — the failure this pins', () => {
    // Not a hypothetical: this is Zod's documented default, and it is the
    // reason the parity above cannot be left to review.
    const parsed = z
      .object({ collection: z.string() })
      .parse({ collection: 'tracks', columns: ['id'] })
    expect(parsed).toEqual({ collection: 'tracks' })
  })
})
