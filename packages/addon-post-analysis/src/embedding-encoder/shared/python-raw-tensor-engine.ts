import type {
  DetectionDevice,
  DetectionRuntime,
  IRawTensorEngine,
  IScopedLogger,
} from '@camstack/types'
import { FramedPythonProcess } from './framed-python-process.js'
import { createNoopLogger } from './noop-logger.js'
import { decodeTensorFrame } from './python-text-encoder-engine.js'

/**
 * Raw-tensor ONNX engine backed by an embedded-Python subprocess
 * (`raw_tensor_inference.py`). Replaces the Node `onnxruntime-node` raw-tensor
 * engine so the platform ships no Node ONNX runtime. The caller preprocesses to
 * a Float32Array; this engine ships it to Python, which runs onnxruntime and
 * returns the output tensor. Wire protocol = length-prefixed binary frames
 * ([4B LE length][payload]); the process lifecycle is `FramedPythonProcess`.
 */
export class PythonRawTensorEngine implements IRawTensorEngine {
  readonly runtime: DetectionRuntime = 'onnx'
  readonly device: DetectionDevice = 'cpu'
  private readonly proc: FramedPythonProcess
  private readonly log: IScopedLogger
  private requestCount = 0

  constructor(
    pythonPath: string,
    scriptPath: string,
    private readonly modelPath: string,
    logger?: IScopedLogger,
  ) {
    this.log = logger ?? createNoopLogger()
    this.proc = new FramedPythonProcess(
      'PythonRawTensorEngine',
      pythonPath,
      [scriptPath, modelPath],
      this.log,
    )
  }

  async initialize(): Promise<void> {
    await this.proc.start()
    this.log.info('ONNX raw-tensor engine ready (embedded Python)', {
      meta: { modelPath: this.modelPath },
    })
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

  /** Inference requests served since spawn — the denominator that separates
   *  "RSS grew per unit of work" (leak) from "RSS grew because it worked". */
  getRequestCount(): number {
    return this.requestCount
  }

  async run(input: Float32Array, inputShape: readonly number[]): Promise<Float32Array> {
    this.requestCount++
    // payload = [1B ndims][ndims × 4B LE uint32 dims][float32 LE data]
    const ndims = inputShape.length
    const meta = Buffer.allocUnsafe(1 + ndims * 4)
    meta.writeUInt8(ndims, 0)
    for (let i = 0; i < ndims; i++) {
      meta.writeUInt32LE(inputShape[i]!, 1 + i * 4)
    }
    const dataBuf = Buffer.from(input.buffer, input.byteOffset, input.byteLength)
    const resp = await this.proc.request(Buffer.concat([meta, dataBuf]))
    return decodeTensorFrame(resp)
  }

  async dispose(): Promise<void> {
    await this.proc.dispose()
  }
}
