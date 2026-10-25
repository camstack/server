// camstack-afm — CamStack's Apple Foundation Models helper.
//
// A long-lived child of the ai addon's `llm-runtime` provider, on darwin only.
// It speaks ONE JSON object per line: requests on stdin, replies on stdout.
// Every request carries an `id`; every reply echoes it.
//
//   {"id":"1","op":"probe"}
//   {"id":"2","op":"generate","prompt":"…","system":"…","jsonSchema":{…},
//    "maxTokens":64,"temperature":0.2,"topP":0.9,"topK":40}
//   {"id":"3","op":"cancel","target":"2"}
//   {"id":"4","op":"checkSchema","jsonSchema":{…}}   // map only, no model call
//
// Replies: {"id","ok":true,…} or {"id","ok":false,"code","message","appleError"?,
// "refusalSource"?}. `code` is already an `LlmErrorCode` (plus "cancelled").
//
// Rules this file keeps:
//   - A JSON Schema construct that cannot be mapped to a DynamicGenerationSchema
//     is REFUSED (`bad-request`), never dropped: a dropped `minimum` produced
//     `confidence: 85` for a 0..1 field on the first measurement.
//   - A guardrail violation is its own outcome (`refusalSource: "guardrail"`),
//     never an empty answer.
//   - Image input is reported `false`: this binary is built against the macOS
//     26 SDK, which has no public image input. It is never inferred elsewhere.
//
// Build: `node scripts/build-afm.mjs` (darwin, SDK >= 26). Deployment target 26.0.
import Foundation
import FoundationModels

let protocolVersion = 1

// MARK: - Output

final class LineWriter: @unchecked Sendable {
  private let lock = NSLock()

  func send(_ object: [String: Any]) {
    guard JSONSerialization.isValidJSONObject(object),
      let data = try? JSONSerialization.data(withJSONObject: object, options: [])
    else {
      let fallback = "{\"id\":\"\",\"ok\":false,\"code\":\"adapter-error\",\"message\":\"unserialisable reply\"}\n"
      lock.lock()
      FileHandle.standardOutput.write(Data(fallback.utf8))
      lock.unlock()
      return
    }
    lock.lock()
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
    lock.unlock()
  }
}

// MARK: - In-flight generations

/// Lock-based rather than an actor so a generation is registered SYNCHRONOUSLY
/// on the reading thread: an actor hop left a window where EOF saw an empty
/// registry and exited under a generation that had just been accepted.
final class TaskRegistry: @unchecked Sendable {
  private let lock = NSLock()
  private var reserved: Set<String> = []
  private var tasks: [String: Task<Void, Never>] = [:]

  func reserve(_ id: String) {
    lock.lock(); reserved.insert(id); lock.unlock()
  }
  /// Attach only while still reserved — a task that already finished has
  /// removed its reservation and must not leave a stale entry behind.
  func attach(_ id: String, _ task: Task<Void, Never>) {
    lock.lock(); if reserved.contains(id) { tasks[id] = task }; lock.unlock()
  }
  func remove(_ id: String) {
    lock.lock(); reserved.remove(id); tasks[id] = nil; lock.unlock()
  }
  func cancel(_ id: String) -> Bool {
    lock.lock(); let task = tasks[id]; lock.unlock()
    guard let task else { return false }
    task.cancel()
    return true
  }
  var count: Int {
    lock.lock(); defer { lock.unlock() }
    return reserved.count
  }
}

// MARK: - Replies

func failure(_ id: String, _ code: String, _ message: String, extra: [String: Any] = [:]) -> [String: Any] {
  var out: [String: Any] = ["id": id, "ok": false, "code": code, "message": message]
  for (key, value) in extra { out[key] = value }
  return out
}

// MARK: - Availability

func osVersionString() -> String {
  let v = ProcessInfo.processInfo.operatingSystemVersion
  return "\(v.majorVersion).\(v.minorVersion).\(v.patchVersion)"
}

