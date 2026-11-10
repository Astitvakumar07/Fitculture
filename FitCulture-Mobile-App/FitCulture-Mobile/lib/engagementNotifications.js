import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { registerPushDevice, unregisterPushDevice } from './pushNotifications';

const PREFS_KEY = 'fitculture_notification_preferences_v1';
const CHANNEL_ID = 'fitculture-nudges';

export const defaultNotificationPreferences = {
  workout: false,
  quote: false,
  water: false,
  push: false,
  workoutTime: '18:30',
  quoteTime: '08:30',
  waterTime: '13:00'
};

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldPlaySound: true,
    shouldSetBadge: false,
    shouldShowBanner: true,
    shouldShowList: true
  })
});

const quotes = [
  'A small walk still counts. Show up for the version of you that started.',
  'You do not need a perfect week. One good choice is a strong restart.',
  'Build the habit first. The pace and progress can follow.',
  'Rest is part of training. Your effort today can be gentle.',
  'Make movement fit your day, not the other way around.',
  'Your next step does not need to be big. It just needs to be yours.',
  'Consistency is returning to your goal, one ordinary day at a time.'
];

function timeParts(value, fallback) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value || '');
  if (!match) return fallback;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return fallback;
  return { hour, minute };
}

async function prepareChannel() {
  if (Platform.OS !== 'android') return;
  await Notifications.setNotificationChannelAsync(CHANNEL_ID, {
    name: 'FitCulture reminders',
    description: 'Workout nudges, hydration reminders and daily motivation',
    importance: Notifications.AndroidImportance.DEFAULT,
    vibrationPattern: [0, 180, 120, 180],
    lightColor: '#AEEA6B'
  });
}

export async function getNotificationPreferences() {
  try {
    const raw = await AsyncStorage.getItem(PREFS_KEY);
    return { ...defaultNotificationPreferences, ...(raw ? JSON.parse(raw) : {}) };
  } catch {
    return { ...defaultNotificationPreferences };
  }
}

async function clearFitCultureSchedules() {
  const scheduled = await Notifications.getAllScheduledNotificationsAsync();
  await Promise.all(scheduled
    .filter(item => item.content.data?.fitculture === true)
    .map(item => Notifications.cancelScheduledNotificationAsync(item.identifier)));
}

async function scheduleEnabled(preferences, profile) {
  await prepareChannel();
  await clearFitCultureSchedules();
  const firstName = profile?.full_name?.trim()?.split(/\s+/)[0] || 'Athlete';
  const goal = profile?.goal || 'general_fitness';
  const goalNudge = goal === 'weight_loss'
    ? 'A comfortable walk is a great way to keep your routine moving.'
    : goal === 'weight_gain'
      ? 'Your strength routine is built one steady session at a time.'
      : goal === 'maintain_weight'
        ? 'A little movement today can help keep your healthy rhythm going.'
        : 'Try a few minutes of movement today and build from there.';
  const common = { data: { fitculture: true } };

  if (preferences.workout) {
    const { hour, minute } = timeParts(preferences.workoutTime, { hour: 18, minute: 30 });
    await Notifications.scheduleNotificationAsync({
      content: {
        ...common,
        title: `Your movement moment, ${firstName} 👟`,
        body: goalNudge
      },
      trigger: { type: Notifications.SchedulableTriggerInputTypes.DAILY, hour, minute, channelId: CHANNEL_ID }
    });
  }

  if (preferences.water) {
    const { hour, minute } = timeParts(preferences.waterTime, { hour: 13, minute: 0 });
    await Notifications.scheduleNotificationAsync({
      content: { ...common, title: 'A little reset 💧', body: 'Take a pause, sip some water if you need it, and check in with how you feel.' },
      trigger: { type: Notifications.SchedulableTriggerInputTypes.DAILY, hour, minute, channelId: CHANNEL_ID }
    });
  }

  if (preferences.quote) {
    const { hour, minute } = timeParts(preferences.quoteTime, { hour: 8, minute: 30 });
    for (let weekday = 1; weekday <= 7; weekday += 1) {
      await Notifications.scheduleNotificationAsync({
        content: { ...common, title: `A little FitCulture thought, ${firstName} ✨`, body: quotes[weekday - 1] },
        trigger: { type: Notifications.SchedulableTriggerInputTypes.WEEKLY, weekday, hour, minute, channelId: CHANNEL_ID }
      });
    }
  }
}

export async function saveNotificationPreferences(preferences, profile) {
  const merged = { ...defaultNotificationPreferences, ...preferences };
  await AsyncStorage.setItem(PREFS_KEY, JSON.stringify(merged));
  if (!merged.push) await unregisterPushDevice();
  const hasLocalReminders = merged.workout || merged.quote || merged.water;
  if (!hasLocalReminders) await clearFitCultureSchedules();

  if (!hasLocalReminders && !merged.push) {
    await unregisterPushDevice();
    return { granted: false, disabled: true, pushEnabled: false };
  }

  await prepareChannel();
  const current = await Notifications.getPermissionsAsync();
  const result = current.status === 'granted' ? current : await Notifications.requestPermissionsAsync();
  if (result.status !== 'granted') {
    await clearFitCultureSchedules();
    return { granted: false, disabled: false, pushEnabled: false };
  }

  if (hasLocalReminders) await scheduleEnabled(merged, profile);
  let pushEnabled = false;
  if (merged.push) {
    const registration = await registerPushDevice();
    pushEnabled = registration.enabled;
    if (!pushEnabled) {
      merged.push = false;
      await AsyncStorage.setItem(PREFS_KEY, JSON.stringify(merged));
    }
  }
  return { granted: true, disabled: false, pushEnabled };
}

export async function getNotificationPermissionStatus() {
  if (Platform.OS === 'web') return 'unavailable';
  try {
    await prepareChannel();
    return (await Notifications.getPermissionsAsync()).status;
  } catch {
    return 'unavailable';
  }
}
