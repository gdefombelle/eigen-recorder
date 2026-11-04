import Foundation

// ScanPDF — pure Foundation (no UIKit), so it compiles and is tested on macOS
// (scripts/native-tests/run-scan-pdf-tests.sh) as well as in the app.
//
//   JPEGInfo        reads width / height / colour components from a JPEG's SOF marker
//   PDFAssembler    writes a multi-page PDF where every page is one JPEG embedded as-is (DCTDecode),
//                   streamed to disk: the output size is known (≈ sum of the JPEGs) and no
//                   re-encoding can inflate it. PDFKit's PDFPage(image:) is avoided on purpose: it
//                   tends to re-encode losslessly, which turns a 2 MB scan into 20 MB.
//   ScanPDFBuilder  the 25 MB control: tries the quality ladder until the file fits, or fails with a
//                   clear error carrying the best size reached.

public struct JPEGInfo: Equatable {
    public let width: Int
    public let height: Int
    public let components: Int

    public enum ParseError: Error, Equatable { case notAJPEG, noFrameHeader, unsupportedComponents(Int) }

    /// Walks the marker segments until a Start-Of-Frame marker (baseline / extended / progressive).
    public static func parse(_ data: Data) throws -> JPEGInfo {
        let b = [UInt8](data)
        guard b.count > 4, b[0] == 0xFF, b[1] == 0xD8 else { throw ParseError.notAJPEG }
        var i = 2
        while i + 3 < b.count {
            guard b[i] == 0xFF else { i += 1; continue }
            var marker = b[i + 1]
            while marker == 0xFF, i + 2 < b.count { i += 1; marker = b[i + 1] }   // fill bytes
            i += 2
            // Markers without a length: SOI, EOI, RSTn, TEM.
            if marker == 0xD8 || marker == 0xD9 || marker == 0x01 || (0xD0...0xD7).contains(marker) { continue }
            guard i + 1 < b.count else { break }
            let length = Int(b[i]) << 8 | Int(b[i + 1])
            let isSOF = (0xC0...0xCF).contains(marker) && marker != 0xC4 && marker != 0xC8 && marker != 0xCC
            if isSOF {
                guard i + 7 < b.count else { break }
                let height = Int(b[i + 3]) << 8 | Int(b[i + 4])
                let width  = Int(b[i + 5]) << 8 | Int(b[i + 6])
                let comps  = Int(b[i + 7])
                guard comps == 1 || comps == 3 else { throw ParseError.unsupportedComponents(comps) }
                return JPEGInfo(width: width, height: height, components: comps)
            }
            i += max(length, 2)
        }
        throw ParseError.noFrameHeader
    }
}

public struct ScanJPEGPage {
    public let data: Data
    public let info: JPEGInfo
    public init(data: Data) throws { self.data = data; self.info = try JPEGInfo.parse(data) }
}

public enum PDFAssembler {
    /// Long side of a page in PDF points (A4 = 842 pt); the other side follows the image's aspect ratio.
    public static let pageLongSidePoints: Double = 842

    /// Writes the PDF to `url` and returns its size in bytes. Streams page by page.
    @discardableResult
    public static func write(pages: [ScanJPEGPage], to url: URL) throws -> Int {
        precondition(!pages.isEmpty, "a PDF needs at least one page")
        FileManager.default.createFile(atPath: url.path, contents: nil)
        let handle = try FileHandle(forWritingTo: url)
        defer { try? handle.close() }

        var offset = 0
        var xref: [Int] = []          // byte offset of object n+1
        func emit(_ s: String) throws { try emit(Data(s.utf8)) }
        func emit(_ d: Data) throws { try handle.write(contentsOf: d); offset += d.count }
        func beginObject() { xref.append(offset) }

        // Object numbering: 1 catalog, 2 pages, then per page i: page = 3+3i, content = 4+3i, image = 5+3i.
        try emit("%PDF-1.4\n%\u{00E2}\u{00E3}\u{00CF}\u{00D3}\n")
        beginObject(); try emit("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n")
        let kids = pages.indices.map { "\(3 + 3 * $0) 0 R" }.joined(separator: " ")
        beginObject(); try emit("2 0 obj\n<< /Type /Pages /Count \(pages.count) /Kids [\(kids)] >>\nendobj\n")

        for (i, page) in pages.enumerated() {
            let (w, h) = pageSize(page.info)
            let pageObj = 3 + 3 * i, contentObj = pageObj + 1, imageObj = pageObj + 2
            beginObject()
            try emit("\(pageObj) 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 \(fmt(w)) \(fmt(h))] "
                   + "/Resources << /XObject << /Im0 \(imageObj) 0 R >> >> /Contents \(contentObj) 0 R >>\nendobj\n")
            let content = "q \(fmt(w)) 0 0 \(fmt(h)) 0 0 cm /Im0 Do Q\n"
            beginObject()
            try emit("\(contentObj) 0 obj\n<< /Length \(content.utf8.count) >>\nstream\n\(content)endstream\nendobj\n")
            let cs = page.info.components == 1 ? "/DeviceGray" : "/DeviceRGB"
            beginObject()
            try emit("\(imageObj) 0 obj\n<< /Type /XObject /Subtype /Image /Width \(page.info.width) /Height \(page.info.height) "
                   + "/ColorSpace \(cs) /BitsPerComponent 8 /Filter /DCTDecode /Length \(page.data.count) >>\nstream\n")
            try emit(page.data)
            try emit("\nendstream\nendobj\n")
        }

        let xrefStart = offset
        let count = xref.count + 1
        var table = "xref\n0 \(count)\n0000000000 65535 f \n"
        for o in xref { table += String(format: "%010d 00000 n \n", o) }
        table += "trailer\n<< /Size \(count) /Root 1 0 R >>\nstartxref\n\(xrefStart)\n%%EOF\n"
        try emit(table)
        return offset
    }

