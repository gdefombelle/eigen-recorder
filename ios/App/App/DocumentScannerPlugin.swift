import Foundation
import UIKit
import VisionKit
import Capacitor

/**
 * DocumentScannerPlugin — wraps VNDocumentCameraViewController.
 *
 * Presents the scanner in a dedicated UIWindow (isolated from WKWebView's
 * GPU compositing layer) to avoid the GPU-process crash that occurs when
 * VNDocumentCameraViewController and WKWebView share the same GPU context.
 *
 * JS usage:
 *   const { pages } = await DocumentScannerPlugin.scan();
 *   // pages: Array<{ index, width, height, data: base64JPEG }>     (DocScan's original call, kept for the spike)
 *
 *   const r = await DocumentScannerPlugin.scanToPdf({ maxBytes: 25_000_000 });
 *   // Eigen Pocket: the PDF is assembled NATIVELY (ScanPDF.swift) into the temp directory and only paths cross the
 *   // bridge — never base64. r = { scanId, pdfPath, thumbnailPath, pageCount, sizeBytes, recompressed, maxPixels, quality }.
 *   // Fires the "scanCaptured" event the moment VisionKit closes (before the PDF is built).
 *   // Rejects with code "cancelled" | "too_large" (data: bestBytes, limitBytes, pages) | "empty" | "write_failed".
 *   await DocumentScannerPlugin.cleanup({ scanId: r.scanId });   // ALWAYS, once the JS side has read the files
 */
@objc(DocumentScannerPlugin)
public class DocumentScannerPlugin: CAPPlugin, CAPBridgedPlugin, VNDocumentCameraViewControllerDelegate {

