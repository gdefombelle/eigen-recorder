import Foundation
import CoreGraphics
import ImageIO
import PDFKit
import UniformTypeIdentifiers

// macOS test harness for ios/App/App/ScanPDF.swift (pure Foundation code shared with the app).
// Run: sh scripts/native-tests/run-scan-pdf-tests.sh

var failures = 0
var checks = 0
func check(_ ok: Bool, _ name: String, _ detail: @autoclosure () -> String = "") {
    checks += 1
    if ok { print("  ok   \(name)") } else { failures += 1; print("  FAIL \(name) \(detail())") }
}

// ── Fixtures: JPEGs rendered like a document scan (white page, text-like bars, sensor noise) ──

struct SplitMix: RandomNumberGenerator {          // deterministic noise → reproducible sizes
    var s: UInt64
    mutating func next() -> UInt64 { s &+= 0x9E3779B97F4A7C15; var z = s; z = (z ^ (z >> 30)) &* 0xBF58476D1CE4E5B9; z = (z ^ (z >> 27)) &* 0x94D049BB133111EB; return z ^ (z >> 31) }
}

func makeJPEG(width: Int, height: Int, quality: Double, gray: Bool = false, seed: UInt64 = 1, noise: Int = 18, progressive: Bool = false) -> Data {
    let space = gray ? CGColorSpaceCreateDeviceGray() : CGColorSpaceCreateDeviceRGB()
    let bytesPerPixel = gray ? 1 : 4
    var px = [UInt8](repeating: 255, count: width * height * bytesPerPixel)
    var rng = SplitMix(s: seed)
    // text-like bars
    var y = 80
    while y < height - 80 {
        let barH = 14, len = Int.random(in: width / 3 ... width - 160, using: &rng)
        for yy in y ..< min(y + barH, height) { for xx in 80 ..< min(80 + len, width) {
            let i = (yy * width + xx) * bytesPerPixel
            for c in 0 ..< (gray ? 1 : 3) { px[i + c] = 40 }
        } }
        y += 38
    }
    // sensor noise
    for i in stride(from: 0, to: px.count, by: bytesPerPixel) {
        let n = Int.random(in: -noise ... noise, using: &rng)
        for c in 0 ..< (gray ? 1 : 3) { px[i + c] = UInt8(max(0, min(255, Int(px[i + c]) + n))) }
    }
    let info = gray ? CGImageAlphaInfo.none.rawValue : CGImageAlphaInfo.noneSkipLast.rawValue
    let ctx = CGContext(data: &px, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * bytesPerPixel, space: space, bitmapInfo: info)!
    let image = ctx.makeImage()!
    let out = NSMutableData()
    let dest = CGImageDestinationCreateWithData(out, UTType.jpeg.identifier as CFString, 1, nil)!
    var props: [CFString: Any] = [kCGImageDestinationLossyCompressionQuality: quality]
    if progressive { props[kCGImagePropertyJFIFDictionary] = [kCGImagePropertyJFIFIsProgressive: true] }
    CGImageDestinationAddImage(dest, image, props as CFDictionary)
    CGImageDestinationFinalize(dest)
    return out as Data
}

let tmp = FileManager.default.temporaryDirectory.appendingPathComponent("scanpdf-tests-\(UUID().uuidString)")
try! FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)
defer { try? FileManager.default.removeItem(at: tmp) }
func url(_ n: String) -> URL { tmp.appendingPathComponent(n) }

// ── 1. JPEGInfo ──
print("JPEGInfo")
let rgb = makeJPEG(width: 300, height: 200, quality: 0.8)
let info = try! JPEGInfo.parse(rgb)
check(info.width == 300 && info.height == 200 && info.components == 3, "RGB dimensions and components", "\(info)")
let g = try! JPEGInfo.parse(makeJPEG(width: 120, height: 160, quality: 0.8, gray: true))
check(g.width == 120 && g.height == 160 && g.components == 1, "grayscale JPEG → 1 component", "\(g)")
let prog = makeJPEG(width: 64, height: 48, quality: 0.8, progressive: true)
check(prog.contains(Data([0xFF, 0xC2])), "fixture is really progressive (SOF2)")
let pi = try? JPEGInfo.parse(prog)
check(pi?.width == 64 && pi?.height == 48, "progressive JPEG dimensions are read", "\(String(describing: pi))")
check((try? JPEGInfo.parse(Data([0x89, 0x50, 0x4E, 0x47, 0, 0, 0, 0]))) == nil, "PNG bytes are rejected")
check((try? JPEGInfo.parse(Data(rgb.prefix(10)))) == nil, "truncated JPEG (no SOF) is rejected")
check((try? JPEGInfo.parse(Data())) == nil, "empty data is rejected")

