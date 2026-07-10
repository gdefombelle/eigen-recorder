// Geolocation abstraction.
// - Native (Capacitor iOS): uses @capacitor/geolocation — CLLocationManager with proper
//   "When In Use" dialog. Requires NSLocationWhenInUseUsageDescription in Info.plist.
// - Web / PWA: uses navigator.geolocation directly.

import { isNative } from '$lib/platform';
import { Geolocation } from '@capacitor/geolocation';

export interface GeoPosition {
  latitude:  number;
  longitude: number;
  accuracy:  number;
  timestamp: number;
}

export interface GeolocationResult {
  position: GeoPosition | null;
  error:    string | null;
}

export async function getCurrentPosition(): Promise<GeolocationResult> {
  if (isNative()) {
    return getNativePosition();
  }
  return getWebPosition();
}

async function getNativePosition(): Promise<GeolocationResult> {
  try {
    const perm = await Geolocation.requestPermissions();
    if (perm.location !== 'granted' && perm.coarseLocation !== 'granted') {
      return { position: null, error: 'Location permission denied' };
    }
    const pos = await Geolocation.getCurrentPosition({
      enableHighAccuracy: false,
      timeout: 10000,
      maximumAge: 300_000,
    });
    return {
      position: {
        latitude:  pos.coords.latitude,
        longitude: pos.coords.longitude,
        accuracy:  pos.coords.accuracy,
        timestamp: pos.timestamp,
      },
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
      { enableHighAccuracy: false, timeout: 14000, maximumAge: 300_000 },
    );
  });
}

export function formatCoords(pos: GeoPosition): string {
  return `${pos.latitude.toFixed(5)}, ${pos.longitude.toFixed(5)}`;
}
