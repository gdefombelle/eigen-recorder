import Foundation
import AVFoundation
import CoreLocation
import Capacitor

// EigenAudioPlugin — AVAudioRecorder-based (same API as Dictaphone).
// Simpler and more reliable than AVAudioEngine for multi-channel capture.
// Chunks = sequential AVAudioRecorder instances, one file per chunk.

@objc(EigenAudioPlugin)
public class EigenAudioPlugin: CAPPlugin, CAPBridgedPlugin {

    public let identifier   = "EigenAudioPlugin"
    public let jsName       = "EigenAudioPlugin"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "requestLocationPermission", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getLocation",               returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestPermission", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "startRecording",    returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pauseRecording",    returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "resumeRecording",   returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopRecording",     returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getElapsedMs",      returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getMicLevel",       returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "mergeChunks",       returnType: CAPPluginReturnPromise),
    ]

    // ── Location ──────────────────────────────────────────────────────────

    private lazy var locationManager: CLLocationManager = {
        let m = CLLocationManager()
        m.delegate = locationDelegate
        m.desiredAccuracy = kCLLocationAccuracyHundredMeters
        return m
    }()
    private lazy var locationDelegate = LocationDelegate()

    @objc func requestLocationPermission(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            let status = self.locationManager.authorizationStatus
            if status == .notDetermined {
                self.locationDelegate.permissionCall = call
                self.locationManager.requestWhenInUseAuthorization()
                // Safety: resolve as denied after 12s if dialog never answered
                DispatchQueue.main.asyncAfter(deadline: .now() + 12) { [weak self] in
                    guard let d = self?.locationDelegate, d.permissionCall != nil else { return }
                    d.permissionCall = nil
                    call.resolve(["granted": false])
                }
            } else if status == .authorizedWhenInUse || status == .authorizedAlways {
                call.resolve(["granted": true])
            } else {
                call.resolve(["granted": false])
            }
        }
    }

    @objc func getLocation(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            let status = self.locationManager.authorizationStatus
            guard status == .authorizedWhenInUse || status == .authorizedAlways else {
                call.reject("Permission: \(status.rawValue)")
                return
            }
            self.locationDelegate.locationCall = call
            self.locationManager.requestLocation()
            // Safety: reject after 10s if no location received
            DispatchQueue.main.asyncAfter(deadline: .now() + 10) { [weak self] in
                guard let d = self?.locationDelegate, d.locationCall != nil else { return }
                d.locationCall = nil
                call.reject("Location timeout")
            }
        }
    }

    // ── State ──────────────────────────────────────────────────────────────

    private var recorder: AVAudioRecorder?
    private var chunkTimer: Timer?
    private var levelTimer: Timer?

    private var sessionId:    String = ""
    private var chunkIndex:   Int    = 0
    private var chunkDurMs:   Int    = 5000
    private var recordSettings: [String: Any] = [:]

    private var sessionStartDate: Date?
    private var pauseStartDate:   Date?
    private var pausedAccumMs:    Double = 0
    private var isPaused:         Bool   = false
    private var currentChunkStart: Double = 0

    private var savedChunks: [[String: Any]] = []
    private var _levelL: Float = 0
    private var _levelR: Float = 0

    // ── Permission ─────────────────────────────────────────────────────────

    @objc func requestPermission(_ call: CAPPluginCall) {
        AVAudioSession.sharedInstance().requestRecordPermission { granted in
            call.resolve(["granted": granted])
        }
    }

    // ── startRecording ─────────────────────────────────────────────────────

    @objc func startRecording(_ call: CAPPluginCall) {
        sessionId  = call.getString("sessionId")    ?? UUID().uuidString
        chunkDurMs = call.getInt("chunkDurationMs") ?? 5000
        let stereo = call.getBool("stereo")         ?? true
        let sr     = Double(call.getInt("sampleRate") ?? 48000)

        savedChunks      = []
        chunkIndex       = 0
        pausedAccumMs    = 0
        isPaused         = false
        currentChunkStart = 0

        // 1. Configure AVAudioSession
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(.record, mode: .default, options: [.allowBluetooth])
            try session.setActive(true)

            // Request stereo after activation (requires active route)
            if stereo && session.maximumInputNumberOfChannels >= 2 {
                try? session.setPreferredInputNumberOfChannels(2)
            }
            // Polar pattern stereo for XS+
            if stereo, #available(iOS 14.0, *) {
                try? configureStereoInput(session: session)
            }
        } catch {
            call.reject("AVAudioSession setup failed: \(error.localizedDescription)")
            return
        }

        // 2. Build recording settings — use actual granted channels
        let grantedChannels = min(session.currentRoute.inputs.first?.channels?.count ?? 1,
                                  stereo ? 2 : 1)
        // M4A AAC stereo — high quality for sharing.
        // EigenVertex backend converts to WAV 16kHz mono for Voxtral on sync path.
        // ~40KB per 5s chunk (vs 480KB for WAV stereo 48kHz).
        recordSettings = [
            AVFormatIDKey:            Int(kAudioFormatMPEG4AAC),
            AVSampleRateKey:          48_000.0,
            AVNumberOfChannelsKey:    grantedChannels,
            AVEncoderAudioQualityKey: AVAudioQuality.high.rawValue,
            AVEncoderBitRateKey:      128_000,
        ]

        // 3. Start first chunk
        sessionStartDate = Date()
        guard startNextRecorder() else {
            call.reject("Failed to start recorder")
            return
        }

        // 4 & 5. Timers MUST run on the main RunLoop (Capacitor calls plugin on background thread)
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.chunkTimer = Timer.scheduledTimer(
                withTimeInterval: Double(self.chunkDurMs) / 1000.0,
                repeats: true
            ) { [weak self] _ in self?.rotateChunk() }

            self.levelTimer = Timer.scheduledTimer(
                withTimeInterval: 0.08,
                repeats: true
            ) { [weak self] _ in self?.updateLevels() }
        }

        call.resolve()
    }

    // ── pauseRecording ─────────────────────────────────────────────────────

    @objc func pauseRecording(_ call: CAPPluginCall) {
        guard !isPaused else { call.resolve(); return }
        chunkTimer?.invalidate()
        chunkTimer = nil
        recorder?.pause()
        pauseStartDate = Date()
        isPaused = true
        _levelL = 0; _levelR = 0
        call.resolve()
    }

    // ── resumeRecording ────────────────────────────────────────────────────

    @objc func resumeRecording(_ call: CAPPluginCall) {
        guard isPaused else { call.resolve(); return }
        if let ps = pauseStartDate {
            pausedAccumMs += Date().timeIntervalSince(ps) * 1000
        }
        isPaused = false
        recorder?.record()
        currentChunkStart = elapsedMs()

        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.chunkTimer = Timer.scheduledTimer(
                withTimeInterval: Double(self.chunkDurMs) / 1000.0,
                repeats: true
            ) { [weak self] _ in self?.rotateChunk() }
        }
        call.resolve()
    }

    // ── stopRecording ──────────────────────────────────────────────────────

    @objc func stopRecording(_ call: CAPPluginCall) {
        chunkTimer?.invalidate(); chunkTimer = nil
        levelTimer?.invalidate(); levelTimer = nil

        finaliseCurrentChunk()
        recorder?.stop()
        recorder = nil

        try? AVAudioSession.sharedInstance().setActive(false,
                                                       options: .notifyOthersOnDeactivation)

        let result = savedChunks
        savedChunks = []
        call.resolve(["chunks": result, "durationMs": elapsedMs()])
    }

    // ── getElapsedMs ───────────────────────────────────────────────────────

    @objc func getElapsedMs(_ call: CAPPluginCall) {
        call.resolve(["value": elapsedMs()])
    }

    // ── getMicLevel ────────────────────────────────────────────────────────

    // ── mergeChunks ───────────────────────────────────────────────────────────
    // Merges all .m4a chunks for a session into one valid M4A file using
    // AVMutableComposition + AVAssetExportSession. Returns base64-encoded result.

    @objc func mergeChunks(_ call: CAPPluginCall) {
        guard let sessionId = call.getString("sessionId") else {
            call.reject("sessionId required"); return
        }

        let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        let dir  = docs.appendingPathComponent("EigenChunks/\(sessionId)", isDirectory: true)
        let files: [URL]
        do {
            files = try FileManager.default
                .contentsOfDirectory(at: dir, includingPropertiesForKeys: nil)
                .filter { $0.pathExtension == "m4a" }
                .sorted { $0.lastPathComponent < $1.lastPathComponent }
        } catch {
            call.reject("Could not list chunks: \(error.localizedDescription)"); return
        }

        guard !files.isEmpty else {
            call.reject("No chunks found for session \(sessionId)"); return
        }

        // M4A: merge via AVMutableComposition + AVAssetExportSession (proper M4A container)
        let composition = AVMutableComposition()
        guard let compTrack = composition.addMutableTrack(
            withMediaType: .audio,
            preferredTrackID: kCMPersistentTrackID_Invalid
        ) else {
            call.reject("Could not create composition track"); return
        }

        var insertAt = CMTime.zero
        for url in files {
            let asset = AVURLAsset(url: url)
            guard let track = asset.tracks(withMediaType: .audio).first else { continue }
            let range = CMTimeRange(start: .zero, duration: asset.duration)
            do {
                try compTrack.insertTimeRange(range, of: track, at: insertAt)
                insertAt = CMTimeAdd(insertAt, asset.duration)
            } catch {
                print("[EigenAudio] Merge: skip \(url.lastPathComponent): \(error)")
            }
        }

        let outputURL = dir.appendingPathComponent("_merged.m4a")
        try? FileManager.default.removeItem(at: outputURL)

        guard let exportSession = AVAssetExportSession(
            asset: composition, presetName: AVAssetExportPresetAppleM4A
        ) else {
            call.reject("Could not create AVAssetExportSession"); return
        }
        exportSession.outputURL      = outputURL
        exportSession.outputFileType = .m4a

        exportSession.exportAsynchronously {
            switch exportSession.status {
            case .completed:
                let data = (try? Data(contentsOf: outputURL)) ?? Data()
                call.resolve([
                    "base64":    data.base64EncodedString(),
                    "mimeType":  "audio/mp4",
                    "sizeBytes": data.count,
                    "path":      outputURL.absoluteString,
                ])
            default:
                call.reject(exportSession.error?.localizedDescription ?? "Export failed")
            }
        }
    }

    @objc func getMicLevel(_ call: CAPPluginCall) {
        let avg = (_levelL + _levelR) / 2
        call.resolve([
            "value": Double(avg),
            "left":  Double(_levelL),
            "right": Double(_levelR),
        ])
    }

    // ── Private ────────────────────────────────────────────────────────────

    private func elapsedMs() -> Double {
        guard let start = sessionStartDate else { return 0 }
        let nowPaused: Double
        if isPaused, let ps = pauseStartDate {
            nowPaused = pausedAccumMs + Date().timeIntervalSince(ps) * 1000
        } else {
            nowPaused = pausedAccumMs
        }
        return Date().timeIntervalSince(start) * 1000 - nowPaused
    }

    private func chunkURL(for index: Int) -> URL {
        let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        let dir  = docs.appendingPathComponent("EigenChunks/\(sessionId)", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("chunk_\(String(format: "%04d", index)).m4a")
    }

    private func startNextRecorder() -> Bool {
        currentChunkStart = elapsedMs()
        let url = chunkURL(for: chunkIndex)
        guard let rec = try? AVAudioRecorder(url: url, settings: recordSettings) else {
            print("[EigenAudio] AVAudioRecorder init failed for chunk \(chunkIndex)")
            return false
        }
        rec.isMeteringEnabled = true
        rec.prepareToRecord()
        let started = rec.record()
        if !started {
            print("[EigenAudio] record() returned false for chunk \(chunkIndex)")
        }
        recorder = rec
        return started
    }

    private func rotateChunk() {
        finaliseCurrentChunk()
        recorder?.stop()
        chunkIndex += 1
        _ = startNextRecorder()
    }

    private func finaliseCurrentChunk() {
        guard let rec = recorder else { return }
        let url      = rec.url
        let endMs    = elapsedMs()
        let channels = (recordSettings[AVNumberOfChannelsKey] as? Int) ?? 1

        // Read file and encode as base64 — fetch('file://') is blocked in WKWebView
        let data       = (try? Data(contentsOf: url)) ?? Data()
        let base64     = data.base64EncodedString()
        let sizeBytes  = data.count

        savedChunks.append([
            "path":      url.absoluteString,
            "base64":    base64,
            "index":     chunkIndex,
            "startMs":   currentChunkStart,
            
            "endMs":     endMs,
            "sizeBytes": sizeBytes,
            "mimeType":  "audio/mp4",
            "isStereo":  channels >= 2,
            "channels":  channels,
        ])
    }

    private func updateLevels() {
        guard let rec = recorder, rec.isRecording else {
            _levelL = 0; _levelR = 0; return
        }
        rec.updateMeters()
        // AVAudioRecorder returns dB: -160 (silence) to 0 (full scale)
        let dbL = rec.peakPower(forChannel: 0)
        let dbR = rec.channelAssignments != nil && rec.channelAssignments!.count > 1
                  ? rec.peakPower(forChannel: 1)
                  : dbL
        _levelL = dbToLinear(dbL)
        _levelR = dbToLinear(dbR)
    }

    private func dbToLinear(_ db: Float) -> Float {
        // Floor at -45dB (typical ambient room noise).
        // Quadratic curve: makes soft sounds small, voice clearly visible.
        // -45dB → 0,  -22dB → 0.25,  -10dB → 0.6,  0dB → 1
        guard db > -45 else { return 0 }
        let n = (db + 45.0) / 45.0  // 0..1 linear
        return n * n                 // quadratic — compresses bottom, expands top
    }

    @available(iOS 14.0, *)
    private func configureStereoInput(session: AVAudioSession) throws {
        guard let inputPort  = session.currentRoute.inputs.first,
              let dataSources = inputPort.dataSources else { return }
        for ds in dataSources {
            if ds.supportedPolarPatterns?.contains(.stereo) == true {
                try ds.setPreferredPolarPattern(.stereo)
                try inputPort.setPreferredDataSource(ds)
                try session.setPreferredInputOrientation(.portrait)
                return
            }
        }
    }
}

// CLLocationManager delegate — handles permission + location callbacks
class LocationDelegate: NSObject, CLLocationManagerDelegate {
    var permissionCall: CAPPluginCall?
    var locationCall:   CAPPluginCall?

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        guard let call = permissionCall else { return }
        permissionCall = nil
        let granted = manager.authorizationStatus == .authorizedWhenInUse
                   || manager.authorizationStatus == .authorizedAlways
        call.resolve(["granted": granted])
    }

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let call = locationCall, let loc = locations.first else { return }
        locationCall = nil
        call.resolve([
            "latitude":  loc.coordinate.latitude,
            "longitude": loc.coordinate.longitude,
            "accuracy":  loc.horizontalAccuracy,
            "timestamp": loc.timestamp.timeIntervalSince1970 * 1000,
        ])
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        guard let call = locationCall else { return }
        locationCall = nil
        call.reject(error.localizedDescription)
    }
}