    static func pageSize(_ info: JPEGInfo) -> (Double, Double) {
        let w = Double(max(info.width, 1)), h = Double(max(info.height, 1))
        let k = pageLongSidePoints / max(w, h)
        return (w * k, h * k)
    }

    private static func fmt(_ v: Double) -> String { String(format: "%.2f", v) }
}

// MARK: — Size budget

/// One rung of the recompression ladder.
public struct ScanQualityStep: Equatable {
    public let maxPixels: Int
    public let quality: Double
}

public enum ScanPDFError: Error, Equatable {
    /// Even the smallest rung is over the limit. `bestBytes` is what the smallest rung produced.
    case tooLarge(bestBytes: Int, limitBytes: Int, pages: Int)
    case emptyScan
}

public struct ScanPDFResult: Equatable {
    public let bytes: Int
    public let pageCount: Int
    public let step: ScanQualityStep
    public let recompressed: Bool        // false when the first rung already fit
}

public enum ScanPDFBuilder {
    /// First rung = the agreed default (2000 px, quality 0.8). Later rungs only when the 25 MB limit would be exceeded.
    public static let ladder: [ScanQualityStep] = [
        ScanQualityStep(maxPixels: 2000, quality: 0.80),
        ScanQualityStep(maxPixels: 2000, quality: 0.65),
        ScanQualityStep(maxPixels: 1700, quality: 0.55),
        ScanQualityStep(maxPixels: 1400, quality: 0.45),
        ScanQualityStep(maxPixels: 1200, quality: 0.40),
        ScanQualityStep(maxPixels: 1000, quality: 0.35),
        ScanQualityStep(maxPixels: 800,  quality: 0.30),
    ]

    /// `encode(step)` returns one JPEG per page for that rung (the plugin renders from the VisionKit
    /// images; tests pass synthetic JPEGs). The PDF is rewritten at `url` on every rung that is tried.
    public static func build(
        pageCount: Int,
        limitBytes: Int,
        to url: URL,
        ladder: [ScanQualityStep] = ScanPDFBuilder.ladder,
        writePDF: ([ScanJPEGPage], URL) throws -> Int = { try PDFAssembler.write(pages: $0, to: $1) },
        encode: (ScanQualityStep) throws -> [Data]
    ) throws -> ScanPDFResult {
        guard pageCount > 0 else { throw ScanPDFError.emptyScan }
        var best = Int.max
        for (n, step) in ladder.enumerated() {
            let jpegs = try encode(step)
            let pages = try jpegs.map { try ScanJPEGPage(data: $0) }
            // The JPEG payload dominates: skip writing a file that cannot possibly fit (saves minutes on 30 pages).
            let payload = pages.reduce(0) { $0 + $1.data.count }
            if payload > limitBytes { best = min(best, payload); continue }
            let bytes = try writePDF(pages, url)
            if bytes <= limitBytes {
                return ScanPDFResult(bytes: bytes, pageCount: pages.count, step: step, recompressed: n > 0)
            }
            best = min(best, bytes)
        }
        try? FileManager.default.removeItem(at: url)
        throw ScanPDFError.tooLarge(bestBytes: best, limitBytes: limitBytes, pages: pageCount)
    }
}

// MARK: — Temp storage

/// Where scan files live: <tmp>/eigen-scan/<scanId>/{scan.pdf, thumb.jpg}. One directory per scan so a single
/// delete cleans everything, and the root is the only place cleanup() is allowed to delete from.
public enum ScanTemp {
    public static let defaultLimitBytes = 25_000_000
    public static var root: URL { FileManager.default.temporaryDirectory.appendingPathComponent("eigen-scan", isDirectory: true) }

    /// nil when the id is not a plain UUID (blocks "../" and absolute paths coming from the WebView).
    public static func directory(forScanId id: String, root: URL = ScanTemp.root) -> URL? {
        guard UUID(uuidString: id) != nil else { return nil }
        return root.appendingPathComponent(id, isDirectory: true)
    }

    /// Removes scan directories whose modification date is older than `olderThan` seconds. Returns how many were removed.
    @discardableResult
    public static func sweep(olderThan seconds: TimeInterval, root: URL = ScanTemp.root, now: Date = Date()) -> Int {
        let fm = FileManager.default
        guard let items = try? fm.contentsOfDirectory(at: root, includingPropertiesForKeys: [.contentModificationDateKey]) else { return 0 }
        var removed = 0
        for u in items {
            let modified = (try? u.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast
            if now.timeIntervalSince(modified) > seconds, (try? fm.removeItem(at: u)) != nil { removed += 1 }
        }
        return removed
    }
}
