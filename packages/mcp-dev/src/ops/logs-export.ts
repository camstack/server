/**
 * `hub_logs_export` — the Logs page's export (#570) from the ops MCP. The route
 * logic (URL, args, summary) is shared with `camstack mcp` in `@camstack/develop`;
 * this wrapper only picks the file under `<workspace>/scratchpad/logs-export/`.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  downloadLogsExport,
  type LogsExportArgs,
  LogsExportArgsSchema,
  type LogsExportSummary,
  logsExportUrl,
  summarizeLogsExport,
} from '@camstack/develop'
import { confine } from '../fs-confine.js'
import type { OpsHub } from './hub.js'

export { LogsExportArgsSchema, logsExportUrl, summarizeLogsExport }
export type { LogsExportArgs, LogsExportSummary }

export async function hubLogsExport(
  root: string,
  hub: OpsHub,
  args: LogsExportArgs,
  now: () => Date = () => new Date(),
): Promise<LogsExportSummary> {
  const at = now()
  const stem = args.name ?? `logs-${at.toISOString().replace(/[:.]/g, '-')}`
  const dest = confine(root, path.join('scratchpad', 'logs-export', `${stem}.ndjson`))
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  const done = await downloadLogsExport((u, d, m) => hub.download(u, d, m), dest, args, at)
  return {
    path: path.relative(root, dest),
    ...done,
    next: 'One JSON object per line (newest first): grep/jq the file; tags.deviceId names the camera.',
  }
}
