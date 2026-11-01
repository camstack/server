import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

/**
 * `scripts/install/camstack-install.sh` runs for real, against fakes on PATH:
 * `curl` serves a local "Node mirror", `npm` lays down a CLI that answers
 * `--version`. No network, no real Node download.
 */
const SCRIPT = path.resolve(__dirname, '../install/camstack-install.sh')
const ARCHIVE_NAMES: Record<string, string> = {
  'linux-x64': 'node-v24.9.0-linux-x64.tar.gz',
  'linux-arm64': 'node-v24.9.0-linux-arm64.tar.gz',
  'darwin-x64': 'node-v24.9.0-darwin-x64.tar.gz',
  'darwin-arm64': 'node-v24.9.0-darwin-arm64.tar.gz',
}

let dir: string
let home: string
let bin: string
let mirror: string

function write(file: string, body: string, mode = 0o755): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, body, { mode })
}

/** The platform archive the script will ask for, holding a fake `bin/node` and `bin/npm`. */
function buildMirror(corruptSha: boolean): void {
  const platform = `${os.platform()}-${os.arch() === 'arm64' ? 'arm64' : 'x64'}`
  const name = ARCHIVE_NAMES[platform]
  if (name === undefined) throw new Error(`unsupported test platform ${platform}`)
  const stage = path.join(dir, 'stage', name.replace('.tar.gz', ''))
  write(path.join(stage, 'bin', 'node'), '#!/bin/sh\necho "v24.9.0"\n')
  write(path.join(stage, 'bin', 'npm'), npmScript())
  const out = path.join(mirror, 'latest-v24.x')
  fs.mkdirSync(out, { recursive: true })
  const r = spawnSync('tar', [
    '-czf',
    path.join(out, name),
    '-C',
    path.join(dir, 'stage'),
    name.replace('.tar.gz', ''),
  ])
  expect(r.status).toBe(0)
  const sha = createHash('sha256')
    .update(fs.readFileSync(path.join(out, name)))
    .digest('hex')
  const listed = corruptSha ? '0'.repeat(64) : sha
  fs.writeFileSync(path.join(out, 'SHASUMS256.txt'), `${listed}  ${name}\n`)
}

/** `npm install --prefix <dir> camstack@<v>` -> a CLI whose `--version` works. */
function npmScript(): string {
  return `#!/bin/sh
if [ "$1" = "view" ]; then echo "9.9.9"; exit 0; fi
if [ "$1" = "install" ]; then
  prefix="$3"
  mkdir -p "$prefix/node_modules/camstack/dist"
  printf 'echo' > "$prefix/node_modules/camstack/dist/cli.js"
  exit 0
fi
exit 1
`
}

/** `curl -fsSL <url> -o <file>`: the URL's tail under the mirror root is copied. */
function installFakeCurl(): void {
  write(
    path.join(bin, 'curl'),
    `#!/bin/sh
url=""; out=""
while [ $# -gt 0 ]; do
  case "$1" in -o) out="$2"; shift 2 ;; -*) shift ;; *) url="$1"; shift ;; esac
done
src="${mirror}/\${url#*/dist/}"
[ -f "$src" ] || exit 22
cp "$src" "$out"
`,
  )
}

function runInstaller(extraEnv: Record<string, string>): { status: number | null; out: string } {
  // Hide any real node/npm: PATH holds the fakes plus the system tools only.
  const r = spawnSync('sh', [SCRIPT], {
    encoding: 'utf8',
    env: {
      HOME: home,
      PATH: `${bin}:/usr/bin:/bin`,
      TMPDIR: dir,
      CAMSTACK_NODE_DIST: 'https://mirror.test/dist',
      CAMSTACK_VERSION: '1.2.3',
      ...extraEnv,
    },
  })
  return { status: r.status, out: `${r.stdout}${r.stderr}` }
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'camstack-install-spec-'))
  home = path.join(dir, 'home')
  bin = path.join(dir, 'fakebin')
  mirror = path.join(dir, 'mirror')
  fs.mkdirSync(home, { recursive: true })
  fs.mkdirSync(bin, { recursive: true })
  installFakeCurl()
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