    public let identifier = "DocumentScannerPlugin"
    public let jsName    = "DocumentScannerPlugin"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "scan", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "scanToPdf", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cleanup", returnType: CAPPluginReturnPromise)
    ]

    private let MAX_PX: CGFloat = 2048
    private var pendingCall: CAPPluginCall?
    /// Set by scanToPdf(): the 25 MB budget. nil = the original base64 `scan()` flow.
    private var pendingPdfLimitBytes: Int?

    // Separate UIWindow used to present the camera — isolates GPU compositing from WKWebView
    private var scanWindow: UIWindow?

    // MARK: — scan()

    @objc func scan(_ call: CAPPluginCall) {
        print("[DocumentScannerPlugin] scan() appelé")
        pendingPdfLimitBytes = nil
        presentScanner(call)
    }

    /// Scan → PDF written in the temp directory. Only file paths come back.
    @objc func scanToPdf(_ call: CAPPluginCall) {
        print("[DocumentScannerPlugin] scanToPdf() appelé")
        sweepStaleScans()
        let limit = call.getInt("maxBytes") ?? ScanTemp.defaultLimitBytes
        presentScanner(call) { self.pendingPdfLimitBytes = limit }
    }

    /// Deletes the temp directory of a finished scan. Idempotent; refuses anything outside the scan root.
    @objc func cleanup(_ call: CAPPluginCall) {
        guard let id = call.getString("scanId"), let dir = ScanTemp.directory(forScanId: id) else {
            call.reject("Invalid scanId", "invalid_scan_id"); return
        }
        try? FileManager.default.removeItem(at: dir)
        call.resolve()
    }

    private func presentScanner(_ call: CAPPluginCall, beforePresent: (() -> Void)? = nil) {

        if pendingCall != nil {
            // Check whether the camera is still physically on screen.
            // If WKWebView crashed and reloaded, the JS calls scan() again but the
            // old pendingCall references a dead WKWebView. We detect this by checking
            // whether our scanWindow still has a presented view controller.
            let cameraStillActive = scanWindow?.rootViewController?.presentedViewController != nil
            if cameraStillActive {
                print("[DocumentScannerPlugin] scan déjà en cours — rejet du doublon")
                call.reject("Scan already in progress")
                return
            } else {
                print("[DocumentScannerPlugin] pendingCall obsolète (crash WKWebView?) — reset")
                pendingCall = nil
                scanWindow?.isHidden = true
                scanWindow = nil
            }
        }

        guard VNDocumentCameraViewController.isSupported else {
            print("[DocumentScannerPlugin] VNDocumentCameraViewController NON supporté")
            call.reject("VNDocumentCameraViewController not supported on this device")
            return
        }

        pendingCall = call
        beforePresent?()

        DispatchQueue.main.async { [weak self] in
            guard let self else { return }

            guard let windowScene = self.bridge?.viewController?.view.window?.windowScene else {
                print("[DocumentScannerPlugin] pas de windowScene disponible")
                self.pendingCall?.reject("No window scene available")
                self.pendingCall = nil
                self.pendingPdfLimitBytes = nil
                return
            }

            let vc = VNDocumentCameraViewController()
            vc.delegate = self

            // Present in a separate UIWindow with higher window level.
            // This isolates the camera's GPU compositing from WKWebView,
            // preventing the GPU-process crash observed when both share the same layer tree.
            let window = UIWindow(windowScene: windowScene)
            window.windowLevel = .alert + 1
            let hostVC = UIViewController()
            hostVC.view.backgroundColor = .black
            window.rootViewController = hostVC
            window.makeKeyAndVisible()
            self.scanWindow = window

            print("[DocumentScannerPlugin] présentation dans fenêtre isolée...")
            hostVC.present(vc, animated: true) {
                print("[DocumentScannerPlugin] présenté avec succès")
            }
        }
    }

    // MARK: — Teardown

    private func teardownScanWindow(completion: @escaping () -> Void) {
        DispatchQueue.main.async { [weak self] in
            guard let self else { completion(); return }
            guard let window = self.scanWindow else { completion(); return }

            if let rootVC = window.rootViewController, rootVC.presentedViewController != nil {
                rootVC.dismiss(animated: true) {
                    window.isHidden = true
                    self.scanWindow = nil
                    // Restore Capacitor window as key
                    self.bridge?.viewController?.view.window?.makeKeyAndVisible()
                    completion()
                }
            } else {
                window.isHidden = true
                self.scanWindow = nil
                self.bridge?.viewController?.view.window?.makeKeyAndVisible()
                completion()
            }
        }
    }

    // MARK: — VNDocumentCameraViewControllerDelegate

    public func documentCameraViewController(
        _ controller: VNDocumentCameraViewController,
        didFinishWith scan: VNDocumentCameraScan
    ) {
        teardownScanWindow { [weak self] in
            guard let self else { return }
            guard let call = self.pendingCall else {
                print("[DocumentScannerPlugin] didFinishWith — pas de pendingCall (crash recovery?), résultat ignoré")
                return
            }
            self.pendingCall = nil

            if let limit = self.pendingPdfLimitBytes {
                self.pendingPdfLimitBytes = nil
                // VisionKit is closed: the JS side reads the audio clock NOW for end_offset_ms, before the PDF is built.
                self.notifyListeners("scanCaptured", data: ["pageCount": scan.pageCount])
                DispatchQueue.global(qos: .userInitiated).async { [weak self] in
                    self?.buildPdf(from: scan, limitBytes: limit, call: call)
                }
                return
            }

            DispatchQueue.global(qos: .userInitiated).async { [weak self] in
                guard let self else { return }
                var pages: [[String: Any]] = []

                for i in 0 ..< scan.pageCount {
                    let raw = scan.imageOfPage(at: i)
                    let resized = self.resize(raw)
                    guard let jpeg = resized.jpegData(compressionQuality: 0.88) else { continue }

                    pages.append([
                        "index":  i,
                        "width":  Double(resized.size.width),
                        "height": Double(resized.size.height),
                        "data":   jpeg.base64EncodedString()
                    ])
                }

                print("[DocumentScannerPlugin] résolution — \(pages.count) page(s)")
                call.resolve(["pages": pages])
            }
        }
    }

    public func documentCameraViewControllerDidCancel(
        _ controller: VNDocumentCameraViewController
    ) {
        teardownScanWindow { [weak self] in
            // code "cancelled" for scanToPdf; the message stays "Cancelled" for the original scan() callers.
            self?.pendingCall?.reject("Cancelled", "cancelled")
            self?.pendingCall = nil
            self?.pendingPdfLimitBytes = nil
        }
    }

    public func documentCameraViewController(
        _ controller: VNDocumentCameraViewController,
        didFailWithError error: Error
    ) {
        teardownScanWindow { [weak self] in
            self?.pendingCall?.reject(error.localizedDescription)
            self?.pendingCall = nil
            self?.pendingPdfLimitBytes = nil
        }
    }

    // MARK: — Helpers

    private func resize(_ image: UIImage) -> UIImage {
        let w = image.size.width  * image.scale
        let h = image.size.height * image.scale
        let scale = min(1.0, MAX_PX / max(w, h))
        guard scale < 1.0 else { return image }

        let newSize = CGSize(width: w * scale, height: h * scale)
        let renderer = UIGraphicsImageRenderer(size: newSize)
        return renderer.image { _ in
            image.draw(in: CGRect(origin: .zero, size: newSize))
        }
    }

    // MARK: — PDF building (scanToPdf)

    private func buildPdf(from scan: VNDocumentCameraScan, limitBytes: Int, call: CAPPluginCall) {
        let pageCount = scan.pageCount
        guard pageCount > 0 else { call.reject("The scan has no page", "empty"); return }

        let scanId = UUID().uuidString
        guard let dir = ScanTemp.directory(forScanId: scanId) else { call.reject("Cannot create the temp directory", "write_failed"); return }
        let pdfURL = dir.appendingPathComponent("scan.pdf")
        let thumbURL = dir.appendingPathComponent("thumb.jpg")

        func fail(_ message: String, _ code: String, _ data: [String: Any]? = nil) {
            try? FileManager.default.removeItem(at: dir)         // nothing is left behind on any failure
            call.reject(message, code, nil, data)
        }

        do {
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)

            // Page 1 thumbnail (the card in the attachment strip). Small: it is read by the WebView right away.
            var thumbOK = false
            autoreleasepool {
                let first = Self.renderUpright(scan.imageOfPage(at: 0), maxPixels: 320)
                if let d = first.jpegData(compressionQuality: 0.7) { thumbOK = (try? d.write(to: thumbURL, options: .atomic)) != nil }
            }

            let result = try ScanPDFBuilder.build(pageCount: pageCount, limitBytes: limitBytes, to: pdfURL) { step in
                // One page at a time inside an autoreleasepool: only the compressed JPEG stays in memory,
                // never several full-resolution UIImages at once (a 10-page scan is ~10 × 12 Mpx).
                var out: [Data] = []
                for i in 0 ..< pageCount {
                    try autoreleasepool {
                        let img = Self.renderUpright(scan.imageOfPage(at: i), maxPixels: CGFloat(step.maxPixels))
                        guard let d = img.jpegData(compressionQuality: CGFloat(step.quality)) else { throw ScanPDFError.emptyScan }
                        out.append(d)
                    }
                }
                return out
            }

            print("[DocumentScannerPlugin] PDF \(result.pageCount) page(s), \(result.bytes) B, \(result.step.maxPixels)px q\(result.step.quality), recompressed=\(result.recompressed)")
            var payload: [String: Any] = [
                "scanId":       scanId,
                "pdfPath":      webPath(for: pdfURL),
                "pageCount":    result.pageCount,
                "sizeBytes":    result.bytes,
                "recompressed": result.recompressed,
                "maxPixels":    result.step.maxPixels,
                "quality":      result.step.quality,
            ]
            if thumbOK { payload["thumbnailPath"] = webPath(for: thumbURL) }
            call.resolve(payload)
        } catch let e as ScanPDFError {
            switch e {
            case .tooLarge(let best, let limit, let pages):
                fail("PDF too large even at the lowest quality", "too_large", ["bestBytes": best, "limitBytes": limit, "pages": pages])
            case .emptyScan:
                fail("The scan has no page", "empty")
            }
        } catch {
            fail(error.localizedDescription, "write_failed")
        }
    }

    /// The WebView reads the file with fetch() through Capacitor's file handler (same mechanism as @capacitor/camera's webPath).
    private func webPath(for url: URL) -> String {
        bridge?.portablePath(fromLocalURL: url)?.absoluteString ?? url.absoluteString
    }

    /// Redraws the image upright (VisionKit images can carry an orientation flag that a PDF-embedded JPEG would
    /// ignore) with its long side ≤ maxPixels, at scale 1 so pixels = points, opaque (no alpha channel in the JPEG).
    private static func renderUpright(_ image: UIImage, maxPixels: CGFloat) -> UIImage {
        let w = image.size.width * image.scale, h = image.size.height * image.scale
        let k = min(1.0, maxPixels / max(w, h))
        let size = CGSize(width: max(1, (w * k).rounded()), height: max(1, (h * k).rounded()))
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = true
        return UIGraphicsImageRenderer(size: size, format: format).image { _ in
            UIColor.white.setFill(); UIRectFill(CGRect(origin: .zero, size: size))
            image.draw(in: CGRect(origin: .zero, size: size))
        }
    }

    /// Temp directories left by a crash or a force-quit mid-scan: removed when older than an hour.
    private func sweepStaleScans() {
        DispatchQueue.global(qos: .utility).async { ScanTemp.sweep(olderThan: 3600) }
    }
}
