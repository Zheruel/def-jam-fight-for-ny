import Foundation
import Vision

let encoder = JSONEncoder()
encoder.outputFormatting = [.sortedKeys]
for filename in CommandLine.arguments.dropFirst() {
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = false
    request.recognitionLanguages = ["en-US"]
    let handler = VNImageRequestHandler(url: URL(fileURLWithPath: filename))
    try handler.perform([request])
    let text = (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }
    print(String(decoding: try encoder.encode(text), as: UTF8.self))
}
