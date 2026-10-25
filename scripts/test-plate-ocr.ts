/* eslint-disable @typescript-eslint/no-unsafe-member-access -- TECH-DEBT(test-2026-03-31): test file, mock typing */
import * as path from 'path'
import * as fs from 'fs'
import * as ort from 'onnxruntime-node'

const ROOT = path.resolve(__dirname, '..')
const modelsDir = path.join(ROOT, 'server/backend/camstack-data/models')
const modelPath = path.join(modelsDir, 'camstack-paddleocr-latin-rec.onnx')
const dictPath = path.join(modelsDir, 'camstack-paddleocr-latin-dict.txt')

async function main() {
  // Load charset
  const lines = fs
    .readFileSync(dictPath, 'utf-8')
    .split('\n')
    .filter((l) => l.length > 0)
  const charset = ['', ...lines, ' ']
  console.log('Charset size:', charset.length, 'First 10:', charset.slice(0, 10))

  // Load plate crop
  const plateCrop = fs.readFileSync('/tmp/plate-crop-imagespace.jpg')

  // Resize to 320x48 and normalize
  const sharp = (await import('sharp')).default
  const { data, info } = await sharp(plateCrop)
    .resize(320, 48, { fit: 'fill' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })

  console.log('Input:', info.width, 'x', info.height, 'channels:', info.channels)

  // Normalize to [0,1] and convert to NCHW Float32
  const pixels = new Float32Array(1 * 3 * 48 * 320)
  for (let c = 0; c < 3; c++) {
    for (let y = 0; y < 48; y++) {
      for (let x = 0; x < 320; x++) {
        pixels[c * 48 * 320 + y * 320 + x] = data[(y * 320 + x) * 3 + c] / 255.0
      }
    }
  }

  // Run model
  console.log('Loading model:', modelPath)
  const session = await ort.InferenceSession.create(modelPath)
  console.log('Inputs:', session.inputNames, 'Outputs:', session.outputNames)

  const inputTensor = new ort.Tensor('float32', pixels, [1, 3, 48, 320])
  const result = await session.run({ [session.inputNames[0]]: inputTensor })
  const output = result[session.outputNames[0]].data as Float32Array

  console.log('Output length:', output.length)
  const numChars = charset.length
  const seqLen = output.length / numChars
  console.log('Seq length:', seqLen, 'Num chars:', numChars)

  // CTC decode
  let text = ''
  let totalConf = 0
  let numTokens = 0
  let prevIdx = 0

  for (let t = 0; t < seqLen; t++) {
    let maxIdx = 0
    let maxVal = -Infinity
    for (let c = 0; c < numChars; c++) {
      const val = output[t * numChars + c]
      if (val > maxVal) {
        maxVal = val
        maxIdx = c
      }
    }

    // Skip blank (index 0) and repeated chars
    if (maxIdx !== 0 && maxIdx !== prevIdx) {
      text += charset[maxIdx] ?? '?'
      totalConf += Math.exp(maxVal) // softmax approx
      numTokens++
    }
    prevIdx = maxIdx
  }

  const avgConf = numTokens > 0 ? totalConf / numTokens : 0
  console.log('\nRecognized:', JSON.stringify(text))
  console.log('Avg confidence:', avgConf.toFixed(3))
}

main().catch(console.error)
