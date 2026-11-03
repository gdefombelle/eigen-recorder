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
 *   // pages: Array<{ index, width, height, data: base64JPEG }>
 */
@objc(DocumentScannerPlugin)
public class DocumentScannerPlugin: CAPPlugin, CAPBridgedPlugin, VNDocumentCameraViewControllerDelegate {

    public let identifier = "DocumentScannerPlugin"
    public let jsName    = "DocumentScannerPlugin"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "scan", returnType: CAPPluginReturnPromise)
    ]

    private let MAX_PX: CGFloat = 2048
    private var pendingCall: CAPPluginCall?

    // Separate UIWindow used to present the camera — isolates GPU compositing from WKWebView
    private var scanWindow: UIWindow?

    // MARK: — scan()

    @objc func scan(_ call: CAPPluginCall) {
        print("[DocumentScannerPlugin] scan() appelé")

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

        DispatchQueue.main.async { [weak self] in
            guard let self else { return }

            guard let windowScene = self.bridge?.viewController?.view.window?.windowScene else {
                print("[DocumentScannerPlugin] pas de windowScene disponible")
                self.pendingCall?.reject("No window scene available")
                self.pendingCall = nil
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
            self?.pendingCall?.reject("Cancelled")
            self?.pendingCall = nil
        }
    }

    public func documentCameraViewController(
        _ controller: VNDocumentCameraViewController,
        didFailWithError error: Error
    ) {
        teardownScanWindow { [weak self] in
            self?.pendingCall?.reject(error.localizedDescription)
            self?.pendingCall = nil
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
}
