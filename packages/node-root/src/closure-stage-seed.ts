/**
 * Seed a staging directory from the running `current/` closure so `npm
 * install <pkg>@X` only replaces packages whose version changed.
 *
 * A fresh `.staging-*` directory makes npm run every install script. node-av's
 * postinstall re-downloads the ffmpeg zip from GitHub on every update
 * (20–30 min at ~33 KB/s on little-unraid, 2026-11-12). Copying `current/`
 * first lets npm treat unchanged packages as already installed.
 *
 * The copy is a real copy (`fs.cp` with `dereference`), never a hardlink:
 * the starter later deletes or swaps `current/`, and a staged tree that
 * shared inodes with it would lose files out from under the install.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

const LOCKFILES: readonly string[] = ['package-lock.json', 'npm-shrinkwrap.json']

export async function seedStagingFromCurrent(
  currentDir: string,
  stagingDir: string,
): Promise<void> {
  const packageJson = path.join(currentDir, 'package.json')
  const nodeModules = path.join(currentDir, 'node_modules')
  if (!fs.existsSync(packageJson) || !fs.existsSync(nodeModules)) {
    throw new Error(
      `current closure at ${currentDir} has no package.json or node_modules to seed from`,
    )
  }
  await fs.promises.cp(packageJson, path.join(stagingDir, 'package.json'))
  for (const name of LOCKFILES) {
    const source = path.join(currentDir, name)
    if (!fs.existsSync(source)) continue
    await fs.promises.cp(source, path.join(stagingDir, name))
  }
  await fs.promises.cp(nodeModules, path.join(stagingDir, 'node_modules'), {
    recursive: true,
    dereference: true,
  })
}