func languageTag(_ language: Locale.Language) -> String {
  var tag = language.languageCode?.identifier ?? "und"
  if let region = language.region?.identifier { tag += "-\(region)" }
  return tag
}

func availabilityPayload() -> [String: Any] {
  let model = SystemLanguageModel.default
  let osVersion = osVersionString()
  switch model.availability {
  case .available:
    let languages = Array(Set(model.supportedLanguages.map(languageTag))).sorted()
    return [
      "state": "available",
      "osVersion": osVersion,
      "contextSize": model.contextSize,
      "languages": languages,
      // Built against the macOS 26 SDK: no public image input exists here.
      "imageInput": false,
    ]
  case .unavailable(let reason):
    switch reason {
    case .deviceNotEligible:
      return ["state": "unavailable", "reason": "deviceNotEligible", "osVersion": osVersion,
              "detail": "this Mac is not eligible for Apple Intelligence"]
    case .appleIntelligenceNotEnabled:
      return ["state": "unavailable", "reason": "appleIntelligenceNotEnabled", "osVersion": osVersion,
              "detail": "Apple Intelligence is turned off in System Settings for the logged-in user"]
    case .modelNotReady:
      return ["state": "unavailable", "reason": "modelNotReady", "osVersion": osVersion,
              "detail": "the on-device model is still downloading or being prepared"]
    @unknown default:
      return ["state": "unknown", "error": "unrecognised unavailability reason: \(reason)"]
    }
  }
}

// MARK: - JSON Schema → DynamicGenerationSchema

struct SchemaRefusal: Error {
  let message: String
}

/// Keys that describe a schema without constraining it. Everything else that is
/// not explicitly mapped below is a constraint we would silently drop, so it is
/// refused instead.
let annotationKeys: Set<String> = ["type", "description", "title", "$schema", "default", "examples", "$id"]

struct SchemaMapper {
  func mapRoot(_ node: [String: Any]) throws -> GenerationSchema {
    let root = try map(node, path: "root")
    return try GenerationSchema(root: root, dependencies: [])
  }

  private func rejectUnknown(_ node: [String: Any], allowed: Set<String>, path: String) throws {
    for key in node.keys where !annotationKeys.contains(key) && !allowed.contains(key) {
      throw SchemaRefusal(message: "\(path): JSON Schema keyword \"\(key)\" cannot be enforced by Apple Foundation Models")
    }
  }

  private func number(_ value: Any?) -> Double? {
    guard let n = value as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID() else { return nil }
    let d = n.doubleValue
    return d.isFinite ? d : nil
  }

  /// Largest magnitude accepted as an integer bound: exactly representable in a
  /// Double, far inside Int. `Int(Double)` TRAPS outside Int's range, and a
  /// trap here would crash the helper on a caller's schema.
  private let maxIntegerBound = 9_007_199_254_740_991.0

  /// `nil` when absent; refused when present but not a safe integer.
  private func integer(_ node: [String: Any], _ key: String, path: String, minimum: Double? = nil) throws -> Int? {
    guard let raw = node[key] else { return nil }
    guard let value = number(raw), value == value.rounded(), abs(value) <= maxIntegerBound else {
      throw SchemaRefusal(message: "\(path): \(key) must be an integer within ±2^53")
    }
    if let minimum, value < minimum {
      throw SchemaRefusal(message: "\(path): \(key) must be at least \(Int(minimum))")
    }
    return Int(value)
  }

