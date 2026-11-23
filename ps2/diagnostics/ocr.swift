import Foundation
import Vision

for file in CommandLine.arguments.dropFirst() {
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .fast
    request.usesLanguageCorrection = false
    let handler = VNImageRequestHandler(url: URL(fileURLWithPath: file), options: [:])
    do {
        try handler.perform([request])
        let strings = request.results?.compactMap { $0.topCandidates(1).first?.string } ?? []
        print(file + "\t" + strings.joined(separator: " | "))
    } catch {
        fputs("OCR failed: \(error)\n", stderr)
    }
}
