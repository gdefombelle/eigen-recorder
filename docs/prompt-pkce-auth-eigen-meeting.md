# Prompt — Authentification PKCE pour Eigen Meeting (mobile)

Contexte pour l'agent Claude Code travaillant dans le repo `eigen-recorder`
(app Capacitor iOS/Android « Eigen Meeting »).

## Existant (à remplacer)

L'app s'authentifie aujourd'hui en email/password direct :
- `src/lib/auth/api.ts` : `apiLogin`/`apiRegister` appellent
  `POST /auth/login` / `POST /auth/register` et reçoivent un token brut ;
  `getGoogleLoginUrl`/`getAppleLoginUrl` construisent une redirection web
  simple (pas de PKCE, pas de `oauth_client_id`) ; `apiAppleNativeLogin`
  appelle `/auth/apple/native` (Sign in with Apple natif iOS).
- `src/lib/auth/auth.ts` : store Svelte `authStore`, token + décodage JWT
  côté client, persisté en clair dans `localStorage` (`ev_token`).

On migre vers le flow OAuth 2.1 authorization-code + PKCE déjà utilisé par
l'app desktop Eigen Companion, pour unifier email/password + Google + Apple
derrière un seul mécanisme (`/v1/auth/authorize` → navigateur système →
retour dans l'app → `/v1/auth/token`).

## Contrat backend (déjà en place côté `eigenvertex`)

- `GET /v1/auth/authorize?client_id=eigenvertex-recorder&redirect_uri=...&response_type=code&code_challenge=...&code_challenge_method=S256&state=...&scope=...`
  → si non connecté, redirige vers la page de login `/auth` (hébergée par
  `eigenvertex-app`, contrat documenté dans
  `eigenvertex/docs/oauth-companion-frontend-contract.md` — email/password
  ET boutons Google/Apple y sont déjà gérés, l'app n'a pas à réimplémenter ce
  formulaire) ; après login, redirige vers `redirect_uri?code=...&state=...`.
- `POST /v1/auth/token` — body
  `{grant_type:'authorization_code', client_id, code, code_verifier, redirect_uri}`
  → `{access_token, refresh_token, expires_in, token_type, rotation_family_id}`.
  Supporte aussi `{grant_type:'refresh_token', client_id, refresh_token}`.
- `POST /v1/auth/oauth/revoke` — body `{rotation_family_id}`, à appeler au
  logout.
- `GET /auth/me` — existe déjà (`apiMe` dans `api.ts`), à préférer au décodage
  JWT côté client pour le profil utilisateur affiché.
- `client_id` prévu pour cette app : `eigenvertex-recorder`. Le
  `redirect_uri` sera un custom scheme (pas de loopback, contrairement à
  l'app desktop) — une migration backend correspondante est en cours côté
  `eigenvertex` (agent séparé). **Coordonner la valeur exacte du scheme avec
  ce travail avant de merger** : elle doit matcher au caractère près des deux
  côtés (proposition de départ : `eigenvertex-recorder://oauth/callback`).

## Ce qu'il faut construire

1. **Helpers PKCE** : générer un `code_verifier` aléatoire cryptographique
   (43–128 caractères, charset unreserved RFC 3986) et son
   `code_challenge = base64url(sha256(code_verifier))` via Web Crypto
   (`crypto.subtle.digest`, dispo dans la WebView Capacitor — pas de nouvelle
   dépendance nécessaire). Générer un `state` aléatoire de la même façon.
2. **Deep link custom scheme dédié.** Ne pas réutiliser tel quel le
   `ios.scheme: 'eigenvertex-recorder'` déjà présent dans
   `capacitor.config.ts` sans vérifier : ce paramètre contrôle le scheme
   interne servant le contenu de la WebView (`eigenvertex-recorder://...`
   pour le contenu local), ce n'est pas la même chose qu'un scheme
   enregistré au niveau OS pour recevoir un deep link externe. Enregistrer
   proprement le callback OAuth :
   - iOS : `CFBundleURLTypes`/`CFBundleURLSchemes` dans
     `ios/App/App/Info.plist` (le projet `ios/` existe déjà).
   - Android : `<intent-filter>` avec
     `<data android:scheme="eigenvertex-recorder" android:host="oauth" android:path="/callback"/>`
     dans `android/app/src/main/AndroidManifest.xml` — la plateforme Android
     n'était pas encore initialisée lors d'une vérification rapide ; lancer
     `npx cap add android` si besoin avant.
   Si réutiliser le même scheme que `ios.scheme` fonctionne proprement une
   fois testé, tant mieux — sinon utiliser un scheme distinct.
3. **Lancement du flow** : `@capacitor/browser` → `Browser.open()` pour
   ouvrir le navigateur système sur l'URL `/v1/auth/authorize` (pas une
   WebView embarquée — requis pour que PKCE ait un sens sécuritaire).
   Écouter le retour via `@capacitor/app` → `App.addListener('appUrlOpen', ...)`,
   parser `code`/`state` depuis l'URL reçue, vérifier que `state` correspond
   à celui généré à l'étape 1, puis `Browser.close()`.
4. **Échange du code + stockage** : `POST /v1/auth/token` avec le
   `code_verifier` conservé en mémoire depuis l'étape 1. Ne pas stocker le
   `refresh_token` en `localStorage` en clair comme c'est fait aujourd'hui
   pour le token simple — utiliser un plugin de stockage sécurisé (ex.
   `capacitor-secure-storage-plugin` ou `@aparajita/capacitor-secure-storage`,
   adossé au Keychain iOS / EncryptedSharedPreferences+Keystore Android) au
   minimum pour le `refresh_token`.
5. **Refresh silencieux** : avant expiration de l'access token (ou sur un
   401), appeler `/v1/auth/token` avec `grant_type=refresh_token` ; en cas
   d'échec, nettoyer le storage et rebasculer vers l'écran de login.
6. **Logout** : appeler `POST /v1/auth/oauth/revoke` avec le
   `rotation_family_id` stocké, puis vider le storage local.
7. **UI** : remplacer le formulaire email/password direct et les boutons
   Google/Apple actuels par une seule action « Se connecter » qui déclenche
   le flow ci-dessus (`client_id` fixé à `eigenvertex-recorder`) — la page
   `/auth` côté serveur gère déjà le formulaire et les boutons sociaux, Eigen
   Meeting n'a qu'à démarrer `/v1/auth/authorize` et gérer le retour. Retirer
   (ou garder temporairement en fallback) `apiLogin`, `apiRegister`,
   `getGoogleLoginUrl`, `getAppleLoginUrl`, `apiAppleNativeLogin` une fois le
   flow PKCE validé de bout en bout sur device réel.
8. **`src/lib/auth/auth.ts`** : adapter `EVUser`/le store — décider si on
   garde le décodage JWT côté client pour l'identité affichée ou si on
   appelle `/auth/me` après l'échange (plus robuste, évite de dépendre du
   contenu du JWT).
9. Confirmer avec l'agent qui modifie le backend (`eigenvertex`) la valeur
   exacte du `redirect_uri` enregistré avant de merger — elle doit matcher
   au caractère près.

## Tests

Vérification manuelle de bout en bout sur device réel ou simulateur, iOS ET
Android (les redirections navigateur système ne fonctionnent pas correctement
en preview `npm run dev` navigateur classique) — préciser dans la PR quelles
plateformes ont été testées.