  func map(_ node: [String: Any], path: String) throws -> DynamicGenerationSchema {
    let description = node["description"] as? String
    if let values = node["enum"] {
      guard let strings = values as? [String], !strings.isEmpty else {
        throw SchemaRefusal(message: "\(path): only a non-empty enum of strings can be enforced")
      }
      if let type = node["type"], (type as? String) != "string" {
        throw SchemaRefusal(message: "\(path): an enum must be of type string")
      }
      try rejectUnknown(node, allowed: ["enum"], path: path)
      return DynamicGenerationSchema(name: path, description: description, anyOf: strings)
    }
    guard let type = node["type"] as? String else {
      throw SchemaRefusal(message: "\(path): a schema needs a single string \"type\" (type unions, $ref and combinators are not supported)")
    }
    switch type {
    case "object":
      try rejectUnknown(node, allowed: ["properties", "required", "additionalProperties"], path: path)
      if let extra = node["additionalProperties"], !(extra is Bool) {
        throw SchemaRefusal(message: "\(path): additionalProperties must be a boolean")
      }
      if let raw = node["properties"], !(raw is [String: Any]) {
        throw SchemaRefusal(message: "\(path): properties must be an object")
      }
      if let raw = node["required"], !(raw is [String]) {
        throw SchemaRefusal(message: "\(path): required must be an array of strings")
      }
      let properties = node["properties"] as? [String: Any] ?? [:]
      let required = Set(node["required"] as? [String] ?? [])
      for name in required where properties[name] == nil {
        throw SchemaRefusal(message: "\(path): required property \"\(name)\" is not declared")
      }
      var mapped: [DynamicGenerationSchema.Property] = []
      for name in properties.keys.sorted() {
        guard let child = properties[name] as? [String: Any] else {
          throw SchemaRefusal(message: "\(path).\(name): property schema must be an object")
        }
        let schema = try map(child, path: "\(path).\(name)")
        mapped.append(DynamicGenerationSchema.Property(
          name: name,
          description: child["description"] as? String,
          schema: schema,
          isOptional: !required.contains(name)
        ))
      }
      return DynamicGenerationSchema(name: path, description: description, properties: mapped)
    case "string":
      try rejectUnknown(node, allowed: ["const"], path: path)
      if let constant = node["const"] {
        guard let value = constant as? String else {
          throw SchemaRefusal(message: "\(path): const must be a string")
        }
        return DynamicGenerationSchema(type: String.self, guides: [.constant(value)])
      }
      return DynamicGenerationSchema(type: String.self)
    case "integer":
      try rejectUnknown(node, allowed: ["minimum", "maximum"], path: path)
      var guides: [GenerationGuide<Int>] = []
      if let low = try integer(node, "minimum", path: path) { guides.append(.minimum(low)) }
      if let high = try integer(node, "maximum", path: path) { guides.append(.maximum(high)) }
      return DynamicGenerationSchema(type: Int.self, guides: guides)
    case "number":
      try rejectUnknown(node, allowed: ["minimum", "maximum"], path: path)
      var guides: [GenerationGuide<Double>] = []
      for key in ["minimum", "maximum"] {
        guard let raw = node[key] else { continue }
        guard let bound = number(raw) else {
          throw SchemaRefusal(message: "\(path): \(key) must be a number")
        }
        guides.append(key == "minimum" ? .minimum(bound) : .maximum(bound))
      }
      return DynamicGenerationSchema(type: Double.self, guides: guides)
    case "boolean":
      try rejectUnknown(node, allowed: [], path: path)
      return DynamicGenerationSchema(type: Bool.self)
    case "array":
      try rejectUnknown(node, allowed: ["items", "minItems", "maxItems"], path: path)
      guard let items = node["items"] as? [String: Any] else {
        throw SchemaRefusal(message: "\(path): an array needs a single \"items\" schema")
      }
      let itemSchema = try map(items, path: "\(path)[]")
      let minItems = try integer(node, "minItems", path: path, minimum: 0)
      let maxItems = try integer(node, "maxItems", path: path, minimum: 0)
      if let minItems, let maxItems, minItems > maxItems {
        throw SchemaRefusal(message: "\(path): minItems is greater than maxItems")
      }
      return DynamicGenerationSchema(arrayOf: itemSchema, minimumElements: minItems, maximumElements: maxItems)
    default:
      throw SchemaRefusal(message: "\(path): type \"\(type)\" is not supported")
    }
  }
}

// MARK: - Generation

