import { describe, it, expect } from 'vitest'
import type { CustomModelDescriptor } from '@camstack/types'
import {
  clearAvailability,
  clearAvailabilityFormat,
  pruneOrphanAvailability,
  removeCustomModel,
  renameCustomModel,
  rewriteModelIdsInInferenceDevices,
  stripModelIdFromInferenceDevices,
  upsertAvailability,
  upsertCustomModel,
} from '../model-registry.js'

function descriptor(id: string, stepId = 'object-detection', name = id): CustomModelDescriptor {
  return {
    stepId,
    entry: {
      id,
      name,
      description: '',
      formats: { onnx: { url: `https://x/${id}.onnx`, sizeMB: 1 } },
      inputSize: { width: 640, height: 640 },
      labels: [],
    },
  }
}

describe('upsertCustomModel', () => {
  it('appends a new descriptor without mutating the input', () => {
    const list = [descriptor('a')]
    const next = upsertCustomModel(list, descriptor('b'))
    expect(next.map((m) => m.entry.id)).toEqual(['a', 'b'])
    expect(list.map((m) => m.entry.id)).toEqual(['a']) // input untouched
  })

  it('a re-register replaces the row but KEEPS its name — a rename survives a re-import', () => {
    const list = [descriptor('a', 'object-detection', 'Renamed by operator')]
    const next = upsertCustomModel(list, {
      ...descriptor('a', 'object-detection', 'source default'),
      entry: {
        ...descriptor('a').entry,
        name: 'source default',
        description: 'fresh',
      },
    })
    expect(next).toHaveLength(1)
    expect(next[0]?.entry.name).toBe('Renamed by operator')
    expect(next[0]?.entry.description).toBe('fresh')
  })

  it('a name the operator typed at import time replaces the existing one', () => {
    const list = [descriptor('a', 'object-detection', 'old')]
    const next = upsertCustomModel(list, descriptor('a', 'object-detection', 'new'), 'operator')
    expect(next[0]?.entry.name).toBe('new')
  })

  it('a NEW row takes the source name', () => {
    const next = upsertCustomModel([], descriptor('a', 'object-detection', 'From source'))
    expect(next[0]?.entry.name).toBe('From source')
  })
})

describe('renameCustomModel', () => {
  const pinned = (): CustomModelDescriptor => ({
    stepId: 'object-detection',
    entry: {
      ...descriptor('frigate-plus-be9c11b4').entry,
      name: 'plus catalog yolo-generic (be9c11b4)',
      description: 'plus catalog personal model',
      provider: 'frigate',
      formats: {
        tflite: {
          url: 'camstack-local://frigate-plus-be9c11b4/x.tflite',
          sizeMB: 4,
        },
      },
    },
  })

  it('changes ONLY the name — id, step and formats stay exactly as they were', () => {
    const before = pinned()
    const { list, name } = renameCustomModel([before], {}, before.entry.id, '  Coral   person ')
    expect(name).toBe('Coral person')
    const after = list[0]
    expect(after?.entry.id).toBe(before.entry.id)
    expect(after?.stepId).toBe(before.stepId)
    expect(after?.entry.formats).toEqual(before.entry.formats)
    expect({ ...after?.entry, name: before.entry.name }).toEqual(before.entry)
  })

  it('remembers the imported name and an empty rename restores it', () => {
    const row = pinned()
    const first = renameCustomModel([row], {}, row.entry.id, 'Coral person')
    expect(first.importedNames).toEqual({
      [row.entry.id]: 'plus catalog yolo-generic (be9c11b4)',
    })
    const second = renameCustomModel(first.list, first.importedNames, row.entry.id, 'Porch')
    expect(second.importedNames).toEqual(first.importedNames)
    const reset = renameCustomModel(second.list, second.importedNames, row.entry.id, '   ')
    expect(reset.name).toBe('plus catalog yolo-generic (be9c11b4)')
    expect(reset.list[0]?.entry.name).toBe('plus catalog yolo-generic (be9c11b4)')
    expect(reset.importedNames).toEqual({})
  })

  it('does not mutate the input list', () => {
    const row = pinned()
    const list = [row]
    renameCustomModel(list, {}, row.entry.id, 'Other')
    expect(list[0]?.entry.name).toBe('plus catalog yolo-generic (be9c11b4)')
  })

  it('refuses an unknown id, an over-long name and a CamStack catalog model', () => {
    const row = pinned()
    expect(() => renameCustomModel([row], {}, 'nope', 'x')).toThrow(/not registered/)
    expect(() => renameCustomModel([row], {}, row.entry.id, 'x'.repeat(81))).toThrow(/limit is 80/)
    const camstack: CustomModelDescriptor = {
      stepId: 'object-detection',
      entry: { ...descriptor('yolov9s').entry, provider: 'camstack' },
    }
    expect(() => renameCustomModel([camstack], {}, 'yolov9s', 'Mine')).toThrow(/CamStack catalog/)
  })
})

