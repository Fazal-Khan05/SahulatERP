// Prints {"<title>": page} for each title argument: the first page after the contents page whose text contains it.
import PDFKit
import Foundation
let args = Array(CommandLine.arguments.dropFirst())
let doc = PDFDocument(url: URL(fileURLWithPath: args[0]))!
var result: [String: Int] = [:]
for title in args.dropFirst() {
  for i in 2..<doc.pageCount {
    if let text = doc.page(at: i)?.string, text.contains(title) { result[title] = i + 1; break }
  }
}
let data = try! JSONSerialization.data(withJSONObject: result, options: [.sortedKeys])
print(String(data: data, encoding: .utf8)!)
