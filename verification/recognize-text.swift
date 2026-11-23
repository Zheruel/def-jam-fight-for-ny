import Foundation
import Vision

let encoder = JSONEncoder()
encoder.outputFormatting = [.sortedKeys]
var filenames = CommandLine.arguments.dropFirst()
var region: CGRect?
if filenames.first == "--region" {
    let coordinates = filenames.dropFirst().prefix(4).compactMap(Double.init)
    guard coordinates.count == 4, filenames.count >= 6 else {
        fatalError("Expected --region x y width height followed by a filename")
    }
    region = CGRect(x: coordinates[0], y: coordinates[1], width: coordinates[2], height: coordinates[3])
    filenames = filenames.dropFirst(5)
}
for filename in filenames {
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = false
    request.recognitionLanguages = ["en-US"]
    if let region { request.regionOfInterest = region }
    let handler = VNImageRequestHandler(url: URL(fileURLWithPath: filename))
    try handler.perform([request])
    let text = (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }
    print(String(decoding: try encoder.encode(text), as: UTF8.self))
}
