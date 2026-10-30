import { describe, expect, it } from 'vitest'
import { HA_GUIDE, exportSet, readExports } from '../mcp/configure-exports.js'
import { withWrites } from './configure-gate-ctx.js'
import { fakeHub } from './ops-fake-hub.js'

const QR = 'HAP-QR-PAYLOAD-X-HM://secret'
const SETUP_CODE = '031-45-154'

const reads = {
  'addons.listCapabilityProviders': [
    { addonId: 'homeassistant-export' },
    { addonId: 'export-hap' },
  ],
  'deviceManager.listAll': [
    { id: 587, name: 'Porch' },
    { id: 12, name: 'Garage' },
  ],
  'deviceExport.getStatus': {
    linkState: 'linked',
    exposedDeviceCount: 2,
    setup: {
      qr: QR,
      fields: [{ label: 'Setup code', value: SETUP_CODE }],
      note: 'scan',
    },
  },
  'deviceExport.listExposedDevices': [
    { deviceId: '587', exposedAs: 'camera' },
    { deviceId: '900', exposedAs: 'light' },
  ],
  'deviceExport.exposeDevice': undefined,
  'deviceExport.unexposeDevice': undefined,
}

describe('configure_exports', () => {
  it('lists exporters and exposed cameras, and never the pairing block', async () => {
    const { ctx } = fakeHub(reads)
    const out = await readExports(ctx, {})
    const body = JSON.stringify(out)
    expect(body).not.toContain(QR)
    expect(body).not.toContain(SETUP_CODE)
    expect(out).toMatchObject({
      exporters: [
        {
          addonId: 'homeassistant-export',
          linkState: 'linked',
          cameras: [{ deviceId: 587, name: 'Porch' }],
        },
        { addonId: 'export-hap' },
      ],
    })
  })
})

describe('configure_export_set', () => {
  it('hides an exposed camera through unexposeDevice with a string device id', async () => {
    const { ctx, calls } = fakeHub(reads)
    const w = withWrites(ctx)
    const args = {
      addonId: 'homeassistant-export',
      deviceId: 587,
      exposed: false,
    }
    const preview = await exportSet(w, args, undefined)
    if (preview.status !== 'dry-run') throw new Error(JSON.stringify(preview))
    await exportSet(w, args, preview.confirm_token)
    expect(calls.find((c) => c.path === 'deviceExport.unexposeDevice')?.input).toEqual({
      addonId: 'homeassistant-export',
      deviceId: '587',
    })
  })

  it('refuses a no-op, an unknown exporter and a device that is not a camera', async () => {
    const { ctx } = fakeHub(reads)
    const w = withWrites(ctx)
    const text = async (a: object): Promise<string> =>
      JSON.stringify(
        await exportSet(
          w,
          {
            addonId: 'homeassistant-export',
            deviceId: 587,
            exposed: true,
            ...a,
          },
          undefined,
        ),
      )
    expect(await text({})).toMatch(/already shown/)
    expect(await text({ addonId: 'nope' })).toMatch(/is not an exporter/)
    expect(await text({ deviceId: 900 })).toMatch(/not a camera/)
  })
})

describe('configure_ha_guide', () => {
  it('names HACS and says the distribution may change, in neutral wording', () => {
    const body = HA_GUIDE.join('\n')
    expect(body).toMatch(/HACS/)
    expect(body).toMatch(/may change/)
    expect(body).toMatch(/current Home Assistant and HACS documentation/)
  })
})
