import { describe, expect, it } from 'vitest'
import { diagnoseAccelerator, supportDiagnoseAccelerator } from '../mcp/support-accelerator.js'
import { diagnoseCamera, supportDiagnoseCamera } from '../mcp/support-camera.js'
import { fakeHub, noSessionContext } from './ops-fake-hub.js'

const ultra = {
  platform: 'linux',
  arch: 'x64',
  cpuModel: 'Intel(R) Core(TM) Ultra 7 265K',
  cpuCores: 20,
  totalRAM_MB: 64000,
  availableRAM_MB: 30000,
  gpu: { type: 'intel', name: 'Arc' },
  npu: { type: 'intel-npu' },
}

const device = (key: string, over: object = {}): object => ({
  key,
  backend: key.split(':')[0],
  device: key.split(':')[1] ?? 'cpu',
  available: true,
  presence: 'present',
  enabled: true,
  exclusion: null,
  defaultModelId: 'yolov9m-320',
  ...over,
})

function hubWith(devices: readonly object[], hardware: object | Error = ultra) {
  return fakeHub({
    'platformProbe.getHardware': hardware,
    'pipelineOrchestrator.getNodeInferenceDevices': {
      reachable: true,
      devices,
    },
  })
}

describe('support_diagnose_accelerator', () => {
  it('answers no-session without a hub', async () => {
    expect(
      await supportDiagnoseAccelerator(noSessionContext(), {
        nodeId: 'hub',
        expected: 'intel-npu',
      }),
    ).toMatchObject({ status: 'no-session' })
  })

  it('ok: the runtime offers the device, available and enabled', async () => {
    const { ctx } = hubWith([device('openvino:npu')])
    const out = await supportDiagnoseAccelerator(ctx, {
      nodeId: 'hub',
      expected: 'intel-npu',
    })
    expect(out).toMatchObject({
      verdict: 'ok',
      matchedDevices: ['openvino:npu'],
    })
  })

  it('misconfigured: the probe sees the NPU but the runtime does not offer it -> /dev/accel steps', async () => {
    const { ctx } = hubWith([device('cpu')])
    const out = await supportDiagnoseAccelerator(ctx, {
      nodeId: 'hub',
      expected: 'intel-npu',
    })
    if (out.status !== 'ok') throw new Error('expected ok')
    expect(out.verdict).toBe('misconfigured')
    expect(out.summary).toContain('probe sees the hardware')
    expect(out.fixSteps.join('\n')).toContain('/dev/accel')
    expect(out.fixSteps.join('\n')).toContain('intel-latest')
  })

  it('misconfigured: an offered device that is listed but not available names the driver steps', async () => {
    const { ctx } = hubWith([device('openvino:gpu', { available: false, presence: 'absent' })])
    const out = await supportDiagnoseAccelerator(ctx, {
      nodeId: 'hub',
      expected: 'intel-igpu',
    })
    if (out.status !== 'ok') throw new Error('expected ok')
    expect(out.verdict).toBe('misconfigured')
    expect(out.fixSteps.join('\n')).toContain('/dev/dri')
  })

  it('a Coral that is present but not enabled is misconfigured and says how to opt in (D39)', async () => {
    const { ctx } = hubWith([device('edgetpu:usb', { enabled: false })])
    const out = await supportDiagnoseAccelerator(ctx, {
      nodeId: 'hub',
      expected: 'coral-usb',
    })
    if (out.status !== 'ok') throw new Error('expected ok')
    expect(out.verdict).toBe('misconfigured')
    expect(out.fixSteps.join('\n')).toContain('never picked automatically')
    expect(out.optIn.length).toBeGreaterThan(0)
  })

  it('a missing Coral USB cites the bus passthrough AND the cgroup rule from the install rules', async () => {
    const { ctx } = hubWith([device('cpu')])
    const out = await supportDiagnoseAccelerator(ctx, {
      nodeId: 'hub',
      expected: 'coral-usb',
    })
    if (out.status !== 'ok') throw new Error('expected ok')
    const text = out.fixSteps.join('\n')
    expect(text).toContain('/dev/bus/usb')
    expect(text).toContain('c 189:* rmw')
    expect(out.mustNotOmit.join('\n')).toContain('Coral USB')
  })

  it('unsupported: NVIDIA has no inference backend and the answer names the addon to extend', async () => {
    const { ctx } = hubWith([device('cpu')], {
      ...ultra,
      gpu: { type: 'nvidia', name: 'RTX' },
    })
    const out = await supportDiagnoseAccelerator(ctx, {
      nodeId: 'hub',
      expected: 'nvidia',
    })
    if (out.status !== 'ok') throw new Error('expected ok')
    expect(out.verdict).toBe('unsupported')
    expect(out.unsupported?.extend).toContain('@camstack/addon-pipeline')
  })

  it('unsupported: the Neural Engine on a Linux node cannot exist there', async () => {
    const { ctx } = hubWith([device('cpu')])
    const out = await supportDiagnoseAccelerator(ctx, {
      nodeId: 'hub',
      expected: 'apple-ane',
    })
    if (out.status !== 'ok') throw new Error('expected ok')
    expect(out.verdict).toBe('unsupported')
    expect(out.summary).toContain('linux/x64')
  })

  it('unknown, never misconfigured, when the devices could not be read (D315)', async () => {
    const { ctx } = fakeHub({
      'platformProbe.getHardware': ultra,
      'pipelineOrchestrator.getNodeInferenceDevices': new Error('timed out'),
    })
    const out = await supportDiagnoseAccelerator(ctx, {
      nodeId: 'hub',
      expected: 'intel-npu',
    })
    if (out.status !== 'ok') throw new Error('expected ok')
    expect(out.verdict).toBe('unknown')
    expect(out.unavailable['devices']).toContain('timed out')
  })

  it('the pure verdict never reports absent when the probe read failed', () => {
    const out = diagnoseAccelerator({
      nodeId: 'hub',
      expected: 'intel-npu',
      hardware: { ok: false, reason: 'probe down' },
      devices: { ok: true, value: { reachable: true, devices: [] } },
    })
    expect(out.verdict).toBe('misconfigured')
    expect(out.summary).toContain('could not be read')
    expect(out.unavailable['hardware']).toBe('probe down')
  })
})

