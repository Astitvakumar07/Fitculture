# FitCulture Mobile

React Native / Expo mobile app with Supabase-ready auth, data sync, activity tracking, leaderboards, rewards and AI Coach Mira.

## Fastest run path

1. Install Node.js LTS and Expo Go on an Android phone.
2. In this folder run `npm install`, then `npx expo start`.
3. Scan the Expo QR code from Expo Go.
4. Copy `.env.example` to `.env` and add your Supabase URL and publishable key.
5. In Supabase Dashboard -> SQL Editor, run `supabase/migrations/001_fitculture.sql`.
6. In Supabase Dashboard -> Edge Functions, deploy `supabase/functions/ai-coach/index.ts` and add `OPENAI_API_KEY` as a secret.

## Important platform behaviour

- Steps: uses the Android/iOS hardware pedometer while the app is open.
- Running and cycling: uses phone GPS while the session is running.
- Yoga and strength: use the session timer; Yoga leaderboards should rank by `duration_seconds`.
- Background GPS requires a development build or release build; it cannot be fully tested in Expo Go.
- Do not put the OpenAI API key or Supabase service-role key in `.env` or the mobile source code.

## Build an Android APK

For testing on your own phone, Expo Go is quickest. For native background location, install EAS CLI, log in to Expo, then use an Android development build:

```bash
npx expo install expo-dev-client
npx eas-cli build --platform android --profile development
```

Replace `com.yourname.fitculture` in `app.json` with your own unique Android package id before building.
