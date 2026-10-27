import UIKit
import Capacitor

// Required by newer iOS/SDK combinations that now hard-crash at launch
// without a declared UIScene lifecycle ("UIScene life cycle is required for
// apps built with this SDK"). This app has no custom window/rootViewController
// setup to migrate — it has always booted straight from Main.storyboard via
// Info.plist's UIMainStoryboardFile key, with zero code in AppDelegate. The
// scene manifest (UIApplicationSceneManifest in Info.plist) declares
// UISceneStoryboardFile = Main, so UIKit reproduces that exact same
// storyboard-driven boot through the scene lifecycle — no manual window or
// rootViewController wiring needed here.
class SceneDelegate: UIResponder, UIWindowSceneDelegate {

    var window: UIWindow?

    func sceneDidDisconnect(_ scene: UIScene) {}
    func sceneDidBecomeActive(_ scene: UIScene) {}
    func sceneWillResignActive(_ scene: UIScene) {}
    func sceneWillEnterForeground(_ scene: UIScene) {}
    func sceneDidEnterBackground(_ scene: UIScene) {}

    // Once a scene exists, iOS stops delivering custom-URL-scheme opens and
    // Universal Links to AppDelegate's application(_:open:options:) /
    // application(_:continue:restorationHandler:) and routes them here
    // instead — forwarding both is required for both to keep working at all.
    // Without this, the OAuth sign-in redirect (eigenvertex-recorder://
    // oauth/callback) lands on the device with nothing listening for it: the
    // web login page finishes and redirects, but the app never receives the
    // callback, leaving sign-in stuck forever on "Signing in…".
    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        guard let context = URLContexts.first else { return }
        let options: [UIApplication.OpenURLOptionsKey: Any] = [
            .sourceApplication: context.options.sourceApplication as Any,
            .annotation: context.options.annotation as Any,
            .openInPlace: context.options.openInPlace,
        ]
        _ = ApplicationDelegateProxy.shared.application(UIApplication.shared, open: context.url, options: options)
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        _ = ApplicationDelegateProxy.shared.application(UIApplication.shared, continue: userActivity, restorationHandler: { _ in })
    }
}
