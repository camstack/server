/**
 * Modal specifics (D807) on top of the shared contract: the trainer image is
 * the trainer's own Dockerfile at the PINNED revision (never a branch, never a
 * context-dependent instruction); the GPU sandbox gets the GPU, the region,
 * the provider-enforced timeout, the two volumes and the job spec — and no
 * credential; credential errors are classified; the shared cache volume is
 * never deleted.
 */
import { describe, expect, it } from 'vitest'
import { parseTrainerDockerfile } from '../providers/modal/dockerfile.js'
import { MODAL_CACHE_VOLUME, ModalAuthError } from '../providers/modal/modal-gateway.js'
import { modalSubject } from './modal-subject.js'

const JOB = '33333333-3333-4333-8333-333333333333'

describe('trainer Dockerfile as Modal builds it', () => {
  it('substitutes the pinned revision in the ARG and every reference', () => {
    const parsed = parseTrainerDockerfile(
      'FROM base:1\nARG TRAINER_REVISION=main\nENV TRAINER_REVISION=${TRAINER_REVISION}\nRUN pip install x@${TRAINER_REVISION}\nWORKDIR /app',
      'ebeed67a',
    )
    expect(parsed).toEqual({
      kind: 'ok',
      recipe: {
        from: 'base:1',
        commands: [
          'ARG TRAINER_REVISION=ebeed67a',
          'ENV TRAINER_REVISION=ebeed67a',
          'RUN pip install x@ebeed67a',
          'WORKDIR /app',
        ],
      },
    })
  })

  it('refuses what has no meaning without a build context', () => {
    expect(parseTrainerDockerfile('FROM a\nCOPY . /app', 'ebeed67a').kind).toBe('refused')
    expect(parseTrainerDockerfile('FROM a\nRUN x \\\n y', 'ebeed67a').kind).toBe('refused')
    expect(parseTrainerDockerfile('FROM a AS b\nFROM c', 'ebeed67a').kind).toBe('refused')
    expect(parseTrainerDockerfile('FROM a', 'main').kind).toBe('refused')
  })

  it('reads the real trainer Dockerfile', async () => {
    const { readFile } = await import('node:fs/promises')
    const { dirname, join } = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    // Repo-root trainer recipe (not under the package); resolve from this file.
    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../../..')
    const text = await readFile(join(repoRoot, 'hf/camstack-trainer/Dockerfile'), 'utf8')
    const parsed = parseTrainerDockerfile(text, 'ebeed67a296241fcb5b0d97cf7c85dd12a743db8')
    expect(parsed.kind).toBe('ok')
    if (parsed.kind === 'ok') {
      expect(parsed.recipe.from).toMatch(/^pytorch\/pytorch:/)
      expect(parsed.recipe.commands.join('\n')).toContain(
        '@ebeed67a296241fcb5b0d97cf7c85dd12a743db8',
      )
    }
  })
})

describe('Modal provider', () => {
  it('starts the trainer on the asked GPU and region, Modal enforcing the timeout', async () => {
    const s = modalSubject()
    await s.provider.submitJob({
      entryId: s.entryId,
      jobKey: JOB,
      trainer: { repo: 'camstack/camstack-trainer', revision: 'ebeed67a' },
      jobSpecJson: '{"jobKey":"x"}',
      gpuType: 'L4',
      region: 'eu',
      maxRuntimeSec: 7200,
    })
    const spec = s.gateway.trainerSpec(JOB)
    expect(spec?.gpu).toBe('L4')
    expect(spec?.regions).toEqual(['eu'])
    expect(spec?.timeoutMs).toBe(7_200_000)
    expect(spec?.volumes).toEqual({ '/data': `cst-ds-${JOB}`, '/cache': MODAL_CACHE_VOLUME })
    expect(spec?.env?.['CAMSTACK_JOB_JSON']).toBe('{"jobKey":"x"}')
    expect(JSON.stringify(spec)).not.toMatch(/as-y|ak-x/)
    expect(spec?.image.kind === 'recipe' && spec.image.recipe.commands[1]).toContain('ebeed67a')
  })

  it('classifies a rejected token as invalid', async () => {
    const s = modalSubject()
    s.gateway.authError = new ModalAuthError('invalid', 'token rejected')
    expect(await s.provider.validateCredentials({ entryId: s.entryId })).toEqual({
      ok: false,
      reason: 'invalid',
      detail: 'token rejected',
    })
  })

  it('deletes only the job volume, never the shared cache', async () => {
    const s = modalSubject()
    await s.provider.uploadDataset({
      entryId: s.entryId,
      jobKey: JOB,
      ticket: s.peer.offer(Buffer.from('d')),
    })
    await s.provider.cleanupJob({ entryId: s.entryId, jobKey: JOB })
    expect(s.gateway.calls.filter((c) => c.startsWith('delete-volume:'))).toEqual([
      `delete-volume:cst-ds-${JOB}`,
    ])
  })

  it('reports a running job cost from runtime × list price, as an estimate', async () => {
    const s = modalSubject()
    const status = await s.provider.submitJob({
      entryId: s.entryId,
      jobKey: JOB,
      trainer: { repo: 'camstack/camstack-trainer', revision: 'ebeed67a' },
      jobSpecJson: '{}',
      gpuType: 'L4',
      region: '',
      maxRuntimeSec: 3600,
    })
    expect(status.state).toBe('running')
    expect(status.costIsEstimate).toBe(true)
  })
})