// ── 2. PDFAssembler ──
print("PDFAssembler")
func loadPDF(_ u: URL) -> PDFDocument? { PDFDocument(url: u) }

let onePage = [try! ScanJPEGPage(data: makeJPEG(width: 1500, height: 2000, quality: 0.8))]
let u1 = url("one.pdf")
let size1 = try! PDFAssembler.write(pages: onePage, to: u1)
let attr1 = try! FileManager.default.attributesOfItem(atPath: u1.path)[.size] as! Int
check(size1 == attr1, "returned size equals the file size on disk", "\(size1) vs \(attr1)")
let doc1 = loadPDF(u1)
check(doc1 != nil && doc1!.pageCount == 1, "1-page PDF opens with PDFKit")
let overhead1 = size1 - onePage[0].data.count
check(overhead1 < 2_000, "PDF overhead for 1 page is tiny (JPEG embedded as-is, not re-encoded)", "overhead \(overhead1) B")
if let b = doc1?.page(at: 0)?.bounds(for: .mediaBox) {
    check(abs(b.height - 842) < 0.01 && abs(b.width - 842 * 1500 / 2000) < 0.01, "portrait page keeps the aspect ratio (long side 842 pt)", "\(b)")
} else { check(false, "page 0 has a media box") }

// landscape + mixed sizes + a grayscale page
let mixed = [
    try! ScanJPEGPage(data: makeJPEG(width: 2000, height: 1400, quality: 0.8, seed: 2)),
    try! ScanJPEGPage(data: makeJPEG(width: 1400, height: 2000, quality: 0.8, seed: 3)),
    try! ScanJPEGPage(data: makeJPEG(width: 900,  height: 1200, quality: 0.8, gray: true, seed: 4)),
]
let um = url("mixed.pdf")
_ = try! PDFAssembler.write(pages: mixed, to: um)
let docm = loadPDF(um)
check(docm?.pageCount == 3, "3 mixed pages → 3 PDF pages", "\(String(describing: docm?.pageCount))")
let b0 = docm?.page(at: 0)?.bounds(for: .mediaBox) ?? .zero
let b1 = docm?.page(at: 1)?.bounds(for: .mediaBox) ?? .zero
check(b0.width > b0.height && b1.height > b1.width, "landscape and portrait pages keep their orientation", "\(b0) \(b1)")

// the page really renders the embedded image (not a blank page)
func renderedMean(_ page: PDFPage) -> Double {
    let w = 200, h = 280
    var buf = [UInt8](repeating: 0, count: w * h * 4)
    let ctx = CGContext(data: &buf, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    ctx.setFillColor(CGColor(red: 1, green: 0, blue: 1, alpha: 1)); ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))   // magenta = "nothing drawn"
    let bounds = page.bounds(for: .mediaBox)
    ctx.scaleBy(x: CGFloat(w) / bounds.width, y: CGFloat(h) / bounds.height)
    page.draw(with: .mediaBox, to: ctx)
    var green = 0.0; for i in stride(from: 1, to: buf.count, by: 4) { green += Double(buf[i]) }
    return green / Double(w * h)
}
check(doc1?.page(at: 0).map { renderedMean($0) > 150 } ?? false, "rendered page shows the (mostly white) scan, not the magenta background")

