/**
 * The skill Lambda's hub-address page wears the hub's own page stylesheet. The
 * Lambda cannot import it, so it ships a generated copy
 * (`lambda-template/page-style.js`); this holds the copy to the source.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { alexaLambdaPageStyleSource } from '../alexa-lambda-page-style.js'

describe('lambda-template/page-style.js', () => {
  it('is what the generator would write now (run scripts/gen-alexa-lambda-page-style.ts)', () => {
    const committed = readFileSync(
      join(
        import.meta.dirname,
        '../../../../../packages/addon-export-alexa/lambda-template/page-style.js',
      ),
      'utf8',
    )
    expect(committed).toBe(alexaLambdaPageStyleSource())
  })
})
