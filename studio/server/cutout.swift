// Cut the subject out of a picture with Apple's Vision framework (the same as "Lift subject" in Photos):
//   cutout <in> <out.png>
// Writes a PNG the size of the input, transparent everywhere but the subject. Exit code 2: no subject found.
import CoreImage
import Foundation
import Vision

let args = CommandLine.arguments
guard args.count == 3 else { FileHandle.standardError.write("usage: cutout <in> <out.png>\n".data(using: .utf8)!); exit(1) }
let input = URL(fileURLWithPath: args[1]), output = URL(fileURLWithPath: args[2])

do {
  let handler = VNImageRequestHandler(url: input, options: [:])
  let request = VNGenerateForegroundInstanceMaskRequest()
  try handler.perform([request])
  guard let result = request.results?.first, !result.allInstances.isEmpty else {
    FileHandle.standardError.write("no subject found\n".data(using: .utf8)!)
    exit(2)
  }
  let buffer = try result.generateMaskedImage(ofInstances: result.allInstances, from: handler, croppedToInstancesExtent: false)
  let image = CIImage(cvPixelBuffer: buffer)
  let ctx = CIContext()
  try ctx.writePNGRepresentation(of: image, to: output, format: .RGBA8, colorSpace: CGColorSpace(name: CGColorSpace.sRGB)!)
} catch {
  FileHandle.standardError.write("\(error.localizedDescription)\n".data(using: .utf8)!)
  exit(1)
}
