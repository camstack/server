#!/usr/bin/env node
/**
 * Privileged package helper (D326).
 *
 * Started by docker-entrypoint.sh WHILE STILL ROOT, before `gosu camstack`.
 * Listens on a Unix socket the camstack user can write; runs allowlisted
 * apt/apk/dnf installs. Hub-main and every addon-runner are uid 1001 and
 * must never exec apt themselves.
 *
 * Baked into the image — applyServerUpdate must not replace a root process.
 */
import { spawn } from 'node:child_process'
import { readFileSync, chmodSync, chownSync } from 'node:fs'
import { createServer } from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SOCKET = process.env.CAMSTACK_PKGD_SOCKET ?? '/run/camstack/pkgd.sock'
const ALLOWLIST_PATH =
  process.env.CAMSTACK_PKG_ALLOWLIST ?? '/usr/local/share/camstack/pkg-allowlist.json'
const INSTALL_TIMEOUT_MS = 5 * 60 * 1000

function loadAllowlist() {
  let path = ALLOWLIST_PATH
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    path = join(dirname(fileURLToPath(import.meta.url)), 'pkg-allowlist.json')
    return JSON.parse(readFileSync(path, 'utf8'))
  }
}

const allowlist = loadAllowlist()

function allowed(manager, packageName) {
  if (typeof packageName !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9+._-]*$/.test(packageName)) {
    return false
  }
  const list = allowlist[manager]
  return Array.isArray(list) && list.includes(packageName)
}

function plan(manager, packageName) {
  switch (manager) {
    case 'apt':
      return [
        ['apt-get', ['update']],
        ['apt-get', ['install', '-y', '--no-install-recommends', packageName]],
      ]
    case 'apk':
      return [['apk', ['add', '--no-cache', packageName]]]
    case 'dnf':
      return [['dnf', ['install', '-y', packageName]]]
    default:
      return null
  }
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const stderr = []
    const stdout = []
    child.stderr.on('data', (c) => stderr.push(c))
    child.stdout.on('data', (c) => stdout.push(c))
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`${command} timed out`))
    }, INSTALL_TIMEOUT_MS)
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve()
      else {
        const errText = Buffer.concat(stderr).toString('utf8').trim()
        const outText = Buffer.concat(stdout).toString('utf8').trim()
        reject(new Error(errText || outText || `${command} exited ${code}`))
      }
    })
  })
}

/** One install at a time — apt holds a lock. */
let chain = Promise.resolve()

function handle(req) {
  const manager = req.manager
  const packageName = req.packageName ?? req.package
  if (!allowed(manager, packageName)) {
    return Promise.resolve({ v: 1, ok: false, error: 'not-allowlisted' })
  }
  const steps = plan(manager, packageName)
  if (steps === null) {
    return Promise.resolve({ v: 1, ok: false, error: `unsupported manager ${manager}` })
  }
  chain = chain
    .catch(() => undefined)
    .then(async () => {
      for (const [command, args] of steps) await run(command, args)
    })
  return chain.then(
    () => ({ v: 1, ok: true }),
    (err) => ({ v: 1, ok: false, error: err instanceof Error ? err.message : String(err) }),
  )
}

const server = createServer((socket) => {
  const chunks = []
  socket.on('data', (data) => {
    chunks.push(data)
    const text = Buffer.concat(chunks).toString('utf8')
    const nl = text.indexOf('\n')
    if (nl === -1) return
    let req
    try {
      req = JSON.parse(text.slice(0, nl))
    } catch (err) {
      socket.end(`${JSON.stringify({ v: 1, ok: false, error: String(err) })}\n`)
      return
    }
    console.info(
      `[camstack-pkgd] request addon=${req.addonId ?? '?'} pkg=${req.packageName ?? req.package} manager=${req.manager}`,
    )
    handle(req).then((result) => {
      socket.end(`${JSON.stringify(result)}\n`)
    })
  })
})

server.on('error', (err) => {
  console.error(`[camstack-pkgd] ${err.message}`)
  process.exit(1)
})

try {
  const { unlinkSync } = await import('node:fs')
  unlinkSync(SOCKET)
} catch {
  // absent is the common case
}

server.listen(SOCKET, () => {
  try {
    chmodSync(SOCKET, 0o660)
    // camstack is uid/gid 1001 in the image.
    chownSync(SOCKET, 0, 1001)
  } catch (err) {
    console.warn(`[camstack-pkgd] could not chmod/chown socket: ${err.message}`)
  }
  console.info(`[camstack-pkgd] listening on ${SOCKET}`)
})
