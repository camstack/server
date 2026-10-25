/**
 * Writes `packages/addon-export-alexa/lambda-template/page-style.js`: the hub's
 * own sign-in / consent page stylesheet (`APP_PAGE_STYLE`, generated from the
 * admin theme tokens) as a constant the skill Lambda ships. The Lambda has no
 * build step and no access to the monorepo, so the page it renders for the
 * hub-address step would otherwise be a hand-copied look-alike.
 *
 * Run after a theme or `app-page-shell` change:
 *
 *   npx tsx scripts/gen-alexa-lambda-page-style.ts
 *
 * A spec (`server/backend/src/auth/__tests__/alexa-lambda-page-style.spec.ts`)
 * fails when the committed file differs from what this would write.
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { alexaLambdaPageStyleSource } from '../server/backend/src/auth/alexa-lambda-page-style.js'

const target = join(
  import.meta.dirname,
  '..',
  'packages',
  'addon-export-alexa',
  'lambda-template',
  'page-style.js',
)
writeFileSync(target, alexaLambdaPageStyleSource())
console.log(`wrote ${target}`)