func errorName(_ error: LanguageModelSession.GenerationError) -> String {
  switch error {
  case .exceededContextWindowSize: return "exceededContextWindowSize"
  case .assetsUnavailable: return "assetsUnavailable"
  case .guardrailViolation: return "guardrailViolation"
  case .unsupportedGuide: return "unsupportedGuide"
  case .unsupportedLanguageOrLocale: return "unsupportedLanguageOrLocale"
  case .decodingFailure: return "decodingFailure"
  case .rateLimited: return "rateLimited"
  case .concurrentRequests: return "concurrentRequests"
  case .refusal: return "refusal"
  @unknown default: return "unknown"
  }
}

func mapGenerationError(_ id: String, _ error: LanguageModelSession.GenerationError) -> [String: Any] {
  let name = errorName(error)
  let message = error.errorDescription ?? error.localizedDescription
  let extra: [String: Any] = ["appleError": name]
  switch error {
  case .guardrailViolation:
    return failure(id, "refusal", "Apple guardrail refused the request: \(message)",
                   extra: extra.merging(["refusalSource": "guardrail"]) { a, _ in a })
  case .refusal:
    return failure(id, "refusal", "the model declined: \(message)",
                   extra: extra.merging(["refusalSource": "model"]) { a, _ in a })
  case .rateLimited, .concurrentRequests:
    return failure(id, "rate-limited", message, extra: extra)
  case .exceededContextWindowSize, .unsupportedLanguageOrLocale, .unsupportedGuide:
    return failure(id, "bad-request", message, extra: extra)
  case .assetsUnavailable:
    return failure(id, "unavailable", message, extra: extra)
  default:
    return failure(id, "adapter-error", message, extra: extra)
  }
}

func samplingMode(_ request: [String: Any]) -> GenerationOptions.SamplingMode? {
  if let topK = request["topK"] as? Int, topK > 0 { return .random(top: topK) }
  if let topP = request["topP"] as? Double, topP > 0 { return .random(probabilityThreshold: topP) }
  return nil
}

func countTokens(_ model: SystemLanguageModel, _ text: String) async -> Int {
  if #available(macOS 26.4, *) {
    return (try? await model.tokenCount(for: text)) ?? 0
  }
  // 0 = unknown, not free (the usage store reads it that way).
  return 0
}