describe('camstack-install.sh', () => {
  it('on a host without Node 24: fetches a sha256-verified runtime, stages the CLI, writes the launcher', () => {
    buildMirror(false)
    const { status, out } = runInstaller({})
    expect(out).toContain('installed')
    expect(status).toBe(0)
    const root = path.join(home, '.local', 'share', 'camstack')
    expect(fs.existsSync(path.join(root, 'runtime', 'bin', 'node'))).toBe(true)
    expect(fs.readlinkSync(path.join(root, 'current'))).toBe(path.join(root, 'cli', '1.2.3'))
    expect(
      fs.existsSync(path.join(root, 'cli', '1.2.3', 'node_modules', 'camstack', 'dist', 'cli.js')),
    ).toBe(true)
    const launcher = fs.readFileSync(path.join(home, '.local', 'bin', 'camstack'), 'utf8')
    expect(launcher).toContain(`ROOT="${root}"`)
    expect(fs.statSync(path.join(home, '.local', 'bin', 'camstack')).mode & 0o111).not.toBe(0)
  })

  it('refuses a runtime whose sha256 does not match, and installs nothing', () => {
    buildMirror(true)
    const { status, out } = runInstaller({})
    expect(status).not.toBe(0)
    expect(out).toContain('sha256 mismatch')
    const root = path.join(home, '.local', 'share', 'camstack')
    expect(fs.existsSync(path.join(root, 'runtime'))).toBe(false)
    expect(fs.existsSync(path.join(root, 'current'))).toBe(false)
    expect(fs.existsSync(path.join(home, '.local', 'bin', 'camstack'))).toBe(false)
  })

  it('uses the host Node when it is 24 or newer: no download, no runtime directory', () => {
    write(path.join(bin, 'node'), '#!/bin/sh\necho 24\n')
    write(path.join(bin, 'npm'), npmScript())
    const { status } = runInstaller({ CAMSTACK_NODE_DIST: 'https://mirror.test/never' })
    expect(status).toBe(0)
    const root = path.join(home, '.local', 'share', 'camstack')
    expect(fs.existsSync(path.join(root, 'runtime'))).toBe(false)
    expect(fs.readlinkSync(path.join(root, 'current'))).toBe(path.join(root, 'cli', '1.2.3'))
  })

  it('a second version keeps the first as `previous` and never touches ~/.camstack', () => {
    write(path.join(bin, 'node'), '#!/bin/sh\necho 24\n')
    write(path.join(bin, 'npm'), npmScript())
    const session = path.join(home, '.camstack', 'session.json')
    write(session, '{"keep":"me"}', 0o600)
    expect(runInstaller({ CAMSTACK_VERSION: '1.2.3' }).status).toBe(0)
    expect(runInstaller({ CAMSTACK_VERSION: '1.2.4' }).status).toBe(0)
    const root = path.join(home, '.local', 'share', 'camstack')
    expect(fs.readlinkSync(path.join(root, 'current'))).toBe(path.join(root, 'cli', '1.2.4'))
    expect(fs.readlinkSync(path.join(root, 'previous'))).toBe(path.join(root, 'cli', '1.2.3'))
    expect(fs.readFileSync(session, 'utf8')).toBe('{"keep":"me"}')
  })

  it('rejects a version that is not a version, before any download', () => {
    write(path.join(bin, 'node'), '#!/bin/sh\necho 24\n')
    write(path.join(bin, 'npm'), npmScript())
    const { status, out } = runInstaller({ CAMSTACK_VERSION: '1.2.3; rm -rf /' })
    expect(status).not.toBe(0)
    expect(out).toContain('is not a version')
  })
})
