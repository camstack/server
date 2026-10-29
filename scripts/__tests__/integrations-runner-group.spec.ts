/**
 * The `integrations` runner group (D29): non-live, frame-free, low-crash
 * integration addons share ONE runner instead of one ~150 MB process each.
 *
 * Membership is PINNED here. Adding an addon to the group is a decision that
 * needs the D29 argument (no frames, no devices, no delivery path), so it must
 * change this list in the same commit. The exclusions are pinned too, with the
 * reason each one stays alone — a future "just one more" fails here.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = resolve(__dirname, '../..')

interface ManifestAddon {
  readonly id: string
  readonly brokerKind?: string
  readonly dataPlanes?: readonly unknown[]
  readonly execution?: { readonly group?: string }
  readonly capabilities?: readonly { readonly name: string }[]
}

function addonsOf(pkgDir: string): readonly ManifestAddon[] {
  const pkg: { camstack?: { addons?: ManifestAddon[] } } = JSON.parse(
    readFileSync(join(ROOT, pkgDir, 'package.json'), 'utf8'),
  )
  return pkg.camstack?.addons ?? []
}

function addon(pkgDir: string, id: string): ManifestAddon {
  const found = addonsOf(pkgDir).find((a) => a.id === id)
  if (found === undefined) throw new Error(`${id} not in ${pkgDir}`)
  return found
}

/** id → package directory. */
const MEMBERS: Readonly<Record<string, string>> = {
  'export-google': 'packages/addon-export-google',
  'homeassistant-export': 'packages/addon-provider-homeassistant',
  'waste-collections': 'packages/addon-waste-collections',
  'osd-manager': 'packages/addon-osd-manager',
}

/** Considered and kept out, with the reason (D29). */
const EXCLUDED: Readonly<Record<string, { pkg: string; why: string }>> = {
  'import-alexa': {
    pkg: 'packages/addon-import-alexa',
    why: 'device provider (broker, device-adoption)',
  },
  'google-services': {
    pkg: 'packages/addon-google-services',
    why: 'declares the broker capability',
  },
  'export-alexa': {
    pkg: 'packages/addon-export-alexa',
    why: 'live view egress: WebRTC, RTSP, ffmpeg, key frames',
  },
  training: { pkg: 'packages/addon-training', why: 'moves dataset and artifact bytes (peerBytes)' },
  'training-modal': {
    pkg: 'packages/addon-training',
    why: 'moves dataset and artifact bytes (peerBytes)',
  },
  'admin-ui': { pkg: 'packages/addon-admin-ui', why: 'the operator recovery surface' },
  'auth-oidc': { pkg: 'packages/addon-auth', why: 'login must not die with a sibling' },
  'sftp-storage': { pkg: 'packages/addon-remote-storage', why: 'recording and backup writes' },
  'tailscale-client': { pkg: 'packages/addon-tailscale', why: 'remote access path' },
  notifiers: { pkg: 'packages/addon-notifiers', why: 'delivery must not die with a sibling' },
}

describe('the integrations runner group', () => {
  for (const [id, pkg] of Object.entries(MEMBERS)) {
    it(`${id} declares execution.group "integrations"`, () => {
      expect(addon(pkg, id).execution?.group).toBe('integrations')
    })
  }

  it('no member is a device provider, a data plane, a notifier, storage or auth', () => {
    const forbidden = new Set([
      'broker',
      'device-adoption',
      'notification-output',
      'storage-provider',
      'auth-provider',
      'login-method',
    ])
    for (const [id, pkg] of Object.entries(MEMBERS)) {
      const a = addon(pkg, id)
      expect(a.brokerKind, id).toBeUndefined()
      expect(a.dataPlanes ?? [], id).toEqual([])
      const bad = (a.capabilities ?? []).map((c) => c.name).filter((n) => forbidden.has(n))
      expect(bad, id).toEqual([])
    }
  })

  it('exactly the pinned addons carry the group, repository-wide', () => {
    const carriers: string[] = []
    for (const root of ['packages', 'server']) {
      for (const entry of readdirSync(join(ROOT, root), { withFileTypes: true })) {
        if (!entry.isDirectory() || !existsSync(join(ROOT, root, entry.name, 'package.json')))
          continue
        for (const a of addonsOf(`${root}/${entry.name}`)) {
          if (a.execution?.group === 'integrations') carriers.push(a.id)
        }
      }
    }
    expect(carriers.sort()).toEqual(Object.keys(MEMBERS).sort())
  })

  it('every considered-and-excluded addon is NOT in the group', () => {
    for (const [id, { pkg }] of Object.entries(EXCLUDED)) {
      expect(addon(pkg, id).execution?.group, id).not.toBe('integrations')
    }
  })
})
