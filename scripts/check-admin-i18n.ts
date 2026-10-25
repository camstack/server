/**
 * Guard: no user-visible literal in the admin UI (or in the ui-library the
 * admin renders) bypasses i18n.
 *
 * Every JSX text, user-visible prop (`title`, `label`, `placeholder`, ...) and
 * display object property (`header`, `message`, `confirmLabel`, ...) in
 * `packages/addon-admin-ui/src/**\/*.tsx` and `packages/ui-library/src/**\/*.tsx`
 * must go through `t(...)` / `<Trans>` (admin) or `useUiText()` / `<UiTrans>`
 * (ui-library), with the key in `en.json` AND `it.json` (the key-parity spec
 * checks that half). Intentional non-text — a brand name, a literal field
 * name, a code sample — is exempted in place with an `i18n-ignore: <reason>`
 * marker; the mechanism is documented in `scripts/i18n/find-untranslated-admin.ts`.
 *
 *   npx tsx scripts/check-admin-i18n.ts            # the guard
 *   npx tsx scripts/i18n/find-untranslated-admin.ts --verbose   # every finding
 */
import { scanAll } from './i18n/find-untranslated-admin.js'

const findings = scanAll(true)
if (findings.length > 0) {
  for (const f of findings) {
    process.stderr.write(`${f.file}:${f.line}  [${f.kind}:${f.name}] ${f.text}\n`)
  }
  process.stderr.write(
    `\ncheck-admin-i18n: ${findings.length} untranslated literal(s). Translate them with t()/<Trans> ` +
      `(or mark intentional non-text with \`i18n-ignore: <reason>\`).\n`,
  )
  process.exit(1)
}
process.stdout.write(
  'check-admin-i18n: ok — every admin-ui / ui-library literal goes through i18n\n',
)
