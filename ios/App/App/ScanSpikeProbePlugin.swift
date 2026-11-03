import Foundation
import UIKit
import AVFoundation
import Capacitor

/**
 * ScanSpikeProbePlugin — TEMPORARY instrumentation for the "Scan a document" audio spike.
 *
 * Counts, from the moment start() is called, the iOS events that would explain an audio
 * dropout during a document scan: audio-session interruptions, route changes, media-services
 * resets, and the app resigning/becoming active (a backgrounded WebView is throttled).
 * snapshot() returns the counters plus the current audio-session state. Read-only: it never
 * touches the session, the recorder or the WebView.
 *
 * Removed (or kept behind a debug flag) once the spike is decided.
 */
@objc(ScanSpikeProbePlugin)
public class ScanSpikeProbePlugin: CAPPlugin, CAPBridgedPlugin {

    public let identifier = "ScanSpikeProbePlugin"
    public let jsName     = "ScanSpikeProbePlugin"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "start",    returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "snapshot", returnType: CAPPluginReturnPromise)
    ]

    private var started = false
    private var interruptionBegan = 0
    private var interruptionEnded = 0
    private var mediaServicesResets = 0
    private var resignActive = 0
    private var becomeActive = 0
    private var routeChanges: [[String: Any]] = []
    private let startedAt = Date()
    private let lock = NSLock()

    @objc func start(_ call: CAPPluginCall) {
        lock.lock(); defer { lock.unlock() }
        if !started {
            started = true
            let nc = NotificationCenter.default
            nc.addObserver(self, selector: #selector(onInterruption(_:)), name: AVAudioSession.interruptionNotification, object: nil)
            nc.addObserver(self, selector: #selector(onRouteChange(_:)), name: AVAudioSession.routeChangeNotification, object: nil)
            nc.addObserver(self, selector: #selector(onMediaReset), name: AVAudioSession.mediaServicesWereResetNotification, object: nil)
            nc.addObserver(self, selector: #selector(onResign), name: UIApplication.willResignActiveNotification, object: nil)
            nc.addObserver(self, selector: #selector(onBecome), name: UIApplication.didBecomeActiveNotification, object: nil)
        }
        call.resolve(["started": true])
    }

    @objc func snapshot(_ call: CAPPluginCall) {
        lock.lock(); defer { lock.unlock() }
        let s = AVAudioSession.sharedInstance()
        call.resolve([
            "interruptionBegan":   interruptionBegan,
            "interruptionEnded":   interruptionEnded,
            "mediaServicesResets": mediaServicesResets,
            "resignActive":        resignActive,
            "becomeActive":        becomeActive,
            "routeChanges":        routeChanges,
            "category":            s.category.rawValue,
            "mode":                s.mode.rawValue,
            "isOtherAudioPlaying": s.isOtherAudioPlaying,
            "sampleRate":          s.sampleRate,
            "inputs":              s.currentRoute.inputs.map { $0.portType.rawValue },
            "appState":            UIApplication.shared.applicationState.rawValue
        ])
    }

    @objc private func onInterruption(_ n: Notification) {
        lock.lock(); defer { lock.unlock() }
        let raw = (n.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt) ?? 0
        if AVAudioSession.InterruptionType(rawValue: raw) == .began { interruptionBegan += 1 } else { interruptionEnded += 1 }
        print("[ScanSpikeProbe] audio interruption type=\(raw)")
    }

    @objc private func onRouteChange(_ n: Notification) {
        lock.lock(); defer { lock.unlock() }
        let reason = (n.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt) ?? 0
        routeChanges.append(["reason": reason, "t": Date().timeIntervalSince(startedAt)])
        print("[ScanSpikeProbe] route change reason=\(reason)")
    }

    @objc private func onMediaReset() { lock.lock(); mediaServicesResets += 1; lock.unlock(); print("[ScanSpikeProbe] media services reset") }
    @objc private func onResign()     { lock.lock(); resignActive += 1; lock.unlock(); print("[ScanSpikeProbe] willResignActive") }
    @objc private func onBecome()     { lock.lock(); becomeActive += 1; lock.unlock(); print("[ScanSpikeProbe] didBecomeActive") }
}
