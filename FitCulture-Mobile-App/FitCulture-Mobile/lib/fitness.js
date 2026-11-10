import { Pedometer } from 'expo-sensors';
import * as Location from 'expo-location';

const radians = value => (value * Math.PI) / 180;

export function distanceKm(a, b) {
  if (!a || !b || typeof a.latitude !== 'number' || typeof b.latitude !== 'number') return 0;
  const earth = 6371;
  const dLat = radians(b.latitude - a.latitude);
  const dLon = radians(b.longitude - a.longitude);
  const x =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(radians(a.latitude)) * Math.cos(radians(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return earth * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

export async function startStepTracking(onSteps) {
  const isAvailable = await Pedometer.isAvailableAsync().catch(() => false);
  if (!isAvailable) throw new Error('Step sensor is unavailable on this device.');
  return Pedometer.watchStepCount(({ steps }) => onSteps(steps));
}

export async function startGpsTracking(onPoint) {
  const { status } = await Location.requestForegroundPermissionsAsync().catch(() => ({ status: 'denied' }));
  if (status !== 'granted') throw new Error('Location permission is needed for running and cycling.');
  return Location.watchPositionAsync(
    { accuracy: Location.Accuracy.High, distanceInterval: 5, timeInterval: 3000 },
    location => {
      if (location?.coords) {
        onPoint({ ...location.coords, timestamp: location.timestamp || Date.now() });
      }
    }
  );
}
