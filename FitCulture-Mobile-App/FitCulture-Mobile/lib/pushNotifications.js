import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { supabase } from './supabase';

const CHANNEL_ID = 'fitculture-nudges';

export async function registerPushDevice() {
  if (Platform.OS !== 'android' && Platform.OS !== 'ios') {
    return { enabled: false, reason: 'Push notifications need the Android or iOS app.' };
  }

  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync(CHANNEL_ID, {
      name: 'FitCulture alerts',
      description: 'Activity, challenge, friend and motivation alerts',
      importance: Notifications.AndroidImportance.DEFAULT,
      vibrationPattern: [0, 180, 120, 180],
      lightColor: '#AEEA6B'
    });
  }

  let permission = await Notifications.getPermissionsAsync();
  if (permission.status !== 'granted') permission = await Notifications.requestPermissionsAsync();
  if (permission.status !== 'granted') return { enabled: false, reason: 'Allow notifications in your phone settings.' };

  const projectId = process.env.EXPO_PUBLIC_EAS_PROJECT_ID || '62f7de49-6d98-4a9b-b945-9aab03f20b59';
  const tokenResult = await Notifications.getExpoPushTokenAsync({ projectId });
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) throw userError || new Error('Sign in to enable push alerts.');

  const { error } = await supabase.from('push_devices').upsert({
    user_id: user.id,
    expo_push_token: tokenResult.data,
    platform: Platform.OS,
    updated_at: new Date().toISOString()
  }, { onConflict: 'user_id,expo_push_token' });
  if (error) throw error;
  return { enabled: true, token: tokenResult.data };
}

export async function unregisterPushDevice() {
  if (Platform.OS === 'web') return;
  const { data: { user } = {} } = await supabase.auth.getUser();
  if (!user) return;
  const { error } = await supabase.from('push_devices').delete().eq('user_id', user.id);
  if (error) throw error;
}

export async function sendFitCulturePush(event, eventId, metadata = {}) {
  try {
    const { error } = await supabase.functions.invoke('push-notifications', {
      body: { event, eventId, ...metadata }
    });
    if (error) console.warn('Push notification could not be sent:', error.message);
  } catch (error) {
    console.warn('Push notification could not be sent:', error?.message || error);
  }
}