describe('removeCustomModel', () => {
  it('drops the descriptor and reports removed=true', () => {
    const { next, removed } = removeCustomModel([descriptor('a'), descriptor('b')], 'a')
    expect(removed).toBe(true)
    expect(next.map((m) => m.entry.id)).toEqual(['b'])
  })

  it('reports removed=false when the id is absent', () => {
    const { next, removed } = removeCustomModel([descriptor('a')], 'zzz')
    expect(removed).toBe(false)
    expect(next.map((m) => m.entry.id)).toEqual(['a'])
  })
})

describe('upsertAvailabilityFormat', () => {
  const av = (sha: string) => ({ format: 'openvino' as const, sha256: sha, bytes: 9, at: 1 })

  it('records a model on a node without mutating the input', () => {
    const map = {}
    const next = upsertAvailability(map, 'm1', 'agent-a', av('aaa'))
    expect(next).toEqual({
      m1: { 'agent-a': { formats: { openvino: { sha256: 'aaa', bytes: 9, at: 1 } } } },
    })
    expect(map).toEqual({})
  })

  it('keeps sibling formats on the same node', () => {
    let map = upsertAvailability({}, 'm1', 'hub', {
      format: 'onnx',
      sha256: 'aaa',
      bytes: 1,
      at: 1,
    })
    map = upsertAvailability(map, 'm1', 'hub', {
      format: 'openvino',
      sha256: 'bbb',
      bytes: 2,
      at: 2,
    })
    expect(Object.keys(map.m1!.hub!.formats).toSorted()).toEqual(['onnx', 'openvino'])
  })

  it('adds a second node and overwrites a re-push of the same format', () => {
    let map = upsertAvailability({}, 'm1', 'nodeA', av('aaa'))
    map = upsertAvailability(map, 'm1', 'nodeB', av('bbb'))
    map = upsertAvailability(map, 'm1', 'nodeA', av('ccc'))
    expect(Object.keys(map.m1!).toSorted()).toEqual(['nodeA', 'nodeB'])
    expect(map.m1!.nodeA!.formats.openvino!.sha256).toBe('ccc')
  })
})

describe('clearAvailability', () => {
  it('drops the model entry so Sources no longer sees it as imported', () => {
    const map = upsertAvailability({}, 'plugin-catalog-x', 'hub', {
      format: 'onnx',
      sha256: 'a',
      bytes: 1,
      at: 1,
    })
    const { next, hadEntry } = clearAvailability(map, 'plugin-catalog-x')
    expect(hadEntry).toBe(true)
    expect(next['plugin-catalog-x']).toBeUndefined()
    expect(clearAvailability(next, 'plugin-catalog-x').hadEntry).toBe(false)
  })
})

