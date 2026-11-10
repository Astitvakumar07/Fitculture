# FitCulture Mobile - two-day integration guide

## 1. Run the mobile app

Install Node.js LTS. Open a terminal inside `FitCulture-Mobile` and run:

```bash
npm install
npx expo start
```

For the basic UI demo, install Expo Go on Android and scan the QR code. Health Connect requires the development build described below; it does not run in Expo Go.

## 2. Connect Supabase

Create a project at Supabase. Open **SQL Editor**, paste and run `supabase/migrations/001_fitculture.sql`, then run `supabase/migrations/002_health_connect_sync.sql`, then `supabase/migrations/003_profiles_challenges_rewards.sql`. The third migration enables profile editing, weekly challenges and scoring, and real reward redemption. Then open **Project Settings -> API**. Set `EXPO_PUBLIC_SUPABASE_URL` and `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY` in `.env`. Never put a secret/service-role key in the mobile app.

Enable Email authentication in **Authentication -> Providers -> Email**. For a quick presentation demo, Email confirmation can be disabled temporarily. Turn it back on before any public release.

## 3. Add AI safely

For OpenAI, create an OpenAI API key and add it in Supabase **Edge Functions -> Secrets** as `OPENAI_API_KEY`. For Groq, add its key as `GROQ_API_KEY`; the default model is `openai/gpt-oss-20b`, or set `GROQ_MODEL` to another Responses-compatible Groq model. For OpenRouter, add `OPENROUTER_API_KEY` and optionally `OPENROUTER_MODEL`. When multiple keys exist, Groq is selected first, then OpenAI, then OpenRouter. Free-plan quotas and limits depend on provider/model. Never add provider keys to the Expo mobile app. Deploy `supabase/functions/ai-coach/index.ts` after updating it. The app calls that function through `supabase.functions.invoke`.

## 4. What works on the phone

Steps use the phone pedometer. Running/cycling use foreground GPS and calculate distance from location points. Swimming records the distance entered by the user; Yoga and Strength record session duration. Saved activities call `complete_activity`, write to Supabase, award XP/FitCoins and update joined challenge scores. The profile screen saves name, bio and location. Leaderboards show actual logged activity; the reward store debits FitCoins and records redemptions. The Health Connect sync imports daily steps and recent supported workouts; completed FitCulture sessions can also be written to Health Connect when the user grants permission.

## 5. Needs a native development build

Health Connect and background running/cycling tracking need a development or release build, not Expo Go. The Health Connect native package and Android permissions are configured in `app.json`. Install EAS CLI and sign in to your Expo account, then run:

```bash
npx expo prebuild --platform android
npx eas-cli build --profile development --platform android
```

The development APK opens the developer launcher and needs Metro to load the app. For the normal standalone FitCulture APK, run `npx eas-cli build --profile preview --platform android` instead, then install that new APK.

Install the generated APK on your Android phone. Open FitCulture, tap **Connect & sync Health Connect**, and approve the data types you want. To use local Android Studio instead of EAS, run `npx expo run:android` after prebuild.

Before the EAS build, link the app to your Expo account with `npx eas-cli login` and `npx eas-cli init`. In the linked project's **Environment variables** settings, add `EXPO_PUBLIC_SUPABASE_URL` and `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY` to both the **development** and **preview** environments. These are the only Supabase values the client build needs; never add a secret/service-role key. Use the `development` profile only while running the development server. For a standalone FitCulture APK, build the `preview` profile.

## 6. Parts that need external accounts or later integration

Health Connect is Android-only and each user controls read/write permissions. iOS requires a separate Apple HealthKit implementation; Garmin/Strava need their own integrations. Before a public Play Store release, publish an accurate privacy policy and complete the Play Console health-data declaration for the data types the app uses.

## Demo checklist

1. Add Supabase environment values.
2. Run migrations 001, 002 and 003 in order in Supabase SQL Editor.
3. Create an account in the login screen.
4. Open Activities -> Steps/Running/Yoga.
5. Start and finish a session.
6. Open Challenges to join one; complete an activity and confirm its score updates.
7. Open Rewards to claim the daily bonus or redeem FitCoins, and tap the level badge to edit the profile.
8. Open Coach after deploying the Edge Function and configuring `OPENAI_API_KEY`.
