import 'react-native-url-polyfill/auto';
import { createClient } from '@supabase/supabase-js';
import AsyncStorage from '@react-native-async-storage/async-storage';

const url = process.env.EXPO_PUBLIC_SUPABASE_URL || '';
const key = process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY || '';

if (!url || !key) {
  console.warn('FitCulture: Missing EXPO_PUBLIC_SUPABASE_URL or EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY. Running in demo mode.');
}

const isBrowser = typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';

export const supabase = createClient(
  url || 'https://nnnjsvojcntysozzbcrz.supabase.co',
  key || 'sb_publishable_ea74LL04jrvRociUDYr1Dg_NF6xQgXl',
  {
    auth: {
      persistSession: true,
      storage: isBrowser ? window.localStorage : AsyncStorage,
      autoRefreshToken: true,
      detectSessionInUrl: false
    }
  }
);