describe('clearAvailabilityFormat', () => {
  it('drops one format and keeps sibling formats on the same node', () => {
    let map = upsertAvailability({}, 'm1', 'hub', {
      format: 'onnx',
      sha256: 'a',
      bytes: 1,
      at: 1,
    })
    map = upsertAvailability(map, 'm1', 'hub', {
      format: 'openvino',
      sha256: 'b',
      bytes: 2,
      at: 2,
    })
    const { next, cleared } = clearAvailabilityFormat(map, 'm1', 'hub', 'onnx')
    expect(cleared).toBe(true)
    expect(Object.keys(next.m1!.hub!.formats)).toEqual(['openvino'])
  })

  it('drops the node when its last format goes, and the model when its last node goes', () => {
    let map = upsertAvailability({}, 'm1', 'hub', {
      format: 'onnx',
      sha256: 'a',
      bytes: 1,
      at: 1,
    })
    map = upsertAvailability(map, 'm1', 'agent', {
      format: 'coreml',
      sha256: 'c',
      bytes: 3,
      at: 3,
    })
    const afterHub = clearAvailabilityFormat(map, 'm1', 'hub', 'onnx')
    expect(afterHub.next.m1!.hub).toBeUndefined()
    expect(afterHub.next.m1!.agent).toBeDefined()
    const afterAll = clearAvailabilityFormat(afterHub.next, 'm1', 'agent', 'coreml')
    expect(afterAll.next.m1).toBeUndefined()
  })
})

describe('pruneOrphanAvailability', () => {
  it('drops availability rows whose modelId is not in the Library registry', () => {
    const entry = (sha: string) => ({
      format: 'onnx' as const,
      sha256: sha,
      bytes: 1,
      at: 1,
    })
    let map = upsertAvailability({}, 'kept', 'hub', entry('aaa'))
    map = upsertAvailability(map, 'orphan', 'hub', entry('bbb'))
    const { next, pruned } = pruneOrphanAvailability(map, new Set(['kept']))
    expect(pruned).toEqual(['orphan'])
    expect(next.kept).toBeDefined()
    expect(next.orphan).toBeUndefined()
  })
})

describe('stripModelIdFromInferenceDevices', () => {
  it('removes matching modelId pins and keeps settings-only steps', () => {
    const { next, cleared } = stripModelIdFromInferenceDevices(
      {
        'openvino:gpu': {
          enabled: true,
          steps: {
            'object-detection': { modelId: 'scrypted-yolov9t-relu-onnx' },
            'animal-classifier': { settings: { enabledClasses: ['dog'] } },
          },
        },
        cpu: {
          enabled: false,
          steps: { 'object-detection': { modelId: 'yolo26n' } },
        },
      },
      'scrypted-yolov9t-relu-onnx',
    )
    expect(cleared).toBe(1)
    expect(next['openvino:gpu']?.steps?.['object-detection']).toBeUndefined()
    expect(next['openvino:gpu']?.steps?.['animal-classifier']).toEqual({
      settings: { enabledClasses: ['dog'] },
    })
    expect(next.cpu?.steps?.['object-detection']?.modelId).toBe('yolo26n')
  })
})

describe('rewriteModelIdsInInferenceDevices', () => {
  it('rewrites legacy plugin catalog pins onto the canonical id', () => {
    const { next, rewritten } = rewriteModelIdsInInferenceDevices(
      {
        'openvino:gpu': {
          enabled: true,
          steps: {
            'object-detection': { modelId: 'scrypted-yolov9m-relu-openvino-fp32' },
          },
        },
        cpu: {
          enabled: true,
          steps: { 'object-detection': { modelId: 'yolo26n' } },
        },
      },
      { 'scrypted-yolov9m-relu-openvino-fp32': 'scrypted-yolov9m-relu-320' },
    )
    expect(rewritten).toBe(1)
    expect(next['openvino:gpu']?.steps?.['object-detection']?.modelId).toBe(
      'scrypted-yolov9m-relu-320',
    )
    expect(next.cpu?.steps?.['object-detection']?.modelId).toBe('yolo26n')
  })
})
