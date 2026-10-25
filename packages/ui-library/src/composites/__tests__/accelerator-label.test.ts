import { describe, expect, it } from 'vitest'
import { acceleratorLabel, acceleratorShortLabel } from '../accelerator-label'

const d = (key: string, backend: string, device: string) => ({ key, backend, device })

describe('acceleratorLabel — one name per device, on every page', () => {
  it.each([
    [d('cpu', 'cpu', 'cpu'), 'CPU', 'CPU'],
    [d('cuda:0', 'cuda', '0'), 'Cuda 0', 'cuda'],
    [d('openvino:npu', 'openvino', 'npu'), 'Intel NPU', 'NPU'],
    [d('openvino:gpu', 'openvino', 'gpu'), 'Intel iGPU', 'iGPU'],
    [d('edgetpu:usb', 'edgetpu', 'usb'), 'Coral Edge TPU', 'Coral'],
    // Several Corals on one node (USB and/or PCIe) each get a name of their own.
    [d('edgetpu:usb:1', 'edgetpu', 'usb:1'), 'Coral Edge TPU (USB 2)', 'Coral USB 2'],
    [d('edgetpu:pci', 'edgetpu', 'pci'), 'Coral Edge TPU (PCIe)', 'Coral PCIe'],
    [d('edgetpu:pci:1', 'edgetpu', 'pci:1'), 'Coral Edge TPU (PCIe 2)', 'Coral PCIe 2'],
    // The Mac mini's Neural Engine — "Coreml All" in the old step matrix.
    [d('coreml:all', 'coreml', 'all'), 'Apple Neural Engine', 'ANE'],
  ])('%o → %s / %s', (device, label, short) => {
    expect(acceleratorLabel(device)).toBe(label)
    expect(acceleratorShortLabel(device)).toBe(short)
  })

  it('an unknown device keeps a readable name', () => {
    expect(acceleratorLabel(d('rknn:npu0', 'rknn', 'npu0'))).toBe('Rknn Npu0')
  })
})
