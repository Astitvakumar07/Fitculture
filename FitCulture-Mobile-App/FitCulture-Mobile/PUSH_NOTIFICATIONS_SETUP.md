# FitCulture push notifications setup

The app now uses Expo Push Service for remote event alerts and Android/iOS scheduled notifications for daily water, workout and quote reminders. Push delivery through Expo has no per-message charge, but the Android FCM credential and a rebuilt app are required.

## 1. Apply the database migration

In the Supabase dashboard, open **SQL Editor**, paste and run `supabase/migrations/007_push_notifications.sql`.

This creates the `push_devices` table. The table is protected by row-level security so signed-in users can only save or remove their own device tokens.

## 2. Deploy the Edge Function

From this app folder, run:

```powershell
npx supabase functions deploy push-notifications --project-ref nnnjsvojcntysozzbcrz --use-api
```

The function authenticates the signed-in user, checks that each event belongs to that user, then sends to that event recipient's opted-in Expo devices. It supports saved activities and daily target progress, friend requests/acceptances, challenge creation/joins/rewards, and community creation/joins.

## 3. Configure Android push credentials in Expo

Expo requires Firebase Cloud Messaging (FCM v1) credentials for Android push delivery:

1. Create a Firebase project and register an Android app using the exact package in `app.json` (`com.yourname.fitculture` currently).
2. In Firebase, enable the Firebase Cloud Messaging API and create a service account key as described in [Expo's FCM v1 guide](https://docs.expo.dev/push-notifications/fcm-credentials/).
3. In EAS, run `npx eas-cli credentials --platform android` and upload the Google service-account JSON under **Google Service Account for Push Notifications (FCM v1)**.
4. Download that Firebase app's `google-services.json` into this app folder and set `expo.android.googleServicesFile` to `./google-services.json` in `app.json`.
5. Keep the service-account JSON private. Do not commit it or put it in app environment variables.

## 4. Rebuild and enable alerts

Push notifications need an installed native build, not Expo Go or the browser. After configuring Firebase, make a fresh development build:

```powershell
npx eas-cli build --profile development --platform android
```

Install the new APK, sign in, open the bell/Notifications screen, and enable **Activity & social alerts**. Allow FitCulture notifications when Android asks. To receive daily encouragement, water reminders and workout nudges too, enable those options on the same screen; those reminders are scheduled locally on the phone and do not use SMS.

Tap a push alert to open the relevant FitCulture section. If Android 13+ does not show the permission prompt, enable notifications for FitCulture in Android Settings.
