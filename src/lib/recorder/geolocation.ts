// Geolocation abstraction.
// - Native (Capacitor): uses @capacitor/geolocation → proper iOS permission prompt
// - Web: uses navigator.geolocation

import { isNative } from '$lib/platform';
import { EigenAudio } from '$lib/plugins/eigenAudio';

export interface GeoPosition {
  latitude: number;
  longitude: number;
  accuracy: number;
  timestamp: number;
}

export interface GeolocationResult {
  position: GeoPosition | null;
  error: string | null;
}

export async function getCurrentPosition(): Promise<GeolocationResult> {
  if (isNative()) {
    return getNativePosition();
  }
  return getWebPosition();
}

async function getNativePosition(): Promise<GeolocationResult> {
  try {
    // Request permission via EigenAudioPlugin (uses CLLocationManager — proper "While Using" dialog)
    const perm = await EigenAudio.requestLocationPermission();
    if (!perm.granted) {
      return { position: null, error: 'Location permission denied' };
    }
    const loc = await EigenAudio.getLocation();
    return {
      position: { latitude: loc.latitude, longitude: loc.longitude, accuracy: loc.accuracy, timestamp: loc.timestamp },
      error: null,
    };
  } catch (err) {
    return { position: null, error: err instanceof Error ? err.message : String(err) };
  }
}

function getWebPosition(): Promise<GeolocationResult> {
  if (typeof navigator === 'undefined' || !navigator.geolocation) {
    return Promise.resolve({ position: null, error: 'Geolocation not supported' });
  }
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({
        position: {
          latitude:  pos.coords.latitude,
          longitude: pos.coords.longitude,
          accuracy:  pos.coords.accuracy,
          timestamp: pos.timestamp,
        },
        error: null,
      }),
      (err) => resolve({ position: null, error: err.message }),
      { enableHighAccuracy: false, timeout: 14000, maximumAge: 300000 }
    );
  });
}

export function formatCoords(pos: GeoPosition): string {
  return `${pos.latitude.toFixed(5)}, ${pos.longitude.toFixed(5)}`;
}
