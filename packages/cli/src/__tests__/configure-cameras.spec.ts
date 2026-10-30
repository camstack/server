import { describe, expect, it } from 'vitest'
import {
  addCamera,
  configureCameraDiscover,
  configureCameraProviders,
} from '../mcp/configure-cameras.js'
import { ADDRESSES, asProtectedTier, dryRunOf, gatedHub, writes } from './configure-fixtures.js'

const reolinkForm = {
  sections: [
    {
      id: 'identity',
      fields: [{ type: 'text', key: 'name', label: 'Name', required: true }],
    },
    {
      id: 'credentials',
      fields: [
        { type: 'text', key: 'username', label: 'Username', required: true },
        {
          type: 'password',
          key: 'password',
          label: 'Password',
          required: true,
        },
      ],
    },
    {
      id: 'connection',
      fields: [
        {
          type: 'select',
          key: 'transport',
          label: 'Connection mode',
          options: [{ value: 'auto' }, { value: 'tcp' }, { value: 'udp' }],
        },
        { type: 'probe', key: 'host', label: 'Host', required: true },
      ],
    },
  ],
}

const answers = (extra: { [path: string]: unknown } = {}): { [path: string]: unknown } => ({
  'addons.list': [
    {
      manifest: {
        id: 'provider-reolink',
        name: 'Reolink',
        description: 'Native Baichuan protocol connection to Reolink cameras',
        packageName: '@camstack/addon-provider-reolink',
        packageVersion: '1.2.213',
        capabilities: [{ name: 'device-provider' }, { name: 'stream-params' }],
      },
    },
    {
      manifest: {
        id: 'sqlite-settings',
        packageName: '@camstack/system',
        packageVersion: '1.2.523',
        capabilities: ['storage-provider'],
      },
    },
  ],
  'deviceManager.discoveryProviders': {
    providers: [{ addonId: 'provider-reolink', label: 'Reolink' }],
  },
  'addons.searchAvailable': [
    {
      name: '@camstack/addon-provider-reolink',
      version: '1.2.213',
      description: 'Reolink',
      keywords: ['reolink'],
      installed: true,
      capabilities: ['device-provider'],
    },
    {
      name: '@camstack/addon-provider-amcrest',
      version: '0.2.162',
      description: 'Amcrest/Dahua camera device provider addon',
      keywords: ['amcrest', 'dahua', 'camera'],
      installed: false,
      capabilities: ['device-provider'],
    },
  ],
  'deviceManager.getCreationSchema': reolinkForm,
  'localNetwork.getAddresses': ADDRESSES,
  ...extra,
})

describe('configure_camera_providers', () => {
  it('lists the installed device providers and, separately, the uninstalled ones', async () => {
    const { ctx } = gatedHub(answers())
    const out = await configureCameraProviders(ctx, undefined)
    if (out.status !== 'ok') throw new Error('expected ok')
    expect(out.installed?.map((p) => p.addonId)).toEqual(['provider-reolink'])
    expect(out.installed?.[0]).toMatchObject({ discovery: true })
    expect(out.available?.map((p) => p.packageName)).toEqual(['@camstack/addon-provider-amcrest'])
  })

  it('a brand nothing matches is unsupported with the support pointer', async () => {
    const { ctx } = gatedHub(answers())
    const out = await configureCameraProviders(ctx, 'Zorblax')
    expect(out).toMatchObject({
      status: 'unsupported',
      hint: 'use support_diagnose_camera / support_draft_issue',
    })
    const hit = await configureCameraProviders(ctx, 'Dahua camera')
    if (hit.status !== 'ok') throw new Error('expected ok')
    expect(hit.available?.map((p) => p.packageName)).toEqual(['@camstack/addon-provider-amcrest'])
  })
})

