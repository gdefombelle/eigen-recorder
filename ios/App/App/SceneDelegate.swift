import UIKit

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
}
