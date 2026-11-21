/**
 * `generate-method-descriptions.ts`: a cap method's description is the first
 * JSDoc paragraph above its property, as plain text.
 */
import { describe, expect, it } from 'vitest'
import { firstParagraph, jsdocByMethod } from '../generate-method-descriptions.ts'

const SOURCE = `
export const demoCapability = {
  name: 'demo-cap',
  methods: {
    /**
     * Lists the \`widgets\` the hub knows,
     * newest first.
     *
     * Second paragraph is not carried.
     * @deprecated nope
     */
    list: method(a, b),
    // a line comment is not a description
    plain: method(a, b),
    /** Wipes one widget. */
    'wipe-one': method(a, b),
  },
}
`

describe('jsdocByMethod', () => {
  const byCap = jsdocByMethod(SOURCE, 'demo.cap.ts')
  it('takes the first paragraph, plain, on one line', () => {
    expect(byCap.get('demo-cap')?.get('list')).toBe(
      'Lists the widgets the hub knows, newest first.',
    )
    expect(byCap.get('demo-cap')?.get('wipe-one')).toBe('Wipes one widget.')
  })
  it('leaves a method without a JSDoc out', () => {
    expect(byCap.get('demo-cap')?.has('plain')).toBe(false)
  })
  it('firstParagraph of blank text is null', () => {
    expect(firstParagraph('  \n\n ')).toBeNull()
  })
})