describe('configure_camera_discover', () => {
  it('lists candidates with non-secret fields only', async () => {
    const { ctx, calls } = gatedHub(
      answers({
        'deviceManager.discoverProvider': {
          candidates: [
            {
              stableId: 'cam-1',
              type: 'camera',
              suggestedName: 'Garage',
              prefilledConfig: {
                host: '192.0.2.10',
                password: 'leaked-by-provider',
              },
            },
          ],
        },
      }),
    )
    const out = await configureCameraDiscover(ctx, {
      addonId: 'provider-reolink',
    })
    if (out.status !== 'ok') throw new Error('expected ok')
    expect(out.candidates?.[0]?.config).toEqual({ host: '192.0.2.10' })
    expect(out.candidates?.[0]?.secrets).toEqual({ password: 'set' })
    expect(JSON.stringify(out)).not.toContain('leaked-by-provider')
    expect(calls.some((c) => c.path === 'deviceManager.discoverProvider')).toBe(true)
  })

  it('refuses a credential in params and an unknown provider', async () => {
    const hub = gatedHub(answers({ 'deviceManager.discoverProvider': { candidates: [] } }))
    const secret = await configureCameraDiscover(hub.ctx, {
      addonId: 'provider-reolink',
      params: { password: 'sent-by-model' },
    })
    expect(secret).toMatchObject({ status: 'secret-required' })
    expect(JSON.stringify(secret)).not.toContain('sent-by-model')
    expect(hub.calls.some((c) => c.path === 'deviceManager.discoverProvider')).toBe(false)
    expect(await configureCameraDiscover(hub.ctx, { addonId: 'provider-nope' })).toMatchObject({
      status: 'unsupported',
    })
  })

  it('needs an admin session', async () => {
    const hub = gatedHub(answers())
    const out = await configureCameraDiscover(await asProtectedTier(hub.ctx), {
      addonId: 'provider-reolink',
    })
    expect(out).toMatchObject({ status: 'refused' })
  })
})

describe('configure_camera_add', () => {
  const args = {
    addonId: 'provider-reolink',
    config: {
      name: 'Garage',
      username: 'admin',
      host: '192.0.2.10',
      transport: 'tcp',
    },
  }

  it('previews, then creates with the non-secret fields and hands back the secret step', async () => {
    const hub = gatedHub(
      answers({
        'deviceManager.createDevice': { id: 42, name: 'Garage', stableId: 's' },
      }),
    )
    const dry = dryRunOf(await addCamera(hub.ctx, args, undefined))
    expect(writes(hub.calls)).toHaveLength(0)
    expect(JSON.stringify(dry.describe)).toContain('"field":"password"')

    const done = await addCamera(hub.ctx, args, dry.token)
    const sent = writes(hub.calls)
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({
      path: 'deviceManager.createDevice',
      input: {
        addonId: 'provider-reolink',
        type: 'camera',
        config: args.config,
      },
    })
    expect(done).toMatchObject({
      status: 'executed',
      result: {
        created: true,
        deviceId: 42,
        adminUi: 'https://hub.example.test/devices/42',
        incompleteUntilSecretSet: [{ status: 'secret-required', field: 'password' }],
      },
    })
  })

  it('a hub refusal is reported with the admin-UI form, not thrown', async () => {
    const hub = gatedHub(
      answers({
        'deviceManager.createDevice': new Error('password is required'),
      }),
    )
    const dry = dryRunOf(await addCamera(hub.ctx, args, undefined))
    const done = await addCamera(hub.ctx, args, dry.token)
    expect(done).toMatchObject({
      status: 'executed',
      result: {
        created: false,
        error: 'password is required',
        adminUi: 'https://hub.example.test/integrations/provider-reolink',
      },
    })
  })

  it('a password argument is dropped and refused; the value never shows', async () => {
    const hub = gatedHub(answers())
    const out = await addCamera(
      hub.ctx,
      { ...args, config: { ...args.config, password: 'cam-pass-1234' } },
      undefined,
    )
    expect(dryRunOf(out).token).toBeUndefined()
    expect(JSON.stringify(out)).toContain('secret-required')
    expect(JSON.stringify(out)).not.toContain('cam-pass-1234')
    expect(writes(hub.calls)).toHaveLength(0)
  })

  it('validates the form: missing required field, bad option', async () => {
    const hub = gatedHub(answers())
    const missing = JSON.stringify(
      await addCamera(hub.ctx, { addonId: 'provider-reolink', config: { name: 'x' } }, undefined),
    )
    expect(missing).toContain('host')
    const bad = JSON.stringify(
      await addCamera(
        hub.ctx,
        { ...args, config: { ...args.config, transport: 'pigeon' } },
        undefined,
      ),
    )
    expect(bad).toContain('transport')
    expect(bad).not.toContain('confirm_token')
  })

  it('an uninstalled provider and a provider without a manual form are unsupported', async () => {
    const hub = gatedHub(answers({ 'deviceManager.getCreationSchema': null }))
    expect(
      JSON.stringify(
        await addCamera(hub.ctx, { addonId: 'provider-amcrest', config: {} }, undefined),
      ),
    ).toContain('"status":"unsupported"')
    const noForm = JSON.stringify(
      await addCamera(hub.ctx, { addonId: 'provider-reolink', config: {} }, undefined),
    )
    expect(noForm).toContain('"status":"unsupported"')
    expect(noForm).toContain('support_diagnose_camera')
  })
})
