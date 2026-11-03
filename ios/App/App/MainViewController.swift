import UIKit
import Capacitor

/// Subclass of CAPBridgeViewController.
/// Registers local plugins — orientation is controlled by Info.plist UISupportedInterfaceOrientations.
/// Pattern identical to scanner-app (same Capacitor 8 setup).
class MainViewController: CAPBridgeViewController {

    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(EigenAudioPlugin())
        // Document scanner (VisionKit in an isolated UIWindow) + the spike's read-only probe.
        bridge?.registerPluginInstance(DocumentScannerPlugin())
        bridge?.registerPluginInstance(ScanSpikeProbePlugin())
    }
}
