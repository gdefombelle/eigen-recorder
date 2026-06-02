// i18n — Svelte 4 writable store. fr/en. Recorder-specific strings + auth from scanner-app.

import { writable, get } from 'svelte/store';

export type Lang = 'fr' | 'en';
const LANG_KEY = 'ev_lang';

const translations = {
  fr: {
    auth: {
      pageTitle:         'Mon compte',
      loginTab:          'Connexion',
      registerTab:       'Créer un compte',
      email:             'Email',
      password:          'Mot de passe',
      loginBtn:          'Se connecter',
      registerBtn:       'Créer un compte',
      or:                'ou',
      googleBtn:         'Continuer avec Google',
      appleBtn:          'Continuer avec Apple',
      forgotPassword:    'Mot de passe oublié ?',
      loggedInAs:        (email: string) => `Connecté : ${email}`,
      logout:            'Déconnecter',
      loginLink:         'Déjà un compte ? Connexion',
      registerLink:      "Pas encore de compte ? Créer un compte",
      errorNetwork:      "Serveur inaccessible. Vérifiez l'URL dans les paramètres.",
      errorCredentials:  'Email ou mot de passe incorrect.',
      errorEmailTaken:   'Cet email est déjà utilisé.',
      successRegister:   'Compte créé ! Connexion en cours…',
      forgotTitle:       'Mot de passe oublié',
      forgotDesc:        'Entrez votre adresse email. Si un compte existe, vous recevrez un lien de réinitialisation.',
      forgotSubmit:      'Envoyer le lien',
      forgotSuccess:     'Si cet email est associé à un compte, vous recevrez un lien dans quelques instants.',
      forgotNotAvailable:"Cette fonctionnalité n'est pas encore disponible.",
      backToLogin:       '← Retour à la connexion',
      resetTitle:        'Nouveau mot de passe',
      resetDesc:         'Choisissez un mot de passe sécurisé.',
      newPassword:       'Nouveau mot de passe',
      resetSubmit:       'Réinitialiser',
      resetSuccess:      'Mot de passe modifié. Connexion en cours…',
      resetInvalidToken: 'Lien invalide ou expiré. Recommencez depuis "Mot de passe oublié".',
      callbackLoading:   'Connexion en cours…',
      callbackError:     'Erreur de connexion. Redirection…',
      signInToSync:      'Se connecter pour synchroniser',
      signInHint:        'L\'enregistrement est local. Connectez-vous pour synchroniser avec EigenVertex.',
    },
    settings: {
      pageTitle:          'Paramètres',
      accountSection:     'Mon compte',
      serverSection:      'Serveur EigenVertex',
      serverUrlLabel:     'URL du serveur',
      serverUrlHelp:      "Pour une installation on-premises, modifiez cette URL. En mode cloud, laissez la valeur par défaut.",
      proxyModeLabel:     'Mode proxy Vite (dev)',
      proxyModeHelp:      (target: string) => `Les requêtes API passent par le proxy Vite vers ${target}.`,
      currentOverride:    (url: string) => `URL active : ${url}`,
      defaultLabel:       (url: string) => `Défaut : ${url}`,
      urlPlaceholder:     'https://api.eigenvertex.com',
      save:               'Enregistrer',
      saved:              'Enregistré ✓',
      resetSection:       'Réinitialisation',
      resetBtn:           'Remettre les valeurs par défaut',
      resetHelp:          "Rétablit l'URL du serveur et les préférences.",
      errorEmpty:         "L'URL ne peut pas être vide.",
      errorInvalid:       'URL invalide. Exemple : https://api.eigenvertex.com',
      recordingSection:   'Enregistrement',
      chunkDuration:      'Durée des chunks',
      chunkDurationHelp:  'Chaque chunk est sauvegardé immédiatement. Plus court = plus résilient.',
      storageSection:     'Stockage local',
      storageSummary:     (n: number, size: string) => `${n} session${n > 1 ? 's' : ''} · ${size} dans IndexedDB`,
      clearAll:           'Tout effacer',
      clearAllConfirm:    'Supprimer toutes les sessions et enregistrements ? Irréversible.',
      clearing:           'Suppression…',
      cleared:            'Effacé ✓',
      diagnosticsSection: 'Diagnostics',
      langSection:        'Langue',
      langFr:             'Français',
      langEn:             'English',
      deleteAccountBtn:   'Supprimer mon compte',
      deleteAccountConfirm:'Vous serez redirigé vers la page de suppression de compte EigenVertex. Continuer ?',
      iosSection:         'iOS / Safari',
    },
    recorder: {
      newSession:        'Nouvelle session',
      joinSession:       'Rejoindre',
      recentSessions:    'Sessions récentes',
      seeAll:            'Voir tout →',
      sessions:          'Sessions',
      offlineFirst:      'Enregistreur audio offline-first pour Eigen Meeting',
    },
    common: {
      online:            'En ligne',
      offline:           'Hors ligne',
      cancel:            'Annuler',
      back:              '←',
      delete:            'Supprimer',
      share:             'Partager',
      export:            'Exporter',
    },
  },
  en: {
    auth: {
      pageTitle:         'My account',
      loginTab:          'Log in',
      registerTab:       'Sign up',
      email:             'Email',
      password:          'Password',
      loginBtn:          'Log in',
      registerBtn:       'Create account',
      or:                'or',
      googleBtn:         'Continue with Google',
      appleBtn:          'Continue with Apple',
      forgotPassword:    'Forgot password?',
      loggedInAs:        (email: string) => `Signed in: ${email}`,
      logout:            'Sign out',
      loginLink:         'Already have an account? Log in',
      registerLink:      "No account yet? Sign up",
      errorNetwork:      'Server unreachable. Check the URL in Settings.',
      errorCredentials:  'Incorrect email or password.',
      errorEmailTaken:   'This email is already registered.',
      successRegister:   'Account created! Signing in…',
      forgotTitle:       'Forgot password',
      forgotDesc:        'Enter your email. If an account exists, you will receive a reset link.',
      forgotSubmit:      'Send reset link',
      forgotSuccess:     'If this email is registered, a reset link is on its way.',
      forgotNotAvailable:'This feature is not yet available.',
      backToLogin:       '← Back to sign in',
      resetTitle:        'New password',
      resetDesc:         'Choose a secure password.',
      newPassword:       'New password',
      resetSubmit:       'Reset password',
      resetSuccess:      'Password updated. Signing in…',
      resetInvalidToken: 'Invalid or expired link. Please restart from "Forgot password".',
      callbackLoading:   'Signing in…',
      callbackError:     'Sign-in error. Redirecting…',
      signInToSync:      'Sign in to sync',
      signInHint:        'Recording is saved locally. Sign in to sync with EigenVertex.',
    },
    settings: {
      pageTitle:          'Settings',
      accountSection:     'My account',
      serverSection:      'EigenVertex server',
      serverUrlLabel:     'Server URL',
      serverUrlHelp:      'For on-premises deployments, change this URL. For cloud, keep the default.',
      proxyModeLabel:     'Vite proxy mode (dev)',
      proxyModeHelp:      (target: string) => `API requests are proxied through Vite to ${target}.`,
      currentOverride:    (url: string) => `Active URL: ${url}`,
      defaultLabel:       (url: string) => `Default: ${url}`,
      urlPlaceholder:     'https://api.eigenvertex.com',
      save:               'Save',
      saved:              'Saved ✓',
      resetSection:       'Reset',
      resetBtn:           'Restore defaults',
      resetHelp:          'Resets the server URL and all preferences.',
      errorEmpty:         'URL cannot be empty.',
      errorInvalid:       'Invalid URL. Example: https://api.eigenvertex.com',
      recordingSection:   'Recording',
      chunkDuration:      'Chunk duration',
      chunkDurationHelp:  'Each chunk is saved immediately. Shorter = more crash-resilient.',
      storageSection:     'Local storage',
      storageSummary:     (n: number, size: string) => `${n} session${n > 1 ? 's' : ''} · ${size} in IndexedDB`,
      clearAll:           'Clear all',
      clearAllConfirm:    'Delete all sessions and recordings? This cannot be undone.',
      clearing:           'Clearing…',
      cleared:            'Cleared ✓',
      diagnosticsSection: 'Diagnostics',
      langSection:        'Language',
      langFr:             'Français',
      langEn:             'English',
      deleteAccountBtn:   'Delete my account',
      deleteAccountConfirm:'You will be redirected to the EigenVertex account deletion page. Continue?',
      iosSection:         'iOS / Safari',
    },
    recorder: {
      newSession:        'New session',
      joinSession:       'Join',
      recentSessions:    'Recent sessions',
      seeAll:            'See all →',
      sessions:          'Sessions',
      offlineFirst:      'Offline-first audio recorder for Eigen Meeting',
    },
    common: {
      online:            'Online',
      offline:           'Offline',
      cancel:            'Cancel',
      back:              '←',
      delete:            'Delete',
      share:             'Share',
      export:            'Export',
    },
  },
} as const;

const _lang = writable<Lang>('en');

export const langStore = { subscribe: _lang.subscribe };

export function getLang(): Lang { return get(_lang); }

export function t(): (typeof translations)['en'] {
  return translations[get(_lang)] as (typeof translations)['en'];
}

export function setLang(lang: Lang): void {
  _lang.set(lang);
  try { localStorage.setItem(LANG_KEY, lang); } catch { /* ignore */ }
}

export function loadLang(): void {
  try {
    const stored = localStorage.getItem(LANG_KEY);
    if (stored === 'fr' || stored === 'en') {
      _lang.set(stored);
      return;
    }
    // Auto-detect from browser
    const detected: Lang = (typeof navigator !== 'undefined' && navigator.language.startsWith('fr')) ? 'fr' : 'en';
    _lang.set(detected);
  } catch { /* ignore */ }
}