func generate(_ id: String, _ request: [String: Any]) async -> [String: Any] {
  guard let prompt = request["prompt"] as? String else {
    return failure(id, "bad-request", "generate needs a string prompt")
  }
  let model = SystemLanguageModel.default
  if case .unavailable = model.availability {
    var out = failure(id, "unavailable", "Apple Foundation Models is not available on this Mac")
    out["availability"] = availabilityPayload()
    return out
  }
  var schema: GenerationSchema?
  if let raw = request["jsonSchema"] {
    guard let node = raw as? [String: Any] else {
      return failure(id, "bad-request", "jsonSchema must be an object")
    }
    do {
      schema = try SchemaMapper().mapRoot(node)
    } catch let refusal as SchemaRefusal {
      return failure(id, "bad-request", refusal.message)
    } catch {
      return failure(id, "bad-request", "jsonSchema rejected: \(error.localizedDescription)")
    }
  }
  let system = request["system"] as? String
  let session = LanguageModelSession(model: model, instructions: system)
  let options = GenerationOptions(
    sampling: samplingMode(request),
    temperature: request["temperature"] as? Double,
    maximumResponseTokens: request["maxTokens"] as? Int
  )
  let started = Date()
  do {
    // STREAMED, and the loop checks cancellation per snapshot: `respond(to:)`
    // honoured a cancel only after the whole answer was produced (measured:
    // 16 s for a cancel sent at 0.5 s), so a gate that gave up kept the
    // model busy for nobody. Leaving the loop stops the generation.
    var text = ""
    // A structured answer the stream ended before completing (maxTokens) is
    // partial JSON: it must never come back as `ok`.
    var structuredComplete = true
    if let schema {
      let stream = session.streamResponse(to: prompt, schema: schema, options: options)
      for try await snapshot in stream {
        try Task.checkCancellation()
        text = snapshot.rawContent.jsonString
        structuredComplete = snapshot.rawContent.isComplete
      }
    } else {
      let stream = session.streamResponse(to: prompt, options: options)
      for try await snapshot in stream {
        try Task.checkCancellation()
        text = snapshot.content
      }
    }
    try Task.checkCancellation()
    // Measured before the token counting below, which is bookkeeping.
    let latencyMs = Int(Date().timeIntervalSince(started) * 1000)
    if !structuredComplete {
      return failure(id, "adapter-error",
                     "the structured answer was cut off before it was complete (maxTokens too low?)",
                     extra: ["truncated": true])
    }
    let inputTokens = await countTokens(model, (system ?? "") + "\n" + prompt)
    let outputTokens = await countTokens(model, text)
    // Known only where tokenCount exists (26.4+): 0 there means unknown, and
    // unknown is reported as not truncated rather than guessed.
    let maxTokens = request["maxTokens"] as? Int
    let truncated = maxTokens.map { outputTokens > 0 && outputTokens >= $0 } ?? false
    return [
      "id": id,
      "ok": true,
      "text": text,
      "usage": ["inputTokens": inputTokens, "outputTokens": outputTokens],
      "truncated": truncated,
      "latencyMs": latencyMs,
    ]
  } catch is CancellationError {
    return failure(id, "cancelled", "cancelled by the caller")
  } catch let error as LanguageModelSession.GenerationError {
    return mapGenerationError(id, error)
  } catch {
    return failure(id, "adapter-error", error.localizedDescription)
  }
}

// MARK: - Dispatch

let writer = LineWriter()
let registry = TaskRegistry()

func handle(_ line: String) {
  guard !line.isEmpty else { return }
  guard let data = line.data(using: .utf8),
    let object = try? JSONSerialization.jsonObject(with: data),
    let request = object as? [String: Any]
  else {
    writer.send(failure("", "bad-request", "request is not a JSON object"))
    return
  }
  guard let id = request["id"] as? String, !id.isEmpty else {
    writer.send(failure("", "bad-request", "request has no id"))
    return
  }
  switch request["op"] as? String {
  case "probe":
    writer.send(["id": id, "ok": true, "protocol": protocolVersion, "availability": availabilityPayload()])
  case "checkSchema":
    guard let node = request["jsonSchema"] as? [String: Any] else {
      writer.send(failure(id, "bad-request", "jsonSchema must be an object"))
      return
    }
    do {
      _ = try SchemaMapper().mapRoot(node)
      writer.send(["id": id, "ok": true])
    } catch let refusal as SchemaRefusal {
      writer.send(failure(id, "bad-request", refusal.message))
    } catch {
      writer.send(failure(id, "bad-request", error.localizedDescription))
    }
  case "generate":
    registry.reserve(id)
    let task = Task {
      let reply = await generate(id, request)
      writer.send(reply)
      registry.remove(id)
    }
    registry.attach(id, task)
  case "cancel":
    let target = request["target"] as? String ?? ""
    let found = registry.cancel(target)
    writer.send(["id": id, "ok": true, "found": found])
  default:
    writer.send(failure(id, "bad-request", "unknown op"))
  }
}

/// After stdin closes, accepted generations may still finish and answer — a
/// piped caller (and the integration test) writes its requests and closes.
/// Bounded: a parent that is really gone gets its child back within this.
let drainOnEofSeconds = 60.0

Thread.detachNewThread {
  while let line = readLine(strippingNewline: true) {
    handle(line)
  }
  let deadline = Date().addingTimeInterval(drainOnEofSeconds)
  while registry.count > 0 && Date() < deadline {
    Thread.sleep(forTimeInterval: 0.05)
  }
  exit(0)
}
dispatchMain()