// ── 10 realistic pages (2000 px, q0.8): size, validity, time ──
let tenSrc = (0 ..< 10).map { try! ScanJPEGPage(data: makeJPEG(width: 1500, height: 2000, quality: 0.8, seed: UInt64($0 + 10))) }
let ut = url("ten.pdf")
let t0 = Date()
let sizeTen = try! PDFAssembler.write(pages: tenSrc, to: ut)
let ms = Int(Date().timeIntervalSince(t0) * 1000)
let sumTen = tenSrc.reduce(0) { $0 + $1.data.count }
check(loadPDF(ut)?.pageCount == 10, "10-page PDF opens with 10 pages")
check(sizeTen - sumTen < 10_000, "10 pages: PDF = JPEG bytes + <10 kB structure", "sum \(sumTen) pdf \(sizeTen)")
print("  info 10 pages 1500x2000 q0.8: \(sizeTen / 1024) KB, written in \(ms) ms")

// xref table is exact: every offset points at '<n> 0 obj'
let raw = try! Data(contentsOf: ut)
let text = String(decoding: raw, as: UTF8.self)
if let sx = text.range(of: "startxref\n", options: .backwards) {
    let startXref = Int(text[sx.upperBound...].prefix(while: { $0.isNumber }))!
    let table = String(decoding: raw[startXref...], as: UTF8.self).split(separator: "\n")
    let entries = table.dropFirst(3).prefix(while: { $0.hasSuffix(" n ") })   // skip "xref", "0 N", free entry
    var okOffsets = true
    for (n, e) in entries.enumerated() {
        let off = Int(e.prefix(10))!
        let head = String(decoding: raw[off ..< min(off + 12, raw.count)], as: UTF8.self)
        if !head.hasPrefix("\(n + 1) 0 obj") { okOffsets = false }
    }
    check(okOffsets && entries.count == 2 + 3 * 10, "xref offsets all point at their object (\(entries.count) entries)")
} else { check(false, "startxref present") }

// ── 3. ScanPDFBuilder (25 MB control) ──
print("ScanPDFBuilder")
func encoder(pages n: Int, width: Int = 1500, height: Int = 2000, seed: UInt64 = 50) -> (ScanQualityStep) throws -> [Data] {
    return { step in
        let k = Double(step.maxPixels) / 2000
        return (0 ..< n).map { makeJPEG(width: Int(Double(width) * k), height: Int(Double(height) * k), quality: step.quality, seed: seed + UInt64($0)) }
    }
}

// fits on the first rung: no recompression
let ub = url("b1.pdf")
let r1 = try! ScanPDFBuilder.build(pageCount: 3, limitBytes: 25_000_000, to: ub, encode: encoder(pages: 3))
check(r1.step == ScanPDFBuilder.ladder[0] && !r1.recompressed && r1.pageCount == 3, "fits at 2000 px / q0.80 → not recompressed", "\(r1)")
check((try! FileManager.default.attributesOfItem(atPath: ub.path)[.size] as! Int) == r1.bytes, "reported bytes = file size")

// force a recompression: limit between the smallest rung and the first rung
let firstSize = r1.bytes
let limit2 = Int(Double(firstSize) * 0.6)
let r2 = try! ScanPDFBuilder.build(pageCount: 3, limitBytes: limit2, to: url("b2.pdf"), encode: encoder(pages: 3))
check(r2.recompressed && r2.bytes <= limit2 && r2.step != ScanPDFBuilder.ladder[0], "limit at 60 % → a lower rung is used and the result fits", "\(r2) limit \(limit2)")
check(loadPDF(url("b2.pdf"))?.pageCount == 3, "recompressed PDF still has its 3 pages")

// impossible: even the smallest rung is too big
var calls = 0
let ui = url("b3.pdf")
do {
    _ = try ScanPDFBuilder.build(pageCount: 3, limitBytes: 5_000, to: ui, encode: { s in calls += 1; return try encoder(pages: 3)(s) })
    check(false, "impossible limit must throw")
} catch let e as ScanPDFError {
    if case .tooLarge(let best, let limit, let pages) = e {
        check(limit == 5_000 && pages == 3 && best > limit, "tooLarge carries best size, limit and pages", "\(e)")
    } else { check(false, "tooLarge expected", "\(e)") }
} catch { check(false, "unexpected error \(error)") }
check(calls == ScanPDFBuilder.ladder.count, "every rung was tried before giving up", "\(calls) calls")
check(!FileManager.default.fileExists(atPath: ui.path), "no partial PDF is left behind when it cannot fit")

