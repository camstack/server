import type { IScopedLogger } from '@camstack/types'
import { FramedPythonProcess } from './framed-python-process.js'
import { createNoopLogger } from './noop-logger.js'

/**
 * CLIP text-encoder engine backed by an embedded-Python subprocess
 * (`text_encoder_inference.py`). Tokenization happens IN Python via the HF
 * `tokenizers` Rust BPE (exact by construction) — this replaces the former
 * hand-rolled TypeScript CLIP BPE.
 *
 * The caller sends raw UTF-8 text; Python tokenizes (truncate/pad to the model's
 * window — `TextTokenWindow`), runs onnxruntime, and returns the embedding
 * tensor. Wire protocol = length-prefixed binary frames ([4B LE length][payload]):
 *   ready    (in):  [0x01]
 *   request  (out): UTF-8 text bytes
 *   response (in):  [1B ndims][dims × 4B LE uint32][float32 LE data]
 *
 * The process lifecycle — every waiter settles, a dead process rejects at once
 * by name, EPIPE is caught — is `FramedPythonProcess`.
 */
/**
 * The model's token window, from its `ClipModelMeta` (D649). Required: an
 * engine that silently defaulted to CLIP's 77 would feed a 64-position SigLIP2
 * tower whatever its graph makes of the extra 13 tokens.
 */
export interface TextTokenWindow {
  readonly contextLength: number
  readonly padId: number
}

export class PythonTextEncoderEngine {
  private readonly proc: FramedPythonProcess
  private readonly log: IScopedLogger
  private requestCount = 0

  constructor(
    pythonPath: string,
    private readonly scriptPath: string,
    private readonly modelPath: string,
    private readonly tokenizerPath: string,
    private readonly window: TextTokenWindow,
    logger?: IScopedLogger,
  ) {
    this.log = logger ?? createNoopLogger()
    this.proc = new FramedPythonProcess(
      'PythonTextEncoderEngine',
      pythonPath,
      this.spawnArgs(),
      this.log,
    )
  }

  async initialize(): Promise<void> {
    await this.proc.start()
    this.log.info('CLIP text-encoder engine ready (embedded Python)', {
      meta: {
        modelPath: this.modelPath,
        tokenizerPath: this.tokenizerPath,
        contextLength: this.window.contextLength,
        padId: this.window.padId,
      },
    })
  }

  /** The subprocess argv after the interpreter — the window rides on it. */
  spawnArgs(): readonly string[] {
    return [
      this.scriptPath,
      this.modelPath,
      this.tokenizerPath,
      '--context-length',
      String(this.window.contextLength),
      '--pad-id',
      String(this.window.padId),
    ]
  }

  /** False once the process died (crash, OOM kill) or was disposed. */
  isAlive(): boolean {
    return this.proc.isAlive()
  }

  /** Native pid of the Python subprocess — sampled by the pool memory
   *  watchdog (`/proc/<pid>/status`). */
  getPid(): number | null {
    return this.proc.getPid()
  }

  /** Encode requests served since spawn — the denominator that separates
   *  "RSS grew per unit of work" (leak) from "RSS grew because it worked". */
  getRequestCount(): number {
    return this.requestCount
  }

  /** Tokenize + encode `text` into the model embedding (float32). */
  async encode(text: string): Promise<Float32Array> {
    this.requestCount++
    const resp = await this.proc.request(Buffer.from(text, 'utf-8'))
    return decodeTensorFrame(resp)
  }

  async dispose(): Promise<void> {
    await this.proc.dispose()
  }
}

/** Decode `[1B ndims][dims × 4B][float32 data]`. */
export function decodeTensorFrame(resp: Buffer): Float32Array {
  const respDims = resp.readUInt8(0)
  const floatStart = 1 + respDims * 4
  const count = (resp.length - floatStart) / 4
  // Copy float-by-float — the payload's float region is not 4-byte aligned
  // within the Buffer, so a Float32Array view over it is not safe.
  const out = new Float32Array(count)
  for (let i = 0; i < count; i++) {
    out[i] = resp.readFloatLE(floatStart + i * 4)
  }
  return out
}
