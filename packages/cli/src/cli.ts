/**
 * The `camstack` entry. It imports nothing the real CLI needs: on a Node that
 * is too old it prints the installer line and stops, instead of failing with a
 * syntax or missing-API error from somewhere deep in `main.js`.
 */
import { checkNodeVersion } from './node-guard.js'

const verdict = checkNodeVersion(process.versions.node)
if (!verdict.ok) {
  process.stderr.write(`${verdict.message}\n`)
  process.exit(verdict.exitCode)
}
// A computed specifier, so the bundler keeps `main.js` a separate file that is
// only loaded here, after the check.
await import(new URL('./main.js', import.meta.url).href)