// the JPEGs fit but the PDF structure pushes it over: the file that was written must not be left behind
let jp = makeJPEG(width: 500, height: 700, quality: 0.8, seed: 9)
let uo = url("b7.pdf")
do { _ = try ScanPDFBuilder.build(pageCount: 1, limitBytes: jp.count + 10, to: uo, ladder: [ScanPDFBuilder.ladder[0]], encode: { _ in [jp] }); check(false, "must throw when only the structure overflows") }
catch { check(true, "overflow by PDF structure alone still throws") }
check(!FileManager.default.fileExists(atPath: uo.path), "the written-then-rejected PDF is deleted")

// a rung whose JPEG payload already exceeds the limit never reaches the (slow) PDF writer
var writes = 0
_ = try? ScanPDFBuilder.build(pageCount: 1, limitBytes: 100, to: url("b4.pdf"), ladder: Array(ScanPDFBuilder.ladder.prefix(2)),
                              writePDF: { p, u in writes += 1; return try PDFAssembler.write(pages: p, to: u) }, encode: encoder(pages: 1))
check(writes == 0, "rungs whose JPEG payload exceeds the limit are skipped without writing a PDF", "\(writes) writes")
var writes2 = 0
_ = try? ScanPDFBuilder.build(pageCount: 1, limitBytes: 25_000_000, to: url("b6.pdf"),
                              writePDF: { p, u in writes2 += 1; return try PDFAssembler.write(pages: p, to: u) }, encode: encoder(pages: 1))
check(writes2 == 1, "a scan that fits is written exactly once", "\(writes2) writes")

// empty scan
do { _ = try ScanPDFBuilder.build(pageCount: 0, limitBytes: 25_000_000, to: url("b5.pdf"), encode: { _ in [] }); check(false, "empty scan must throw") }
catch let e as ScanPDFError { check(e == .emptyScan, "empty scan → emptyScan") } catch { check(false, "unexpected \(error)") }

// the real scenario: 30 pages of dense scans against the 25 MB limit
let dense = encoder(pages: 30, width: 1500, height: 2000, seed: 200)
let t1 = Date()
let r30 = try! ScanPDFBuilder.build(pageCount: 30, limitBytes: 25_000_000, to: url("b30.pdf"), encode: { s in try dense(s) })
check(r30.bytes <= 25_000_000 && loadPDF(url("b30.pdf"))?.pageCount == 30, "30 dense pages end ≤ 25 MB with all pages", "\(r30)")
print("  info 30 dense pages: \(r30.bytes / 1_000_000) MB, rung \(r30.step.maxPixels)px q\(r30.step.quality), recompressed=\(r30.recompressed), \(Int(Date().timeIntervalSince(t1) * 1000)) ms")

// ── 4. ScanTemp (cleanup safety + stale sweep) ──
print("ScanTemp")
let root = url("scanroot")
try! FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
let goodId = UUID().uuidString
check(ScanTemp.directory(forScanId: goodId, root: root)?.lastPathComponent == goodId, "a UUID maps to its directory under the root")
for bad in ["../etc", "/var/mobile", "", "a/b", "..", "scan-1", goodId + "/../x"] {
    check(ScanTemp.directory(forScanId: bad, root: root) == nil, "cleanup id '\(bad)' is refused")
}
let old = root.appendingPathComponent("old"), fresh = root.appendingPathComponent("fresh")
try! FileManager.default.createDirectory(at: old, withIntermediateDirectories: true)
try! FileManager.default.createDirectory(at: fresh, withIntermediateDirectories: true)
try! FileManager.default.setAttributes([.modificationDate: Date().addingTimeInterval(-7_200)], ofItemAtPath: old.path)
let removed = ScanTemp.sweep(olderThan: 3_600, root: root)
check(removed == 1 && !FileManager.default.fileExists(atPath: old.path) && FileManager.default.fileExists(atPath: fresh.path), "sweep removes only directories older than the threshold", "removed \(removed)")
check(ScanTemp.sweep(olderThan: 3_600, root: url("missing-root")) == 0, "sweep on a missing root is a no-op")

print("\n\(checks - failures)/\(checks) checks passed")
exit(failures == 0 ? 0 : 1)
