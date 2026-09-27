import Foundation
import AVFoundation
import CoreLocation
import Speech
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
        CAPPluginMethod(name: "setKeepAwake",              returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestPermission", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "startRecording",    returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pauseRecording",    returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "resumeRecording",   returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopRecording",     returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getElapsedMs",      returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getMicLevel",       returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "mergeChunks",       returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "keychainGet",    returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "keychainSet",    returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "keychainRemove", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "dictationPermission", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "startDictation",      returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopDictation",       returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancelDictation",     returnType: CAPPluginReturnPromise),
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
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
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
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
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

    // ── Screen keep-awake (fallback for iOS < 16.4 where Wake Lock API is unavailable) ──

    @objc func setKeepAwake(_ call: CAPPluginCall) {
        let enabled = call.getBool("enabled") ?? false
        DispatchQueue.main.async {
            UIApplication.shared.isIdleTimerDisabled = enabled
        }
        call.resolve()
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
        let sr     = Double(call.getInt("sampleRate") ?? 48_000)

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
            AVSampleRateKey:          sr,
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

        // Stop BEFORE reading — AVAudioRecorder writes the MOOV atom on stop().
        // Reading before stop() gives incomplete M4A that browsers can't play.
        recorder?.stop()
        finaliseCurrentChunk()
        recorder = nil

        // Switch to playback so WKWebView can play audio after recording ends.
        // Without this the .record category blocks HTML5 audio output.
        let audioSession = AVAudioSession.sharedInstance()
        try? audioSession.setCategory(.playback, mode: .default, options: [])
        try? audioSession.setActive(true)

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
        // Stop BEFORE reading — ensures MOOV atom is written to disk first.
        recorder?.stop()
        finaliseCurrentChunk()
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

    // ── Keychain ───────────────────────────────────────────────────────────
    //
    // Direct Security-framework access, replacing capacitor-secure-storage-plugin:
    // on device, its bridge call never returned (Settings › Diagnostics reported
    // "Keychain read exceeded 5000ms"), which stalled every token refresh at its
    // very first step and left sessions dying silently after 15 minutes.
    //
    // This plugin is compiled straight into the App target — the same path the
    // audio and dictation methods already use in production — so it does not
    // depend on SPM plugin discovery.
    //
    // kSecAttrAccessibleAfterFirstUnlock matches the accessibility the previous
    // plugin used, so a background refresh still works on a locked device.

    private let keychainService = "com.eigenvertex.recorder.secure"

    private func keychainQuery(_ key: String) -> [String: Any] {
        [
            kSecClass as String:       kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: key,
        ]
    }

    @objc func keychainGet(_ call: CAPPluginCall) {
        guard let key = call.getString("key") else {
            call.reject("key is required", "BAD_ARGS")
            return
        }
        var query = keychainQuery(key)
        query[kSecReturnData as String]  = true
        query[kSecMatchLimit as String]  = kSecMatchLimitOne

        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)

        if status == errSecSuccess,
           let data = item as? Data,
           let value = String(data: data, encoding: .utf8) {
            call.resolve(["value": value])
        } else if status == errSecItemNotFound {
            // Absence is a normal result, not a failure — resolve with null so
            // callers can branch on it instead of having to catch.
            call.resolve(["value": NSNull()])
        } else {
            call.reject("Keychain read failed", "OSStatus \(status)")
        }
    }

    @objc func keychainSet(_ call: CAPPluginCall) {
        guard let key = call.getString("key"), let value = call.getString("value") else {
            call.reject("key and value are required", "BAD_ARGS")
            return
        }
        guard let data = value.data(using: .utf8) else {
            call.reject("value is not valid UTF-8", "BAD_ARGS")
            return
        }

        // Delete-then-add: SecItemUpdate needs the item to exist, and an add
        // over an existing item returns errSecDuplicateItem.
        SecItemDelete(keychainQuery(key) as CFDictionary)

        var attrs = keychainQuery(key)
        attrs[kSecValueData as String]      = data
        attrs[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock

        let status = SecItemAdd(attrs as CFDictionary, nil)
        if status == errSecSuccess {
            call.resolve(["value": true])
        } else {
            call.reject("Keychain write failed", "OSStatus \(status)")
        }
    }

    @objc func keychainRemove(_ call: CAPPluginCall) {
        guard let key = call.getString("key") else {
            call.reject("key is required", "BAD_ARGS")
            return
        }
        let status = SecItemDelete(keychainQuery(key) as CFDictionary)
        if status == errSecSuccess || status == errSecItemNotFound {
            call.resolve(["value": true])
        } else {
            call.reject("Keychain delete failed", "OSStatus \(status)")
        }
    }

    // ── Dictation (SFSpeechRecognizer) ─────────────────────────────────────
    //
    // Speech-to-text for text composers. Deliberately refuses to run while a
    // capture is in flight so it can never disturb a recording, and restores
    // the audio session category on teardown.
    //
    // Streams to JS via events rather than the promise:
    //   dictationResult { text, isFinal } · dictationLevel { level } · dictationError { kind, message }

    private var speechRecognizer:   SFSpeechRecognizer?
    private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
    private var recognitionTask:    SFSpeechRecognitionTask?
    private var dictationEngine:    AVAudioEngine?
    private var dictationText:      String = ""

    private func authLabel(_ status: SFSpeechRecognizerAuthorizationStatus) -> String {
        switch status {
        case .authorized:    return "granted"
        case .denied:        return "denied"
        case .restricted:    return "restricted"
        case .notDetermined: return "prompt"
        @unknown default:    return "denied"
        }
    }

    /// Request speech + microphone authorization together and report each one,
    /// so the UI can tell "never asked" apart from "denied in Settings".
    @objc func dictationPermission(_ call: CAPPluginCall) {
        SFSpeechRecognizer.requestAuthorization { speechStatus in
            AVAudioSession.sharedInstance().requestRecordPermission { micGranted in
                call.resolve([
                    "granted":    speechStatus == .authorized && micGranted,
                    "speech":     self.authLabel(speechStatus),
                    "microphone": micGranted ? "granted" : "denied",
                ])
            }
        }
    }

    @objc func startDictation(_ call: CAPPluginCall) {
        // Never interfere with an active capture.
        if recorder?.isRecording == true || isPaused {
            call.reject("A recording is in progress.", "RECORDING_ACTIVE")
            return
        }

        let localeId = call.getString("locale") ?? "en-US"

        SFSpeechRecognizer.requestAuthorization { speechStatus in
            guard speechStatus == .authorized else {
                DispatchQueue.main.async {
                    call.reject("Speech recognition not authorized.", self.authLabel(speechStatus).uppercased())
                }
                return
            }
            AVAudioSession.sharedInstance().requestRecordPermission { micGranted in
                guard micGranted else {
                    DispatchQueue.main.async { call.reject("Microphone not authorized.", "DENIED") }
                    return
                }
                DispatchQueue.main.async { self.beginDictation(call, localeId: localeId) }
            }
        }
    }

    private func beginDictation(_ call: CAPPluginCall, localeId: String) {
        teardownDictation()
        dictationText = ""

        guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: localeId)),
              recognizer.isAvailable else {
            call.reject("Speech recognition unavailable for \(localeId).", "UNAVAILABLE")
            return
        }
        speechRecognizer = recognizer

        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        // On-device keeps audio off Apple's servers when the locale supports it.
        if #available(iOS 13.0, *), recognizer.supportsOnDeviceRecognition {
            request.requiresOnDeviceRecognition = true
        }
        recognitionRequest = request

        let engine = AVAudioEngine()
        dictationEngine = engine

        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.record, mode: .measurement, options: .duckOthers)
            try session.setActive(true, options: .notifyOthersOnDeactivation)
        } catch {
            call.reject("Could not start audio session: \(error.localizedDescription)", "AUDIO_SESSION")
            teardownDictation()
            return
        }

        let input  = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
            self?.recognitionRequest?.append(buffer)
            self?.emitLevel(from: buffer)
        }

        recognitionTask = recognizer.recognitionTask(with: request) { [weak self] result, error in
            guard let self = self else { return }
            if let result = result {
                self.dictationText = result.bestTranscription.formattedString
                self.notifyListeners("dictationResult", data: [
                    "text":    self.dictationText,
                    "isFinal": result.isFinal,
                ])
            }
            if error != nil || result?.isFinal == true {
                // A cancelled task reports an error too — only surface real failures.
                if error != nil && self.recognitionTask != nil && result == nil {
                    self.notifyListeners("dictationError", data: [
                        "kind":    "failed",
                        "message": "Dictation failed. Please try again.",
                    ])
                }
                self.teardownDictation()
            }
        }

        engine.prepare()
        do {
            try engine.start()
        } catch {
            call.reject("Could not start microphone: \(error.localizedDescription)", "AUDIO_ENGINE")
            teardownDictation()
            return
        }
        call.resolve(["started": true])
    }

    /// Mono peak amplitude 0..1, matching the web meter's math.
    private func emitLevel(from buffer: AVAudioPCMBuffer) {
        guard let channel = buffer.floatChannelData?[0] else { return }
        let count = Int(buffer.frameLength)
        var peak: Float = 0
        for i in 0..<count {
            let v = abs(channel[i])
            if v > peak { peak = v }
        }
        // ×4 boost so quiet speech is still visible, same as AudioRecorder.
        let level = min(1.0, peak * 4)
        notifyListeners("dictationLevel", data: ["level": level])
    }

    @objc func stopDictation(_ call: CAPPluginCall) {
        let text = dictationText
        teardownDictation()
        call.resolve(["text": text])
    }

    @objc func cancelDictation(_ call: CAPPluginCall) {
        dictationText = ""
        teardownDictation()
        call.resolve()
    }

    private func teardownDictation() {
        if let engine = dictationEngine {
            if engine.isRunning { engine.stop() }
            engine.inputNode.removeTap(onBus: 0)
        }
        dictationEngine = nil

        recognitionRequest?.endAudio()
        recognitionRequest = nil

        let task = recognitionTask
        recognitionTask = nil
        task?.cancel()

        speechRecognizer = nil
        notifyListeners("dictationLevel", data: ["level": 0])

        // Hand the audio session back so a later capture starts from a clean state.
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
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