const catalog = (
  installed: readonly object[],
  available: readonly object[] = [],
): { readonly [path: string]: unknown } => ({
  'addons.list': installed.map((i) => ({ manifest: i })),
  'deviceManager.discoveryProviders': { providers: [] },
  'addons.searchAvailable': available,
})

const provider = (id: string, extra: object = {}): object => ({
  id,
  name: id,
  description: `${id} provider`,
  packageName: `@camstack/addon-${id}`,
  packageVersion: '1.0.0',
  capabilities: ['device-provider'],
  ...extra,
})

const published = (name: string, keywords: readonly string[] = []): object => ({
  name,
  version: '2.0.0',
  description: `${name} cameras`,
  keywords,
  installed: false,
  capabilities: ['device-provider'],
})

describe('support_diagnose_camera', () => {
  it('answers no-session without a hub', async () => {
    expect(await supportDiagnoseCamera(noSessionContext(), { brand: 'Reolink' })).toMatchObject({
      status: 'no-session',
    })
  })

  it('use-provider: an installed brand provider matches', async () => {
    const { ctx } = fakeHub(catalog([provider('provider-reolink'), provider('provider-onvif')]))
    const out = await supportDiagnoseCamera(ctx, {
      brand: 'Reolink',
      model: 'RLC-810A',
    })
    expect(out).toMatchObject({
      verdict: 'use-provider',
      provider: { installed: true, addonId: 'provider-reolink' },
    })
  })

  it('use-provider with an install step when the matching provider is only published', async () => {
    const { ctx } = fakeHub(
      catalog(
        [provider('provider-onvif')],
        [published('@camstack/addon-provider-hikvision', ['hikvision'])],
      ),
    )
    const out = await supportDiagnoseCamera(ctx, { brand: 'Hikvision' })
    if (out.status !== 'ok') throw new Error('expected ok')
    expect(out.verdict).toBe('use-provider')
    expect(out.steps.join('\n')).toContain('configure_addon_install')
  })

  it('generic-fallback: no brand provider but ONVIF / RTSP exist', async () => {
    const { ctx } = fakeHub(catalog([provider('provider-onvif'), provider('provider-rtsp')]))
    const out = await supportDiagnoseCamera(ctx, { brand: 'Zeta Optics' })
    if (out.status !== 'ok') throw new Error('expected ok')
    expect(out.verdict).toBe('generic-fallback')
    expect(out.genericProviders.map((p) => p.addonId)).toEqual(['provider-onvif', 'provider-rtsp'])
    expect(out.steps.join('\n')).toContain('ONVIF first')
  })

  it('unsupported: nothing matches and no generic provider is installed or published', async () => {
    const { ctx } = fakeHub(catalog([provider('provider-tuya')]))
    const out = await supportDiagnoseCamera(ctx, { brand: 'Zeta Optics' })
    if (out.status !== 'ok') throw new Error('expected ok')
    expect(out.verdict).toBe('unsupported')
    expect(out.steps.join('\n')).toContain('support_draft_issue')
  })

  it('an existing device already on the matching provider is not a provider-selection problem', async () => {
    const { ctx } = fakeHub({
      ...catalog([provider('provider-reolink')]),
      'deviceManager.getDevice': {
        id: 7,
        name: 'Porch',
        addonId: 'provider-reolink',
        online: false,
      },
    })
    const out = await supportDiagnoseCamera(ctx, {
      brand: 'Reolink',
      deviceId: 7,
    })
    if (out.status !== 'ok') throw new Error('expected ok')
    expect(out.device).toMatchObject({ deviceId: 7, online: false })
    expect(out.steps.join('\n')).toContain('not provider selection')
    expect(out.steps.join('\n')).toContain('offline')
  })

  it('unknown, never unsupported, when the provider list could not be read', () => {
    const out = diagnoseCamera({
      args: { brand: 'Reolink' },
      pools: { ok: false, reason: 'addons.list: hub error' },
      device: null,
    })
    expect(out.verdict).toBe('unknown')
    expect(out.unavailable['providers']).toContain('hub error')
  })
})
