/**
 * The trainer's Dockerfile, read as Modal builds it (D807).
 *
 * Modal's JS SDK has no build context: an image is `fromRegistry(<FROM>)`
 * plus `dockerfileCommands([...])`. So the trainer's Dockerfile is written to
 * that shape (only FROM/ARG/ENV/RUN/WORKDIR/CMD, one instruction per line),
 * and this parser REFUSES anything else rather than building a different
 * image than `docker build` would. The trainer revision is substituted here,
 * in the ARG default and every `${TRAINER_REVISION}`, so the build never
 * depends on how Modal's builder treats ARG.
 */

export interface ModalImageRecipe {
  readonly from: string
  readonly commands: readonly string[]
}

export type DockerfileParse =
  | { readonly kind: 'ok'; readonly recipe: ModalImageRecipe }
  | { readonly kind: 'refused'; readonly detail: string }

const ALLOWED = new Set(['ARG', 'ENV', 'RUN', 'WORKDIR', 'CMD'])

export function parseTrainerDockerfile(text: string, revision: string): DockerfileParse {
  if (!/^[0-9a-f]{7,64}$/.test(revision))
    return { kind: 'refused', detail: 'the trainer revision must be a commit sha' }
  let from: string | null = null
  const commands: string[] = []
  for (const raw of text.split(/\r?\n/u)) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    if (line.endsWith('\\'))
      return { kind: 'refused', detail: 'line continuations are not supported' }
    const space = line.indexOf(' ')
    const instruction = (space < 0 ? line : line.slice(0, space)).toUpperCase()
    const rest = space < 0 ? '' : line.slice(space + 1).trim()
    if (instruction === 'FROM') {
      if (from !== null) return { kind: 'refused', detail: 'multi-stage builds are not supported' }
      from = rest
      continue
    }
    if (from === null) return { kind: 'refused', detail: `${instruction} before FROM` }
    if (!ALLOWED.has(instruction))
      return { kind: 'refused', detail: `${instruction} needs a build context Modal does not have` }
    if (instruction === 'ARG' && rest.startsWith('TRAINER_REVISION')) {
      commands.push(`ARG TRAINER_REVISION=${revision}`)
      continue
    }
    commands.push(`${instruction} ${rest.replaceAll('${TRAINER_REVISION}', revision)}`)
  }
  if (from === null || from === '') return { kind: 'refused', detail: 'no FROM line' }
  return { kind: 'ok', recipe: { from, commands } }
}

export function trainerDockerfileUrl(repo: string, revision: string): string {
  return `https://huggingface.co/${repo}/resolve/${revision}/Dockerfile`
}
