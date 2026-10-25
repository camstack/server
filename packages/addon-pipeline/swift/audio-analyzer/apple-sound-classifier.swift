#!/usr/bin/env swift
//
// apple-sound-classifier.swift
//
// Lightweight Swift CLI that reads raw Float32 audio from stdin,
// runs Apple SoundAnalysis (SNClassifySoundRequest), and writes
// JSON classification results to stdout.
//
// Protocol (binary IPC, same as PythonInferenceEngine):
//   stdin  → [4 bytes LE uint32 length][Float32 audio samples]
//   stdout → [4 bytes LE uint32 length][JSON bytes]
//
// The analyzer persists across chunks, accumulating audio for the
// SoundAnalysis time window (~1.5s). Results are emitted when
// the analyzer has enough data to classify.
//
// Build:  swiftc -O -o apple-sound-classifier apple-sound-classifier.swift
// Usage:  ./apple-sound-classifier --sample-rate=16000

import Foundation
import SoundAnalysis

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

var sampleRate: Double = 16000
var topK: Int = 10
var minScore: Double = 0.05

for arg in CommandLine.arguments.dropFirst() {
    if arg.hasPrefix("--sample-rate=") {
        sampleRate = Double(arg.split(separator: "=").last ?? "16000") ?? 16000
    } else if arg.hasPrefix("--top-k=") {
        topK = Int(arg.split(separator: "=").last ?? "10") ?? 10
    } else if arg.hasPrefix("--min-score=") {
        minScore = Double(arg.split(separator: "=").last ?? "0.05") ?? 0.05
    }
}

// ---------------------------------------------------------------------------
// SoundAnalysis setup
// ---------------------------------------------------------------------------

class AudioClassifier: NSObject, SNResultsObserving {
    private var results: [[String: Any]] = []
    private var inferenceMs: Double = 0
    private var gotResult = false
    private var startTime: CFAbsoluteTime = 0

    func startTiming() {
        results = []
        inferenceMs = 0
        gotResult = false
        startTime = CFAbsoluteTimeGetCurrent()
    }

    func request(_ request: SNRequest, didProduce result: SNResult) {
        guard let classResult = result as? SNClassificationResult else { return }
        for classification in classResult.classifications {
            if classification.confidence >= minScore {
                results.append([
                    "className": classification.identifier,
                    "score": round(classification.confidence * 1000) / 1000,
                ])
            }
        }
        gotResult = true
        inferenceMs = (CFAbsoluteTimeGetCurrent() - startTime) * 1000
    }

    func request(_ request: SNRequest, didFailWithError error: Error) {
        fputs("[apple-sound-classifier] Error: \(error.localizedDescription)\n", stderr)
        gotResult = true
    }

    func requestDidComplete(_ request: SNRequest) {
        // Not used for streaming — results come via didProduce
    }

    func consumeResult() -> (classifications: [[String: Any]], inferenceMs: Double)? {
        guard gotResult else { return nil }
        let sorted = results.sorted {
            ($0["score"] as? Double ?? 0) > ($1["score"] as? Double ?? 0)
        }
        let out = (Array(sorted.prefix(topK)), inferenceMs)
        results = []
        gotResult = false
        return out
    }
}

// ---------------------------------------------------------------------------
// Binary IPC: read [4B length][payload] from stdin
// ---------------------------------------------------------------------------

func readFrame() -> Data? {
    var lengthBytes = [UInt8](repeating: 0, count: 4)
    let readCount = fread(&lengthBytes, 1, 4, stdin)
    if readCount < 4 { return nil } // EOF

    let length = UInt32(lengthBytes[0])
        | (UInt32(lengthBytes[1]) << 8)
        | (UInt32(lengthBytes[2]) << 16)
        | (UInt32(lengthBytes[3]) << 24)

    if length == 0 { return Data() }

    var payload = [UInt8](repeating: 0, count: Int(length))
    let payloadRead = fread(&payload, 1, Int(length), stdin)
    if payloadRead < Int(length) { return nil }
    return Data(payload)
}

func writeFrame(_ data: Data) {
    var length = UInt32(data.count).littleEndian
    _ = withUnsafeBytes(of: &length) { ptr in
        fwrite(ptr.baseAddress!, 1, 4, stdout)
    }
    _ = data.withUnsafeBytes { ptr in
        fwrite(ptr.baseAddress!, 1, data.count, stdout)
    }
    fflush(stdout)
}

// ---------------------------------------------------------------------------
// Main loop — persistent analyzer
// ---------------------------------------------------------------------------

let classifier = AudioClassifier()
let format = AVAudioFormat(standardFormatWithSampleRate: sampleRate, channels: 1)!

// Create persistent analyzer + request
let analyzer = SNAudioStreamAnalyzer(format: format)
var framePosition: AVAudioFramePosition = 0

do {
    let request = try SNClassifySoundRequest(classifierIdentifier: .version1)
    request.windowDuration = CMTimeMakeWithSeconds(1.5, preferredTimescale: 48000)
    request.overlapFactor = 0.5
    try analyzer.add(request, withObserver: classifier)
} catch {
    fputs("[apple-sound-classifier] Setup error: \(error.localizedDescription)\n", stderr)
    exit(1)
}

// Signal ready
let readyMsg = try! JSONSerialization.data(withJSONObject: [
    "status": "ready",
    "backend": "apple-soundanalysis",
    "platform": "darwin",
])
writeFrame(readyMsg)

while let frameData = readFrame() {
    // Convert raw bytes to Float32 samples
    let float32Count = frameData.count / MemoryLayout<Float32>.size
    guard float32Count > 0 else {
        let errorResult = try! JSONSerialization.data(withJSONObject: [
            "classifications": [] as [Any],
            "inferenceMs": 0,
        ] as [String: Any])
        writeFrame(errorResult)
        continue
    }

    classifier.startTiming()

    let samples: [Float] = frameData.withUnsafeBytes { ptr in
        let floatPtr = ptr.bindMemory(to: Float32.self)
        return Array(floatPtr)
    }

    // Create audio buffer and feed to persistent analyzer
    let frameCount = AVAudioFrameCount(samples.count)
    guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frameCount) else {
        fputs("[apple-sound-classifier] Failed to create audio buffer\n", stderr)
        let errorResult = try! JSONSerialization.data(withJSONObject: [
            "classifications": [] as [Any],
            "inferenceMs": 0,
        ] as [String: Any])
        writeFrame(errorResult)
        continue
    }
    buffer.frameLength = frameCount
    let channelData = buffer.floatChannelData![0]
    for i in 0..<Int(frameCount) {
        channelData[i] = samples[i]
    }

    // Feed chunk to the persistent analyzer (accumulates audio over time)
    analyzer.analyze(buffer, atAudioFramePosition: framePosition)
    framePosition += AVAudioFramePosition(frameCount)

    // Check if analyzer produced a result (it will once enough audio is accumulated)
    // Give it a brief moment to process on the internal queue
    Thread.sleep(forTimeInterval: 0.005)

    if let (classifications, inferenceMs) = classifier.consumeResult() {
        let result = try! JSONSerialization.data(withJSONObject: [
            "classifications": classifications,
            "inferenceMs": round(inferenceMs * 10) / 10,
        ] as [String: Any])
        writeFrame(result)
    } else {
        // Not enough audio accumulated yet — return empty
        let result = try! JSONSerialization.data(withJSONObject: [
            "classifications": [] as [Any],
            "inferenceMs": 0,
        ] as [String: Any])
        writeFrame(result)
    }
}
