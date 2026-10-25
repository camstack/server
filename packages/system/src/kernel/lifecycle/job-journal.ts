import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  lifecycleJobSchema,
  type LifecycleJob,
  type LifecycleTask,
  type TaskLogEntry,
} from '@camstack/types'

interface JobIndexFile {
  readonly version: 1
  readonly jobIds: readonly string[]
}

export class JobJournal {
  private readonly jobsDir: string
  private readonly indexPath: string

  constructor(jobsDir: string) {
    this.jobsDir = jobsDir
    this.indexPath = path.join(jobsDir, 'index.json')
  }

  private jobPath(id: string): string {
    return path.join(this.jobsDir, `${id}.json`)
  }

  private writeAtomic(filePath: string, data: unknown): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: 'utf-8', mode: 0o600 })
    fs.renameSync(tmp, filePath)
  }

  private readIndex(): JobIndexFile {
    try {
      const raw = JSON.parse(fs.readFileSync(this.indexPath, 'utf-8'))
      if (raw && Array.isArray(raw.jobIds)) {
        return { version: 1, jobIds: raw.jobIds }
      }
    } catch {
      // empty
    }
    return { version: 1, jobIds: [] }
  }

  private addToIndex(id: string): void {
    const idx = this.readIndex()
    if (idx.jobIds.includes(id)) return
    this.writeAtomic(this.indexPath, { version: 1, jobIds: [...idx.jobIds, id] })
  }

  createJob(job: LifecycleJob): void {
    this.writeAtomic(this.jobPath(job.jobId), job)
    this.addToIndex(job.jobId)
  }

  getJob(id: string): LifecycleJob | null {
    try {
      const parsed = lifecycleJobSchema.safeParse(
        JSON.parse(fs.readFileSync(this.jobPath(id), 'utf-8')),
      )
      return parsed.success ? parsed.data : null
    } catch {
      return null
    }
  }

  listJobs(opts?: { activeOnly?: boolean }): LifecycleJob[] {
    const out: LifecycleJob[] = []
    for (const id of this.readIndex().jobIds) {
      const j = this.getJob(id)
      if (j && (!opts?.activeOnly || j.state === 'running')) {
        out.push(j)
      }
    }
    return out
  }

  private mutate(id: string, fn: (j: LifecycleJob) => LifecycleJob): LifecycleJob {
    const job = this.getJob(id)
    if (!job) throw new Error(`JobJournal: job '${id}' not found`)
    const next = fn(job)
    this.writeAtomic(this.jobPath(id), next)
    return next
  }

  patchTask(jobId: string, taskId: string, patch: Partial<LifecycleTask>): LifecycleJob {
    return this.mutate(jobId, (j) => ({
      ...j,
      tasks: j.tasks.map((t) => (t.taskId === taskId ? { ...t, ...patch } : t)),
    }))
  }

  appendLog(jobId: string, taskId: string, entry: TaskLogEntry): LifecycleJob {
    return this.mutate(jobId, (j) => ({
      ...j,
      tasks: j.tasks.map((t) => (t.taskId === taskId ? { ...t, steps: [...t.steps, entry] } : t)),
    }))
  }

  setJobState(jobId: string, state: LifecycleJob['state']): LifecycleJob {
    return this.mutate(jobId, (j) => ({ ...j, state }))
  }
}
