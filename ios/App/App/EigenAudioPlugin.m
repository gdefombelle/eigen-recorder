#import <Foundation/Foundation.h>
#import <Capacitor/Capacitor.h>

// Registers EigenAudioPlugin with Capacitor's Objective-C bridge.
// Required for local plugins added directly to the Xcode app target
// (as opposed to SPM packages which use CAPBridgedPlugin auto-discovery).
CAP_PLUGIN(EigenAudioPlugin, "EigenAudioPlugin",
    CAP_PLUGIN_METHOD(requestLocationPermission, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(getLocation,               CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(requestPermission, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(startRecording,    CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(pauseRecording,    CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(resumeRecording,   CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(stopRecording,     CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(getElapsedMs,      CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(getMicLevel,       CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(mergeChunks,       CAPPluginReturnPromise);
)
