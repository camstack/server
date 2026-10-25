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
// The process stays alive and handles multiple requests.
// Send EOF on stdin to exit.
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
    private let semaphore = DispatchSemaphore(value: 0)
    private var startTime: CFAbsoluteTime = 0

    func startTiming() {
        results = []
        inferenceMs = 0
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
    }

    func request(_ request: SNRequest, didFailWithError error: Error) {
        fputs("[apple-sound-classifier] Error: \(error.localizedDescription)\n", stderr)
        semaphore.signal()
    }

    func requestDidComplete(_ request: SNRequest) {
        inferenceMs = (CFAbsoluteTimeGetCurrent() - startTime) * 1000
        semaphore.signal()
    }

    func waitForResult() -> (classifications: [[String: Any]], inferenceMs: Double) {
        semaphore.wait()
        // Sort by score descending, take top K
        let sorted = results.sorted {
            ($0["score"] as? Double ?? 0) > ($1["score"] as? Double ?? 0)
        }
        return (Array(sorted.prefix(topK)), inferenceMs)
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
// Main loop
// ---------------------------------------------------------------------------

let classifier = AudioClassifier()

// Signal ready
let readyMsg = try! JSONSerialization.data(withJSONObject: [
    "status": "ready",
    "backend": "apple-soundanalysis",
    "platform": "darwin",
])
writeFrame(readyMsg)

while let frameData = readFrame() {
    classifier.startTiming()

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

    let samples: [Float] = frameData.withUnsafeBytes { ptr in
        let floatPtr = ptr.bindMemory(to: Float32.self)
        return Array(floatPtr)
    }

    // Create an audio buffer in AVAudioPCMBuffer format
    let format = AVAudioFormat(standardFormatWithSampleRate: sampleRate, channels: 1)!
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

    // Run SoundAnalysis
    do {
        let analyzer = SNAudioStreamAnalyzer(format: format)
        let request = try SNClassifySoundRequest(classifierIdentifier: .version1)
        try analyzer.add(request, withObserver: classifier)
        analyzer.analyze(buffer, atAudioFramePosition: 0)
        analyzer.completeAnalysis()

        let (classifications, inferenceMs) = classifier.waitForResult()

        let result = try! JSONSerialization.data(withJSONObject: [
            "classifications": classifications,
            "inferenceMs": round(inferenceMs * 10) / 10,
        ] as [String: Any])
        writeFrame(result)
    } catch {
        fputs("[apple-sound-classifier] Analysis error: \(error.localizedDescription)\n", stderr)
        let errorResult = try! JSONSerialization.data(withJSONObject: [
            "classifications": [] as [Any],
            "inferenceMs": 0,
            "error": error.localizedDescription,
        ] as [String: Any])
        writeFrame(errorResult)
    }
}
