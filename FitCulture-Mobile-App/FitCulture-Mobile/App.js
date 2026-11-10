import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Linking,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import * as Notifications from 'expo-notifications';
import { supabase } from './lib/supabase';
import { connectAndSyncHealthConnect, writeWorkoutToHealthConnect } from './lib/healthConnect';
import { askCoach } from './lib/ai';
import { distanceKm, startGpsTracking, startStepTracking } from './lib/fitness';
import { defaultNotificationPreferences, getNotificationPreferences, saveNotificationPreferences, getNotificationPermissionStatus } from './lib/engagementNotifications';
import { registerPushDevice, unregisterPushDevice, sendFitCulturePush } from './lib/pushNotifications';

const green = '#AEEA6B';
const dark = '#071D15';
const panel = '#102D20';
const muted = '#A9BCAF';

const activities = [
  { key: 'Steps', icon: '👟', tint: '#4D9867', unit: 'steps', goal: 8500 },
  { key: 'Running', icon: '🏃', tint: '#277D74', unit: 'km', goal: 5 },
  { key: 'Cycling', icon: '🚴', tint: '#315D99', unit: 'km', goal: 20 },
  { key: 'Swimming', icon: '🏊', tint: '#286D94', unit: 'km', goal: 1 },
  { key: 'Yoga', icon: '🧘', tint: '#76599C', unit: 'minutes', goal: 30 },
  { key: 'Strength', icon: '🏋️', tint: '#A76046', unit: 'minutes', goal: 45 }
];

function localDayKey(value) {
  const date = value instanceof Date ? value : new Date(value);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function activitySummary(row) {
  if (row.activity_type === 'Steps') return `${Number(row.steps || 0).toLocaleString()} steps`;
  if (['Running', 'Cycling', 'Swimming'].includes(row.activity_type)) return `${Number(row.distance_km || 0).toFixed(2)} km`;
  return `${Math.floor(Number(row.duration_seconds || 0) / 60)} min`;
}

function Pill({ children }) {
  return (
    <View style={styles.pill}>
      <Text style={styles.pillText}>{children}</Text>
    </View>
  );
}

function Button({ title, onPress, secondary = false, disabled = false, style }) {
  return (
    <Pressable
      disabled={disabled}
      onPress={onPress}
      style={[styles.button, secondary && styles.secondary, disabled && styles.disabled, style]}
    >
      <Text style={[styles.buttonText, secondary && styles.secondaryText]}>{title}</Text>
    </Pressable>
  );
}

export default function App() {
  const [session, setSession] = useState(null);
  const [isDemo, setIsDemo] = useState(false);
  const [tab, setTab] = useState('Home');
  const [selected, setSelected] = useState(null);
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [fullName, setFullName] = useState('');
  const [healthSteps, setHealthSteps] = useState(null);
  const [coachMessages, setCoachMessages] = useState(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data?.session ?? null);
      setLoading(false);
    }).catch(() => {
      setLoading(false);
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_e, next) => {
      if (next) {
        setSession(next);
        setIsDemo(false);
      }
    });

    return () => {
      if (subscription?.unsubscribe) subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (session && !isDemo) loadProfile();
  }, [session, isDemo]);

  useEffect(() => {
    if (Platform.OS === 'web') return undefined;
    const subscription = Notifications.addNotificationResponseReceivedListener(response => {
      const destination = response.notification.request.content.data?.route;
      if (['Home', 'Activities', 'Challenges', 'Community', 'Friends', 'Rewards'].includes(destination)) setTab(destination);
    });
    Notifications.getLastNotificationResponseAsync().then(response => {
      const destination = response?.notification?.request?.content?.data?.route;
      if (['Home', 'Activities', 'Challenges', 'Community', 'Friends', 'Rewards'].includes(destination)) setTab(destination);
    }).catch(() => {});
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    if (!session || isDemo) return;
    let active = true;
    getNotificationPreferences().then(preferences => {
      if (active && preferences.push) registerPushDevice().catch(error => console.warn('Could not refresh push registration:', error?.message));
    });
    return () => { active = false; };
  }, [session, isDemo]);

  async function loadProfile() {
    try {
      const { data: { user } = {} } = await supabase.auth.getUser();
      if (!user) return;
      const { data, error } = await supabase.from('profiles').select('*').eq('id', user.id).maybeSingle();
      if (error) throw error;
      if (data) setProfile(data);
    } catch (e) {
      console.warn('Could not load profile:', e.message);
    }
  }

  function enterDemoMode() {
    setIsDemo(true);
    setProfile({
      id: 'demo-athlete-1',
      full_name: 'Alex Chen (Demo Athlete)',
      age: 28,
      gender: 'Prefer not to say',
      height_cm: 172,
      weight_kg: 76,
      goal: 'general_fitness',
      bio: 'Building healthy habits, one session at a time.',
      city: 'Metro City',
      state: 'Demo State',
      country: 'India',
      level: 4,
      xp: 3420,
      fitcoins: 240,
      demo_activities: [],
      location: 'Metro City'
    });
    setSession({ user: { email: 'athlete@fitculture.demo' } });
  }

  async function login(signUp = false, details = {}) {
    if (!email.trim() || !password.trim()) {
      Alert.alert(
        'Required fields',
        'Please enter both email and password, or tap "⚡ Explore in Demo Mode" to view the app immediately.'
      );
      return;
    }
    if (signUp && (!details.fullName?.trim() || !details.age || !details.gender || !details.heightCm || !details.weightKg || !details.goal)) {
      Alert.alert('Complete your profile', 'Enter your name, age, gender, height, weight and fitness goal to create your account.');
      return;
    }
    if (signUp && (details.age < 13 || details.age > 120 || details.heightCm < 80 || details.heightCm > 250 || details.weightKg < 25 || details.weightKg > 400)) {
      Alert.alert('Check your measurements', 'Age must be 13–120, height 80–250 cm, and weight 25–400 kg.');
      return;
    }
    setLoading(true);
    try {
      const call = signUp
        ? supabase.auth.signUp({ email: email.trim(), password, options: { data: {
          full_name: details.fullName.trim(), age: String(details.age), gender: details.gender,
          height_cm: String(details.heightCm), weight_kg: String(details.weightKg), goal: details.goal
        } } })
        : supabase.auth.signInWithPassword({ email: email.trim(), password });
      const { error } = await call;
      setLoading(false);
      if (error) {
        Alert.alert(
          'Authentication Note',
          `${error.message}\n\nYou can also click "Explore in Demo Mode" below to try out all app features directly!`,
          [
            { text: 'Try Demo Mode', onPress: enterDemoMode },
            { text: 'OK' }
          ]
        );
      } else if (signUp) {
        Alert.alert('Check your email', 'Confirm your email, then sign in.');
      }
    } catch (err) {
      setLoading(false);
      Alert.alert('Sign In Error', err.message);
    }
  }

  async function signOut() {
    await unregisterPushDevice().catch(() => {});
    setIsDemo(false);
    setSession(null);
    setProfile(null);
    setCoachMessages(null);
    supabase.auth.signOut().catch(() => {});
  }

  const renderContent = () => {
    if (loading && !session) {
      return (
        <SafeAreaView style={styles.center}>
          <ActivityIndicator color={green} size="large" />
        </SafeAreaView>
      );
    }

    if (!session) {
      return (
        <Login
          email={email}
          password={password}
          fullName={fullName}
          setEmail={setEmail}
          setPassword={setPassword}
          setFullName={setFullName}
          login={login}
          loading={loading}
          enterDemoMode={enterDemoMode}
        />
      );
    }

    if (selected) {
      return (
        <ActivityScreen
          item={selected}
          profile={profile}
          isDemo={isDemo}
          setProfile={setProfile}
          back={() => setSelected(null)}
          refresh={loadProfile}
        />
      );
    }

    return (
      <SafeAreaView style={styles.safe}>
        <StatusBar style="light" />
        <View style={styles.header}>
          <View>
            <Text style={styles.eyebrow}>
              FITCULTURE ATHLETE {isDemo ? '· DEMO' : ''}
            </Text>
            <Text style={styles.title}>Make today count.</Text>
          </View>
          <View style={styles.headerRight}>
            <Pressable onPress={() => setTab('Profile')} style={styles.level}>
              <Text style={styles.levelText}>LV {profile?.level || 1} · PROFILE</Text>
            </Pressable>
            <Pressable onPress={() => setTab('Notifications')} style={styles.bellButton} accessibilityLabel="Notifications and reminders">
              <Text style={styles.bellText}>🔔</Text>
            </Pressable>
            <Pressable onPress={signOut} style={styles.signOutBtn}>
              <Text style={styles.signOutText}>Exit</Text>
            </Pressable>
          </View>
        </View>

        <View style={styles.screen}>
          {tab === 'Home' && <Home profile={profile} select={setSelected} setTab={setTab} isDemo={isDemo} refresh={loadProfile} healthSteps={healthSteps} setHealthSteps={setHealthSteps} />}
          {tab === 'Activities' && <Activities select={setSelected} />}
          {tab === 'Challenges' && <Challenges isDemo={isDemo} refresh={loadProfile} />}
          {tab === 'Community' && <Community isDemo={isDemo} />}
          {tab === 'Friends' && <Friends isDemo={isDemo} />}
          {tab === 'Notifications' && <NotificationsScreen profile={profile} isDemo={isDemo} />}
          {tab === 'Rewards' && <Rewards profile={profile} isDemo={isDemo} setProfile={setProfile} refresh={loadProfile} />}
          {tab === 'Profile' && <ProfileScreen profile={profile} isDemo={isDemo} setProfile={setProfile} refresh={loadProfile} />}
          {tab === 'Coach' && <Coach isDemo={isDemo} profile={profile} messages={coachMessages} setMessages={setCoachMessages} />}
        </View>

        <View style={styles.nav}>
          {[
            { name: 'Home', icon: '⌂' },
            { name: 'Activities', icon: '⚡' },
            { name: 'Challenges', icon: '🏁' },
            { name: 'Community', icon: '👥' },
            { name: 'Friends', icon: '🤝' },
            { name: 'Rewards', icon: '🏆' },
            { name: 'Coach', icon: '◌' }
          ].map(item => (
            <Pressable key={item.name} onPress={() => setTab(item.name)} style={styles.navItem}>
              <Text style={[styles.navIcon, tab === item.name && styles.navActive]}>{item.icon}</Text>
              <Text style={[styles.navText, tab === item.name && styles.navActive]}>{item.name}</Text>
            </Pressable>
          ))}
        </View>
      </SafeAreaView>
    );
  };

  return (
    <View style={styles.webWrapper}>
      <View style={styles.container}>
        {renderContent()}
      </View>
    </View>
  );
}

function Login({ email, password, fullName, setEmail, setPassword, setFullName, login, loading, enterDemoMode }) {
  const [registering, setRegistering] = useState(false);
  const [authMethod, setAuthMethod] = useState('email');
  const [phone, setPhone] = useState('');
  const [activePhone, setActivePhone] = useState('');
  const [otp, setOtp] = useState('');
  const [otpSent, setOtpSent] = useState(false);
  const [phoneBusy, setPhoneBusy] = useState(false);
  const [age, setAge] = useState('');
  const [gender, setGender] = useState('');
  const [heightCm, setHeightCm] = useState('');
  const [weightKg, setWeightKg] = useState('');
  const [goal, setGoal] = useState('');
  const genderOptions = ['Female', 'Male', 'Non-binary', 'Prefer not to say'];
  const goalOptions = [
    { key: 'weight_loss', label: 'Weight loss' },
    { key: 'weight_gain', label: 'Weight gain' },
    { key: 'maintain_weight', label: 'Maintain weight' },
    { key: 'general_fitness', label: 'General fitness' }
  ];

  function registrationDetails() {
    if (!fullName.trim() || !age || !gender || !heightCm || !weightKg || !goal) {
      Alert.alert('Complete your profile', 'Enter your name, age, gender, height, weight and fitness goal to create your account.');
      return null;
    }
    const details = { age: Number(age), heightCm: Number(heightCm), weightKg: Number(weightKg) };
    if (details.age < 13 || details.age > 120 || details.heightCm < 80 || details.heightCm > 250 || details.weightKg < 25 || details.weightKg > 400) {
      Alert.alert('Check your measurements', 'Age must be 13–120, height 80–250 cm, and weight 25–400 kg.');
      return null;
    }
    return {
      full_name: fullName.trim(), age: String(details.age), gender,
      height_cm: String(details.heightCm), weight_kg: String(details.weightKg), goal
    };
  }

  async function sendPhoneCode(numberToUse = phone) {
    if (phoneBusy) return;
    const normalized = numberToUse.replace(/[\s()-]/g, '');
    if (!/^\+[1-9]\d{7,14}$/.test(normalized)) {
      Alert.alert('Enter your phone number', 'Use international format with country code, for example +91 9876543210.');
      return;
    }
    const data = registering ? registrationDetails() : undefined;
    if (registering && !data) return;
    setPhoneBusy(true);
    try {
      const { error } = await supabase.auth.signInWithOtp({
        phone: normalized,
        options: { shouldCreateUser: registering, ...(data ? { data } : {}) }
      });
      if (error) { Alert.alert('Could not send code', error.message); return; }
      setPhone(normalized); setActivePhone(normalized); setOtp(''); setOtpSent(true);
      Alert.alert('Code sent', `Check the SMS sent to ${normalized}.`);
    } catch (error) { Alert.alert('Could not send code', error?.message || 'Check your connection and try again.'); }
    finally { setPhoneBusy(false); }
  }

  async function phoneSignIn() {
    if (phoneBusy) return;
    if (!otpSent) return sendPhoneCode();
    if (!/^\d{6}$/.test(otp.trim())) {
      Alert.alert('Enter the 6-digit code', 'Type the verification code from your SMS.');
      return;
    }
    setPhoneBusy(true);
    try {
      const { error } = await supabase.auth.verifyOtp({ phone: activePhone, token: otp.trim(), type: 'sms' });
      if (error) { Alert.alert('Code not verified', error.message); return; }
    } catch (error) { Alert.alert('Code not verified', error?.message || 'Check your connection and try again.'); }
    finally { setPhoneBusy(false); }
  }

  function setMethod(method) {
    setAuthMethod(method);
    setOtpSent(false); setOtp(''); setActivePhone('');
  }

  return (
    <SafeAreaView style={styles.login}>
      <StatusBar style="light" />
      <ScrollView contentContainerStyle={{ flexGrow: 1, justifyContent: 'center' }} showsVerticalScrollIndicator={false}>
        <Text style={styles.logo}>
          F<Text style={{ color: green }}>itCulture</Text>
        </Text>
        <View style={styles.loginBody}>
          <Pill>MOVE · COMPETE · EVOLVE</Pill>
          <Text style={styles.loginTitle}>
            Fitness feels{'\n'}
            <Text style={{ color: green }}>better together.</Text>
          </Text>
          <Text style={styles.loginCopy}>
            Track your movement, join live tournaments and turn consistency into rewards.
          </Text>

          <View style={styles.loginCard}>
            <Text style={styles.loginCardTitle}>{registering ? 'Create your athlete profile' : 'Welcome back'}</Text>
            {!registering && <Text style={styles.smallCopy}>Sign in to continue, or create an account to set up your fitness profile.</Text>}
            <View style={styles.authMethodRow}>
              <Pressable onPress={() => setMethod('email')} style={[styles.authMethod, authMethod === 'email' && styles.authMethodSelected]}><Text style={[styles.authMethodText, authMethod === 'email' && styles.authMethodTextSelected]}>Email</Text></Pressable>
              <Pressable onPress={() => setMethod('phone')} style={[styles.authMethod, authMethod === 'phone' && styles.authMethodSelected]}><Text style={[styles.authMethodText, authMethod === 'phone' && styles.authMethodTextSelected]}>Mobile number</Text></Pressable>
            </View>
            {registering && <>
              <Text style={styles.formLabel}>FULL NAME</Text>
              <TextInput
              placeholder="Full name (for new account)"
              placeholderTextColor="#819489"
              autoCapitalize="words"
              value={fullName}
              onChangeText={setFullName}
              style={styles.input}
            />
              <Text style={styles.formLabel}>AGE</Text>
              <TextInput placeholder="Age" placeholderTextColor="#819489" value={age} onChangeText={setAge} keyboardType="number-pad" style={styles.input} />
              <Text style={styles.formLabel}>GENDER</Text>
              <View style={styles.choiceRow}>{genderOptions.map(option => <Pressable key={option} onPress={() => setGender(option)} style={[styles.choice, gender === option && styles.choiceSelected]}><Text style={[styles.choiceText, gender === option && styles.choiceTextSelected]}>{option}</Text></Pressable>)}</View>
              <View style={styles.formRow}>
                <View style={{ flex: 1 }}><Text style={styles.formLabel}>HEIGHT (CM)</Text><TextInput placeholder="e.g. 170" placeholderTextColor="#819489" value={heightCm} onChangeText={setHeightCm} keyboardType="decimal-pad" style={styles.input} /></View>
                <View style={{ flex: 1 }}><Text style={styles.formLabel}>WEIGHT (KG)</Text><TextInput placeholder="e.g. 65" placeholderTextColor="#819489" value={weightKg} onChangeText={setWeightKg} keyboardType="decimal-pad" style={styles.input} /></View>
              </View>
              <Text style={styles.formLabel}>FITNESS GOAL</Text>
              <View style={styles.choiceRow}>{goalOptions.map(option => <Pressable key={option.key} onPress={() => setGoal(option.key)} style={[styles.choice, goal === option.key && styles.choiceSelected]}><Text style={[styles.choiceText, goal === option.key && styles.choiceTextSelected]}>{option.label}</Text></Pressable>)}</View>
            </>}
            {authMethod === 'email' ? <>
              <TextInput placeholder="Email" placeholderTextColor="#819489" autoCapitalize="none" keyboardType="email-address" value={email} onChangeText={setEmail} style={styles.input} />
              <TextInput placeholder="Password" placeholderTextColor="#819489" secureTextEntry value={password} onChangeText={setPassword} style={styles.input} />
              <Button
                title={loading ? (registering ? 'Creating account…' : 'Signing in…') : (registering ? 'Create account →' : 'Sign in to FitCulture →')}
                onPress={() => registering
                  ? login(true, { fullName, age: Number(age), gender, heightCm: Number(heightCm), weightKg: Number(weightKg), goal })
                  : login(false)}
                disabled={loading}
              />
            </> : <>
              <TextInput placeholder="Mobile number with country code" placeholderTextColor="#819489" autoCapitalize="none" keyboardType="phone-pad" value={phone} onChangeText={setPhone} editable={!otpSent} style={styles.input} />
              {!otpSent && <Text style={styles.phoneHelper}>Use international format, e.g. +91 9876543210</Text>}
              {otpSent && <>
                <Text style={styles.phoneHelper}>Enter the 6-digit SMS code sent to {activePhone}.</Text>
                <TextInput placeholder="6-digit code" placeholderTextColor="#819489" keyboardType="number-pad" value={otp} onChangeText={setOtp} maxLength={6} style={styles.input} />
                <Pressable onPress={() => { setOtpSent(false); setOtp(''); }}><Text style={styles.signUp}>Change number</Text></Pressable>
              </>}
              <Button title={phoneBusy ? (otpSent ? 'Verifying…' : 'Sending code…') : otpSent ? 'Verify code →' : 'Send SMS code →'} onPress={phoneSignIn} disabled={phoneBusy} />
              {otpSent && <Pressable onPress={() => sendPhoneCode(activePhone)} disabled={phoneBusy} style={{ marginTop: 10 }}><Text style={styles.signUp}>Resend code</Text></Pressable>}
            </>}
            <Pressable onPress={() => { setRegistering(value => !value); setOtpSent(false); setOtp(''); }} style={{ marginTop: 12 }}>
              <Text style={styles.signUp}>{registering ? 'Already have an account? Sign in' : 'New athlete? Create your account'}</Text>
            </Pressable>

            <View style={styles.divider}>
              <View style={styles.dividerLine} />
              <Text style={styles.dividerText}>OR TRY IMMEDIATELY</Text>
              <View style={styles.dividerLine} />
            </View>

            <Button
              title="⚡ Explore in Demo Mode (No sign-in)"
              secondary
              onPress={enterDemoMode}
            />
          </View>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function Home({ profile, select, setTab, isDemo, refresh, healthSteps, setHealthSteps }) {
  const [syncing, setSyncing] = useState(false);
  const [healthMessage, setHealthMessage] = useState('Not connected yet');
  const [summary, setSummary] = useState({ steps: null, activeMinutes: null, streak: null, recent: [], loading: true, error: false });
  const [challenge, setChallenge] = useState(null);
  const [challengeLoading, setChallengeLoading] = useState(true);

  useEffect(() => {
    let active = true;
    async function loadSummary() {
      const today = localDayKey(new Date());
      if (isDemo) {
        const recent = (profile?.demo_activities || []).filter(row => {
          const created = new Date(row.created_at);
          return created >= new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
        });
        const todayRows = recent.filter(row => localDayKey(row.created_at) === today);
        const dates = new Set(recent.map(row => localDayKey(row.created_at)));
        let streak = 0;
        const cursor = new Date();
        if (!dates.has(localDayKey(cursor))) cursor.setDate(cursor.getDate() - 1);
        while (dates.has(localDayKey(cursor))) {
          streak += 1;
          cursor.setDate(cursor.getDate() - 1);
        }
        if (active) setSummary({
          steps: todayRows.reduce((sum, row) => sum + (row.activity_type === 'Steps' ? Number(row.steps || 0) : 0), 0),
          activeMinutes: Math.round(todayRows.reduce((sum, row) => sum + Number(row.duration_seconds || 0), 0) / 60),
          streak,
          recent: recent.slice(0, 4),
          loading: false,
          error: false
        });
        return;
      }
      const since = new Date();
      since.setHours(0, 0, 0, 0);
      since.setDate(since.getDate() - 30);
      const { data, error } = await supabase.from('activity_sessions')
        .select('id, created_at, duration_seconds, distance_km, steps, activity_type')
        .gte('created_at', since.toISOString()).order('created_at', { ascending: false }).limit(100);
      if (!active) return;
      if (error) {
        setSummary(current => ({ ...current, loading: false, error: true }));
        return;
      }
      const rows = data || [];
      const todayRows = rows.filter(row => localDayKey(row.created_at) === today);
      const dates = new Set(rows.map(row => localDayKey(row.created_at)));
      let streak = 0;
      const day = new Date();
      if (!dates.has(localDayKey(day))) day.setDate(day.getDate() - 1);
      while (dates.has(localDayKey(day))) {
        streak += 1;
        day.setDate(day.getDate() - 1);
      }
      setSummary({
        steps: todayRows.reduce((sum, row) => sum + (row.activity_type === 'Steps' ? Number(row.steps || 0) : 0), 0),
        activeMinutes: Math.round(todayRows.reduce((sum, row) => sum + Number(row.duration_seconds || 0), 0) / 60),
        streak,
        recent: rows.slice(0, 4),
        loading: false,
        error: false
      });
    }
    loadSummary();
    return () => { active = false; };
  }, [isDemo, profile?.demo_activities]);

  useEffect(() => {
    let active = true;
    if (isDemo) {
      setChallenge(null);
      setChallengeLoading(false);
      return () => { active = false; };
    }
    setChallengeLoading(true);
    supabase.rpc('get_fitculture_challenges').then(({ data, error }) => {
      if (!active) return;
      const rows = error ? [] : data || [];
      setChallenge(rows.find(row => !row.joined && row.ends_at > new Date().toISOString()) || rows[0] || null);
      setChallengeLoading(false);
    }).catch(() => {
      if (!active) return;
      setChallenge(null);
      setChallengeLoading(false);
    });
    return () => { active = false; };
  }, [isDemo]);

  async function connectAndSync() {
    if (isDemo) {
      setHealthMessage('Sign in to sync health data to your FitCulture account.');
      return;
    }
    setSyncing(true);
    setHealthMessage('Requesting Health Connect access…');
    try {
      const result = await connectAndSyncHealthConnect(supabase);
      if (result.steps != null) setHealthSteps(result.steps);
      setHealthMessage(`Sync complete · ${result.imported} new workouts · ${result.steps ?? '—'} steps today`);
      await refresh();
    } catch (error) {
      setHealthMessage(error?.message || 'Health Connect sync failed.');
    } finally {
      setSyncing(false);
    }
  }

  const firstName = profile?.full_name?.trim()?.split(/\s+/)[0] || 'Athlete';
  const totalXp = Number(profile?.xp || 0);
  const levelXp = totalXp % 1000;
  const stepsToday = healthSteps ?? summary.steps;
  const stepProgress = stepsToday == null ? 0 : Math.min(100, (stepsToday / 8500) * 100);
  const activeProgress = summary.activeMinutes == null ? 0 : Math.min(100, (summary.activeMinutes / 30) * 100);

  return (
    <ScrollView showsVerticalScrollIndicator={false}>
      <View style={styles.hero}>
        <Pill>YOUR FITCULTURE DASHBOARD</Pill>
        <Text style={styles.heroTitle}>Hey, {firstName}.</Text>
        <Text style={styles.heroText}>Level {profile?.level || 1} · {totalXp.toLocaleString()} total XP · {profile?.fitcoins || 0} FitCoins</Text>
        <View style={styles.homeXp}>
          <View style={styles.xp}>
            <View style={[styles.xpFill, { width: `${levelXp / 10}%` }]} />
          </View>
          <Text style={styles.homeXpText}>{levelXp.toLocaleString()} / 1,000 XP to level {(profile?.level || 1) + 1}</Text>
        </View>
        <Button title="Start an activity →" onPress={() => setTab('Activities')} style={styles.heroButton} />
        <View style={styles.heroRing}>
          <Text style={styles.ringValue}>{profile?.level || 1}</Text>
          <Text style={styles.ringLabel}>LEVEL</Text>
        </View>
      </View>

      <Text style={styles.sectionTitle}>Today’s movement</Text>
      <View style={styles.metricRow}>
        <Metric icon="👟" value={summary.loading ? '…' : stepsToday?.toLocaleString() ?? '—'} label="steps today" />
        <Metric icon="◒" value={summary.loading ? '…' : summary.activeMinutes == null ? '—' : summary.activeMinutes} label="active min" />
        <Metric icon="🔥" value={summary.loading ? '…' : summary.streak == null ? '—' : summary.streak} label="day streak" />
      </View>

      <View style={styles.homeGoals}>
        <View style={styles.goalCard}>
          <View style={styles.row}>
            <Text style={styles.goalIcon}>👟</Text>
            <Text style={styles.goalPercent}>{stepsToday == null ? '—' : `${Math.round(stepProgress)}%`}</Text>
          </View>
          <Text style={styles.goalValue}>{stepsToday == null ? '—' : stepsToday.toLocaleString()}</Text>
          <Text style={styles.metricLabel}>of 8,500 steps</Text>
          <View style={styles.goalTrack}><View style={[styles.goalFill, { width: `${stepProgress}%` }]} /></View>
        </View>
        <View style={styles.goalCard}>
          <View style={styles.row}>
            <Text style={styles.goalIcon}>◒</Text>
            <Text style={styles.goalPercent}>{summary.activeMinutes == null ? '—' : `${Math.round(activeProgress)}%`}</Text>
          </View>
          <Text style={styles.goalValue}>{summary.activeMinutes == null ? '—' : summary.activeMinutes}</Text>
          <Text style={styles.metricLabel}>of 30 active min</Text>
          <View style={styles.goalTrack}><View style={[styles.goalFill, { width: `${activeProgress}%` }]} /></View>
        </View>
      </View>

      {Platform.OS === 'android' && <View style={styles.card}>
        <Text style={styles.eyebrow}>ANDROID HEALTH SYNC</Text>
        <Text style={styles.cardTitle}>Health Connect</Text>
        <Text style={styles.smallCopy}>Sync today’s steps and recent workouts from your Android health apps.</Text>
        <Button title={syncing ? 'Syncing…' : 'Connect & sync Health Connect'} onPress={connectAndSync} disabled={syncing} />
        <Text style={styles.healthMessage}>{healthMessage}</Text>
      </View>}

      <View style={styles.card}>
        <View style={styles.row}>
          <View style={{ flex: 1 }}>
            <Text style={styles.eyebrow}>WEEKLY COMPETITION</Text>
            <Text style={styles.cardTitle}>{challengeLoading ? 'Finding a challenge…' : challenge?.title || 'Ready to compete?'}</Text>
          </View>
          <Text style={styles.challengeIcon}>🏁</Text>
        </View>
        <Text style={styles.smallCopy}>{challenge ? `${challenge.activity_type} · ${challenge.participant_count} athletes · ${challenge.reward_xp} XP + ${challenge.reward_coins} FitCoins` : 'Join a challenge and track your activity against other athletes.'}</Text>
        {challenge?.joined && <Text style={styles.healthMessage}>Your score: {Number(challenge.my_score || 0).toLocaleString()}</Text>}
        <Button title="View challenges →" secondary onPress={() => setTab('Challenges')} />
      </View>

      <View style={styles.card}>
        <View style={styles.row}>
          <View>
            <Text style={styles.eyebrow}>QUICK START</Text>
            <Text style={styles.cardTitle}>Move your way</Text>
          </View>
          <Pressable onPress={() => setTab('Activities')}>
            <Text style={styles.link}>All activities →</Text>
          </Pressable>
        </View>
        <View style={styles.quickGrid}>
          {activities.slice(0, 4).map(a => (
            <Pressable key={a.key} onPress={() => select(a)} style={[styles.quick, { backgroundColor: a.tint }]}>
              <Text style={styles.quickIcon}>{a.icon}</Text>
              <Text style={styles.quickName}>{a.key}</Text>
            </Pressable>
          ))}
        </View>
      </View>

      <View style={styles.coachCard}>
        <Text style={styles.coachBadge}>AI</Text>
        <Text style={styles.coachEyebrow}>COACH MIRA</Text>
        <Text style={styles.coachCardTitle}>Need a plan for today?</Text>
        <Text style={styles.coachCopy}>Ask Coach Mira for a workout, recovery idea or goal-specific guidance.</Text>
        <Pressable onPress={() => setTab('Coach')}>
          <Text style={styles.coachLink}>Talk to Coach Mira →</Text>
        </Pressable>
      </View>

      <View style={styles.card}>
        <View style={styles.row}>
          <View>
            <Text style={styles.eyebrow}>YOUR TRAINING LOG</Text>
            <Text style={styles.cardTitle}>Recent activity</Text>
          </View>
          <Pressable onPress={() => setTab('Activities')}><Text style={styles.link}>Start one →</Text></Pressable>
        </View>
        {summary.loading ? <ActivityIndicator color={green} style={{ margin: 18 }} /> : summary.recent.length ? summary.recent.slice(0, 3).map((row, index) => {
          const activity = activities.find(item => item.key === row.activity_type);
          return (
            <View style={styles.recentRow} key={row.id || `${row.created_at}-${index}`}>
              <Text style={styles.recentIcon}>{activity?.icon || '⚡'}</Text>
              <View style={{ flex: 1 }}>
                <Text style={styles.rankName}>{row.activity_type}</Text>
                <Text style={styles.rankPlace}>{new Date(row.created_at).toLocaleDateString()}</Text>
              </View>
              <Text style={styles.rankScore}>{activitySummary(row)}</Text>
            </View>
          );
        }) : <Text style={styles.empty}>{summary.error ? 'Could not load your activity right now.' : 'No sessions yet. Start your first activity to see it here.'}</Text>}
      </View>
    </ScrollView>
  );
}

function Metric({ icon, value, label }) {
  return (
    <View style={styles.metric}>
      <Text>{icon}</Text>
      <Text style={styles.metricValue}>{value}</Text>
      <Text style={styles.metricLabel}>{label}</Text>
    </View>
  );
}

function Activities({ select }) {
  return (
    <ScrollView showsVerticalScrollIndicator={false}>
      <Text style={styles.sectionTitle}>Choose your movement</Text>
      <Text style={styles.smallCopy}>Each activity includes tracking, tournaments and leaderboards.</Text>
      <View style={styles.activityGrid}>
        {activities.map(a => (
          <Pressable key={a.key} onPress={() => select(a)} style={[styles.activityCard, { backgroundColor: a.tint }]}>
            <Text style={styles.activityIcon}>{a.icon}</Text>
            <Text style={styles.activityType}>TRACK & COMPETE</Text>
            <Text style={styles.activityName}>{a.key}</Text>
            <Text style={styles.activityOpen}>Open activity →</Text>
          </Pressable>
        ))}
      </View>
    </ScrollView>
  );
}

function ActivityScreen({ item, profile, isDemo, setProfile, back, refresh }) {
  const [running, setRunning] = useState(false);
  const [value, setValue] = useState(0);
  const [seconds, setSeconds] = useState(0);
  const [loading, setLoading] = useState(false);
  const [manualDistance, setManualDistance] = useState('');
  const [joiningChallenge, setJoiningChallenge] = useState(false);

  const sub = useRef(null);
  const points = useRef([]);
  const started = useRef(null);
  const timer = useRef(null);

  useEffect(() => {
    return () => stop(false);
  }, []);

  useEffect(() => {
    if (running) {
      timer.current = setInterval(() => {
        const sec = Math.floor((Date.now() - (started.current || Date.now())) / 1000);
        setSeconds(sec);
      }, 1000);
    }
    return () => clearInterval(timer.current);
  }, [running]);

  async function start() {
    setValue(item.key === 'Swimming' ? Number(manualDistance) || 0 : 0);
    setSeconds(0);
    points.current = [];
    started.current = Date.now();

    try {
      if (item.key === 'Steps' && Platform.OS !== 'web') {
        sub.current = await startStepTracking(setValue);
      } else if ((item.key === 'Running' || item.key === 'Cycling') && Platform.OS !== 'web') {
        sub.current = await startGpsTracking(point => {
          const last = points.current.at(-1);
          if (last) {
            setValue(v => Number((v + distanceKm(last, point)).toFixed(3)));
          }
          points.current.push(point);
        });
      }
    } catch (e) {
      Alert.alert('Tracking unavailable', e.message || 'Check this activity’s device permissions and try again.');
      started.current = null;
      return;
    }
    setRunning(true);
  }

  async function stop(save = true) {
    if (sub.current) {
      if (typeof sub.current.remove === 'function') {
        sub.current.remove();
      }
      sub.current = null;
    }
    clearInterval(timer.current);

    if (!running) return;
    const sessionStartedAt = started.current;
    const sessionEndedAt = Date.now();
    const durationSeconds = Math.max(seconds, sessionStartedAt ? Math.round((sessionEndedAt - sessionStartedAt) / 1000) : 0);
    setRunning(false);

    if (!save) return;

    setLoading(true);

    if (isDemo) {
      const earnedXp = Math.max(30, Math.round((durationSeconds / 60) * 15) + 25);
      const earnedCoins = Math.round(earnedXp / 3);
      if (setProfile) {
        setProfile(p => {
          const newXp = (p?.xp || 0) + earnedXp;
          const demoSession = {
            id: `demo-${sessionEndedAt}`,
            activity_type: item.key,
            distance_km: item.unit === 'km' ? value : null,
            steps: item.key === 'Steps' ? Math.round(value) : null,
            duration_seconds: durationSeconds,
            created_at: new Date(sessionEndedAt).toISOString()
          };
          return {
            ...p,
            xp: newXp,
            fitcoins: (p?.fitcoins || 0) + earnedCoins,
            level: Math.floor(newXp / 1000) + 1,
            demo_activities: [demoSession, ...(p?.demo_activities || [])].slice(0, 100)
          };
        });
      }
      setLoading(false);
      Alert.alert('Session complete!', `You earned +${earnedXp} XP and +${earnedCoins} FitCoins for ${item.key}.`);
      return;
    }

    let error;
    try {
      ({ error } = await supabase.rpc('complete_activity', {
        p_activity_type: item.key,
        p_distance_km: item.unit === 'km' ? value : null,
        p_steps: item.key === 'Steps' ? Math.round(value) : null,
        p_duration_seconds: durationSeconds,
        p_calories: Math.round((durationSeconds / 60) * 7)
      }));
    } catch (saveError) {
      error = saveError;
    }
    setLoading(false);

    if (error) {
      Alert.alert('Could not save activity', error.message);
    } else {
      const { data: { user } = {} } = await supabase.auth.getUser();
      if (user) {
        const { data: latestActivity } = await supabase.from('activity_sessions')
          .select('id').eq('user_id', user.id).order('created_at', { ascending: false }).limit(1).maybeSingle();
        if (latestActivity?.id) {
          const dayStart = new Date();
          dayStart.setHours(0, 0, 0, 0);
          sendFitCulturePush('activity_completed', latestActivity.id, { dayStart: dayStart.toISOString() });
        }
      }
      await refresh();
      let healthConnectNote = '';
      try {
        const savedToHealthConnect = await writeWorkoutToHealthConnect({
          activityType: item.key,
          startedAt: sessionStartedAt,
          endedAt: sessionEndedAt,
          distanceKm: item.unit === 'km' ? value : null,
          steps: item.key === 'Steps' ? Math.round(value) : null,
          calories: Math.round((durationSeconds / 60) * 7),
          route: points.current
        });
        if (savedToHealthConnect > 0) healthConnectNote = ' It was also added to Health Connect.';
      } catch (syncError) {
        healthConnectNote = ` Health Connect sync failed: ${syncError.message}`;
      }
      Alert.alert('Activity saved!', `You earned XP and FitCoins for ${item.key}.${healthConnectNote}`);
    }
  }

  async function joinChallenge() {
    if (isDemo) {
      Alert.alert('Sign in required', 'Create an account to join and compete in live challenges.');
      return;
    }
    setJoiningChallenge(true);
    let data; let error;
    try {
      ({ data, error } = await supabase.rpc('get_fitculture_challenges'));
    } catch (loadError) { error = loadError; }
    const challenge = (data || []).find(row => row.activity_type === item.key && row.ends_at > new Date().toISOString());
    if (error || !challenge) {
      Alert.alert('Challenges unavailable', error?.message || 'There is no active challenge for this activity yet.');
      setJoiningChallenge(false);
      return;
    }
    if (challenge.joined) {
      Alert.alert('Already joined', `You're in ${challenge.title}. Your completed sessions count automatically.`);
      setJoiningChallenge(false);
      return;
    }
    let result;
    try {
      result = await supabase.rpc('join_fitculture_challenge', { p_tournament_id: challenge.id });
    } catch (joinError) { result = { error: joinError }; }
    setJoiningChallenge(false);
    if (!result.error) sendFitCulturePush('challenge_joined', challenge.id);
    Alert.alert(result.error ? 'Could not join' : 'Challenge joined!', result.error?.message || `${challenge.title} is now tracking your ${item.key.toLowerCase()} sessions.`);
  }

  const display =
    item.key === 'Steps'
      ? Math.round(value).toLocaleString()
      : item.unit === 'km'
      ? value.toFixed(2)
      : Math.floor(seconds / 60);

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar style="light" />
      <ScrollView showsVerticalScrollIndicator={false}>
        <Pressable onPress={back}>
          <Text style={styles.back}>← All activities</Text>
        </Pressable>

        <View style={[styles.activityHero, { backgroundColor: item.tint }]}>
          <Text style={styles.activityIcon}>{item.icon}</Text>
          <Text style={styles.activityType}>{item.key.toUpperCase()} SESSION</Text>
          <Text style={styles.detailName}>{item.key}</Text>
          <Text style={styles.activityDesc}>
            {item.key === 'Yoga'
              ? 'Your leaderboard rank is based on mindful session time.'
              : `Track your ${item.key.toLowerCase()} with live workout metrics.`}
          </Text>

          <View style={styles.liveMetric}>
            <Text style={styles.liveValue}>{display}</Text>
            <Text style={styles.liveUnit}>{item.unit.toUpperCase()}</Text>
            <Text style={styles.timer}>
              {String(Math.floor(seconds / 60)).padStart(2, '0')}:{String(seconds % 60).padStart(2, '0')}
            </Text>
          </View>
        </View>

        {item.key === 'Swimming' && (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Pool distance</Text>
            <Text style={styles.smallCopy}>Enter the distance you swim; phones cannot measure pool laps reliably.</Text>
            <TextInput
              value={manualDistance}
              onChangeText={text => {
                setManualDistance(text);
                setValue(Math.max(0, Number.parseFloat(text) || 0));
              }}
              editable={!running}
              keyboardType="decimal-pad"
              placeholder="Distance in km, e.g. 0.50"
              placeholderTextColor="#819489"
              style={styles.activityInput}
            />
          </View>
        )}

        <View style={styles.actionRow}>
          <View style={styles.actionCol}>
            {!running ? (
              <Button title={`Start ${item.key} ▶`} onPress={start} />
            ) : (
              <Button title={loading ? 'Saving…' : 'Finish & save ✓'} onPress={() => stop(true)} disabled={loading} />
            )}
          </View>
          <View style={styles.actionCol}>
            <Button
              title="How it works"
              secondary
              onPress={() =>
                Alert.alert(
                  'Tracking',
                  item.key === 'Steps'
                    ? 'Counts steps with the phone motion sensor. Daily totals can also sync from Health Connect.'
                    : item.key === 'Swimming'
                    ? 'Tracks your session time. Enter the pool distance because a phone cannot reliably count swim laps.'
                    : 'Running and cycling use GPS distance. Yoga and Strength record session duration.'
                )
              }
            />
          </View>
        </View>

        <Leaderboard item={item} profile={profile} />

        <View style={styles.tournament}>
          <Text style={styles.eyebrow}>🏁 WEEKLY CHALLENGE</Text>
          <Text style={styles.cardTitle}>{item.key} Challenge</Text>
          <Text style={styles.smallCopy}>Join the live challenge. Saved sessions for this activity update your score and rank.</Text>
          <Button title={joiningChallenge ? 'Joining…' : 'Find & join challenge'} onPress={joinChallenge} disabled={joiningChallenge} />
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function Leaderboard({ item, profile }) {
  const [scope, setScope] = useState('City');
  const [rows, setRows] = useState([]);
  const [errorMessage, setErrorMessage] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    setLoading(true);
    supabase.rpc('get_leaderboard', { p_activity_type: item.key, p_scope: scope.toLowerCase() })
      .then(({ data, error }) => {
        if (!active) return;
        setRows(data || []);
        setErrorMessage(error?.message || '');
        setLoading(false);
      }).catch(error => {
        if (!active) return;
        setRows([]);
        setErrorMessage(error?.message || 'Could not load leaderboard.');
        setLoading(false);
      });
    return () => { active = false; };
  }, [item.key, scope]);

  return (
    <View style={styles.card}>
      <View style={styles.row}>
        <View>
          <Text style={styles.eyebrow}>{item.key.toUpperCase()} LEADERBOARD</Text>
          <Text style={styles.cardTitle}>Top athletes</Text>
        </View>
        <Pill>{scope}</Pill>
      </View>

      <View style={styles.scope}>
        {['Area', 'City', 'State', 'Country'].map(x => (
          <Pressable key={x} onPress={() => setScope(x)} style={[styles.scopeBtn, scope === x && styles.scopeActive]}>
            <Text style={scope === x ? styles.scopeActiveText : styles.scopeText}>{x}</Text>
          </Pressable>
        ))}
      </View>

      {loading ? <ActivityIndicator color={green} /> : rows.length ? (
        rows.map((r, i) => (
          <View style={styles.rank} key={r.user_id || i}>
            <Text style={styles.rankNo}>#{i + 1}</Text>
            <View style={{ flex: 1 }}>
              <Text style={styles.rankName}>{r.full_name || 'Athlete'}</Text>
              <Text style={styles.rankPlace}>{r.location || 'Local'}</Text>
            </View>
            <Text style={styles.rankScore}>
              {Number(r.score || 0).toFixed(item.key === 'Steps' ? 0 : 1)} {item.unit}
            </Text>
          </View>
        ))
      ) : (
        <Text style={styles.empty}>{errorMessage || 'No athletes have logged this activity in your area this week yet. Complete a session to appear here.'}</Text>
      )}
    </View>
  );
}

function ProfileScreen({ profile, isDemo, setProfile, refresh }) {
  const [fullName, setFullName] = useState(profile?.full_name || '');
  const [age, setAge] = useState(profile?.age ? String(profile.age) : '');
  const [gender, setGender] = useState(profile?.gender || 'Prefer not to say');
  const [heightCm, setHeightCm] = useState(profile?.height_cm ? String(profile.height_cm) : '');
  const [weightKg, setWeightKg] = useState(profile?.weight_kg ? String(profile.weight_kg) : '');
  const [goal, setGoal] = useState(profile?.goal || 'general_fitness');
  const [city, setCity] = useState(profile?.city || '');
  const [state, setState] = useState(profile?.state || '');
  const [country, setCountry] = useState(profile?.country || '');
  const [bio, setBio] = useState(profile?.bio || '');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setFullName(profile?.full_name || '');
    setAge(profile?.age ? String(profile.age) : '');
    setGender(profile?.gender || 'Prefer not to say');
    setHeightCm(profile?.height_cm ? String(profile.height_cm) : '');
    setWeightKg(profile?.weight_kg ? String(profile.weight_kg) : '');
    setGoal(profile?.goal || 'general_fitness');
    setCity(profile?.city || '');
    setState(profile?.state || '');
    setCountry(profile?.country || '');
    setBio(profile?.bio || '');
  }, [profile?.id]);

  async function saveProfile() {
    if (fullName.trim().length < 2) {
      Alert.alert('Name required', 'Enter at least 2 characters for your display name.');
      return;
    }
    if (!age || Number(age) < 13 || Number(age) > 120 || !heightCm || Number(heightCm) < 80 || Number(heightCm) > 250 || !weightKg || Number(weightKg) < 25 || Number(weightKg) > 400) {
      Alert.alert('Check your details', 'Age must be 13–120, height 80–250 cm, and weight 25–400 kg.');
      return;
    }
    setSaving(true);
    if (isDemo) {
      setProfile(p => ({ ...p, full_name: fullName.trim(), age: Number(age), gender, height_cm: Number(heightCm), weight_kg: Number(weightKg), goal, city: city.trim(), state: state.trim(), country: country.trim(), bio: bio.trim() }));
      setSaving(false);
      Alert.alert('Profile updated', 'Your demo profile has been updated.');
      return;
    }
    let data; let error;
    try {
      ({ data, error } = await supabase.rpc('update_fitculture_profile', {
        p_full_name: fullName.trim(), p_city: city.trim(), p_state: state.trim(), p_country: country.trim(), p_bio: bio.trim(),
        p_age: Number(age), p_gender: gender, p_height_cm: Number(heightCm), p_weight_kg: Number(weightKg), p_goal: goal
      }));
    } catch (saveError) { error = saveError; }
    setSaving(false);
    if (error) {
      Alert.alert('Could not update profile', error.message);
      return;
    }
    await refresh();
    Alert.alert('Profile updated', 'Your FitCulture profile is saved.');
  }

  return (
    <ScrollView showsVerticalScrollIndicator={false}>
      <Text style={styles.sectionTitle}>Athlete profile</Text>
      <View style={styles.card}>
        <Text style={styles.eyebrow}>YOUR PUBLIC ATHLETE DETAILS</Text>
        <Text style={styles.cardTitle}>{profile?.full_name || 'FitCulture Athlete'}</Text>
        <Text style={styles.smallCopy}>Level {profile?.level || 1} · {(profile?.xp || 0).toLocaleString()} XP · {profile?.fitcoins || 0} FitCoins</Text>
        <View style={styles.formRow}>
          <View style={{ flex: 1 }}><Text style={styles.formLabel}>AGE</Text><TextInput value={age} onChangeText={setAge} keyboardType="number-pad" style={styles.input} /></View>
          <View style={{ flex: 1 }}><Text style={styles.formLabel}>HEIGHT (CM)</Text><TextInput value={heightCm} onChangeText={setHeightCm} keyboardType="decimal-pad" style={styles.input} /></View>
          <View style={{ flex: 1 }}><Text style={styles.formLabel}>WEIGHT (KG)</Text><TextInput value={weightKg} onChangeText={setWeightKg} keyboardType="decimal-pad" style={styles.input} /></View>
        </View>
        <Text style={[styles.formLabel, { marginTop: 4 }]}>GENDER</Text>
        <View style={styles.choiceRow}>{['Female', 'Male', 'Non-binary', 'Prefer not to say'].map(option => <Pressable key={option} onPress={() => setGender(option)} style={[styles.choice, gender === option && styles.choiceSelected]}><Text style={[styles.choiceText, gender === option && styles.choiceTextSelected]}>{option}</Text></Pressable>)}</View>
        <Text style={[styles.formLabel, { marginTop: 12 }]}>FITNESS GOAL</Text>
        <View style={styles.choiceRow}>{[
          { key: 'weight_loss', label: 'Weight loss' }, { key: 'weight_gain', label: 'Weight gain' },
          { key: 'maintain_weight', label: 'Maintain weight' }, { key: 'general_fitness', label: 'General fitness' }
        ].map(option => <Pressable key={option.key} onPress={() => setGoal(option.key)} style={[styles.choice, goal === option.key && styles.choiceSelected]}><Text style={[styles.choiceText, goal === option.key && styles.choiceTextSelected]}>{option.label}</Text></Pressable>)}</View>
        {[
          ['Display name', fullName, setFullName],
          ['City', city, setCity],
          ['State / region', state, setState],
          ['Country', country, setCountry],
          ['Bio', bio, setBio]
        ].map(([label, value, setter]) => (
          <View key={label} style={{ marginTop: 10 }}>
            <Text style={styles.eyebrow}>{label.toUpperCase()}</Text>
            <TextInput value={value} onChangeText={setter} placeholder={label} placeholderTextColor="#819489" style={styles.input} maxLength={label === 'Bio' ? 240 : 80} multiline={label === 'Bio'} />
          </View>
        ))}
        <Button title={saving ? 'Saving…' : 'Save profile'} onPress={saveProfile} disabled={saving} />
      </View>
    </ScrollView>
  );
}

function Challenges({ isDemo, refresh }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [activityType, setActivityType] = useState('Running');
  const [durationDays, setDurationDays] = useState('7');

  async function load() {
    if (isDemo) {
      setRows([]);
      setLoadError('Sign in with your FitCulture account to join live challenges.');
      setLoading(false);
      return;
    }
    setLoading(true);
    let data; let error;
    try {
      ({ data, error } = await supabase.rpc('get_fitculture_challenges'));
    } catch (loadError) { error = loadError; }
    setRows(data || []);
    setLoadError(error?.message || '');
    setLoading(false);
  }

  useEffect(() => { load(); }, [isDemo]);

  async function act(row) {
    if (isDemo) return;
    setBusyId(row.id);
    const rpc = row.ends_at <= new Date().toISOString()
      ? 'claim_fitculture_challenge_reward'
      : 'join_fitculture_challenge';
    let error;
    try {
      ({ error } = await supabase.rpc(rpc, { p_tournament_id: row.id }));
    } catch (actionError) { error = actionError; }
    setBusyId(null);
    if (error) {
      Alert.alert(rpc.startsWith('claim') ? 'Reward unavailable' : 'Could not join challenge', error.message);
      return;
    }
    if (rpc.startsWith('claim')) sendFitCulturePush('reward_claimed', row.id);
    else sendFitCulturePush('challenge_joined', row.id);
    if (rpc.startsWith('claim')) await refresh();
    Alert.alert(rpc.startsWith('claim') ? 'Challenge reward claimed!' : 'Challenge joined', rpc.startsWith('claim') ? `You earned ${row.reward_xp} XP and ${row.reward_coins} FitCoins.` : 'Your completed activities will update your challenge score.');
    await load();
  }

  async function createChallenge() {
    if (isDemo) {
      Alert.alert('Sign in required', 'Sign in to create a live challenge for the FitCulture community.');
      return;
    }
    if (title.trim().length < 4) {
      Alert.alert('Add a challenge name', 'Use at least 4 characters for the challenge title.');
      return;
    }
    setBusyId('create');
    let error; let challengeId;
    try {
      const result = await supabase.rpc('create_fitculture_challenge', {
        p_title: title.trim(),
        p_description: description.trim(),
        p_activity_type: activityType,
        p_duration_days: Number(durationDays) || 7
      });
      error = result.error;
      challengeId = result.data;
    } catch (saveError) { error = saveError; }
    setBusyId(null);
    if (error) {
      Alert.alert('Could not create challenge', error.message);
      return;
    }
    if (challengeId) sendFitCulturePush('challenge_created', challengeId);
    setTitle(''); setDescription(''); setShowCreate(false);
    await load();
    Alert.alert('Challenge created!', 'It is live now, and you have been added as the first participant.');
  }

  return (
    <ScrollView showsVerticalScrollIndicator={false}>
      <Text style={styles.sectionTitle}>Challenges</Text>
      <Text style={styles.smallCopy}>Join a live challenge. Your saved FitCulture sessions update your score automatically.</Text>
      <View style={styles.card}>
        <Text style={styles.cardTitle}>Start a challenge</Text>
        <Text style={styles.smallCopy}>Create a public challenge. It starts immediately and lasts 1–30 days.</Text>
        {showCreate && <>
          <TextInput value={title} onChangeText={setTitle} placeholder="Challenge name" placeholderTextColor="#819489" maxLength={60} style={styles.communityInput} />
          <TextInput value={description} onChangeText={setDescription} placeholder="Description (optional)" placeholderTextColor="#819489" maxLength={300} multiline style={[styles.communityInput, { minHeight: 68 }]} />
          <Text style={styles.eyebrow}>ACTIVITY TYPE</Text>
          <View style={styles.choiceRow}>{activities.map(activity => <Pressable key={activity.key} onPress={() => setActivityType(activity.key)} style={[styles.choice, activityType === activity.key && styles.choiceSelected]}><Text style={[styles.choiceText, activityType === activity.key && styles.choiceTextSelected]}>{activity.icon} {activity.key}</Text></Pressable>)}</View>
          <TextInput value={durationDays} onChangeText={setDurationDays} placeholder="Duration in days (1–30)" placeholderTextColor="#819489" keyboardType="number-pad" style={styles.communityInput} />
          <Button title={busyId === 'create' ? 'Creating…' : 'Create challenge'} onPress={createChallenge} disabled={busyId === 'create'} />
        </>}
        <Button title={showCreate ? 'Cancel' : '＋ Create challenge'} secondary onPress={() => setShowCreate(value => !value)} />
      </View>
      {loading ? <ActivityIndicator color={green} style={{ margin: 24 }} /> : rows.length ? rows.map(row => {
        const ended = row.ends_at <= new Date().toISOString();
        const alreadyClaimed = row.reward_claimed;
        const action = !row.joined ? 'Join challenge' : ended && !alreadyClaimed ? 'Claim reward' : ended ? 'Reward claimed' : 'Joined ✓';
        return (
          <View style={styles.card} key={row.id}>
            <Text style={styles.eyebrow}>{row.activity_type.toUpperCase()} · {row.participant_count} ATHLETES</Text>
            <Text style={styles.cardTitle}>{row.title}</Text>
            <Text style={styles.smallCopy}>{row.description || `Log ${row.activity_type.toLowerCase()} sessions to compete.`}</Text>
            <Text style={styles.smallCopy}>Your score: {Number(row.my_score || 0).toLocaleString()} {row.activity_type === 'Steps' ? 'steps' : row.activity_type === 'Yoga' || row.activity_type === 'Strength' ? 'min' : 'km'}</Text>
            <Text style={styles.smallCopy}>{ended ? 'Challenge ended' : `Ends ${new Date(row.ends_at).toLocaleDateString()}`} · Reward {row.reward_xp} XP + {row.reward_coins} FitCoins</Text>
            <Button title={busyId === row.id ? 'Please wait…' : action} onPress={() => act(row)} disabled={busyId === row.id || (row.joined && (!ended || alreadyClaimed))} secondary={row.joined && (!ended || alreadyClaimed)} />
          </View>
        );
      }) : <View style={styles.card}><Text style={styles.empty}>{loadError || 'No current challenges. Apply the Supabase migration to create this week’s challenges.'}</Text><Button title="Refresh challenges" secondary onPress={load} /></View>}
    </ScrollView>
  );
}

function Community({ isDemo }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [busyId, setBusyId] = useState(null);
  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');

  async function load() {
    if (isDemo) {
      setRows([]); setLoadError('Sign in to create or join live communities.'); setLoading(false);
      return;
    }
    setLoading(true);
    let data; let error;
    try { ({ data, error } = await supabase.rpc('get_fitculture_communities')); }
    catch (loadError) { error = loadError; }
    setRows(data || []); setLoadError(error?.message || ''); setLoading(false);
  }

  useEffect(() => { load(); }, [isDemo]);

  async function createCommunity() {
    if (isDemo) { Alert.alert('Sign in required', 'Sign in to create a community.'); return; }
    if (name.trim().length < 3) { Alert.alert('Add a community name', 'Use at least 3 characters.'); return; }
    setBusyId('create');
    let error; let communityId;
    try {
      const result = await supabase.rpc('create_fitculture_community', {
        p_name: name.trim(), p_description: description.trim()
      });
      error = result.error;
      communityId = result.data;
    } catch (saveError) { error = saveError; }
    setBusyId(null);
    if (error) { Alert.alert('Could not create community', error.message); return; }
    if (communityId) sendFitCulturePush('community_created', communityId);
    setName(''); setDescription(''); setShowCreate(false);
    await load();
    Alert.alert('Community created!', 'You are the first member. Invite others to join from the Communities list.');
  }

  async function joinCommunity(row) {
    if (row.joined) return;
    setBusyId(row.id);
    let error;
    try { ({ error } = await supabase.rpc('join_fitculture_community', { p_community_id: row.id })); }
    catch (joinError) { error = joinError; }
    setBusyId(null);
    if (error) { Alert.alert('Could not join community', error.message); return; }
    sendFitCulturePush('community_joined', row.id);
    await load();
  }

  return (
    <ScrollView showsVerticalScrollIndicator={false}>
      <Text style={styles.sectionTitle}>Community</Text>
      <Text style={styles.smallCopy}>Find your people, build a fitness group and stay consistent together.</Text>
      <View style={styles.card}>
        <Text style={styles.cardTitle}>Create a community</Text>
        <Text style={styles.smallCopy}>Start a public group around your team, city or fitness goals.</Text>
        {showCreate && <>
          <TextInput value={name} onChangeText={setName} placeholder="Community name" placeholderTextColor="#819489" maxLength={50} style={styles.communityInput} />
          <TextInput value={description} onChangeText={setDescription} placeholder="What is this group about? (optional)" placeholderTextColor="#819489" maxLength={300} multiline style={[styles.communityInput, { minHeight: 68 }]} />
          <Button title={busyId === 'create' ? 'Creating…' : 'Create community'} onPress={createCommunity} disabled={busyId === 'create'} />
        </>}
        <Button title={showCreate ? 'Cancel' : '＋ Create community'} secondary onPress={() => setShowCreate(value => !value)} />
      </View>
      <View style={styles.row}>
        <Text style={styles.sectionTitle}>Discover groups</Text>
        <Pressable onPress={load}><Text style={styles.link}>Refresh</Text></Pressable>
      </View>
      {loading ? <ActivityIndicator color={green} style={{ margin: 24 }} /> : rows.length ? rows.map(row => (
        <View style={styles.card} key={row.id}>
          <Text style={styles.eyebrow}>👥 {row.member_count} MEMBERS</Text>
          <Text style={styles.cardTitle}>{row.name}</Text>
          <Text style={styles.smallCopy}>{row.description || 'A FitCulture group for people who want to move more together.'}</Text>
          <Button title={busyId === row.id ? 'Joining…' : row.joined ? 'Joined ✓' : 'Join community'} onPress={() => joinCommunity(row)} disabled={row.joined || busyId === row.id} secondary={row.joined} />
        </View>
      )) : <View style={styles.card}><Text style={styles.empty}>{loadError || 'No communities yet. Create the first group!'}</Text><Button title="Refresh communities" secondary onPress={load} /></View>}
    </ScrollView>
  );
}

function Friends({ isDemo }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [connections, setConnections] = useState([]);
  const [loading, setLoading] = useState(false);
  const [searching, setSearching] = useState(false);
  const [busyId, setBusyId] = useState(null);
  const [errorMessage, setErrorMessage] = useState('');

  async function loadConnections() {
    if (isDemo) { setConnections([]); return; }
    setLoading(true);
    let data; let error;
    try { ({ data, error } = await supabase.rpc('get_fitculture_friend_connections')); }
    catch (loadError) { error = loadError; }
    setConnections(data || []);
    if (error) setErrorMessage(error.message || 'Could not load friend requests.');
    setLoading(false);
  }

  useEffect(() => { loadConnections(); }, [isDemo]);

  async function searchUsers() {
    if (isDemo) { setErrorMessage('Sign in to find FitCulture users and send friend requests.'); return; }
    if (query.trim().length < 2) { setErrorMessage('Type at least 2 letters to search by name.'); return; }
    setSearching(true); setErrorMessage('');
    let data; let error;
    try { ({ data, error } = await supabase.rpc('search_fitculture_users', { p_query: query.trim() })); }
    catch (searchError) { error = searchError; }
    setResults(data || []);
    setErrorMessage(error?.message || '');
    setSearching(false);
  }

  async function sendRequest(userId) {
    setBusyId(userId);
    let error; let requestId;
    try { ({ error } = await supabase.rpc('send_fitculture_friend_request', { p_user_id: userId })); }
    catch (sendError) { error = sendError; }
    setBusyId(null);
    if (error) { Alert.alert('Could not send request', error.message); return; }
    const { data: { user } = {} } = await supabase.auth.getUser();
    if (user) {
      const { data: request } = await supabase.from('friend_requests').select('id')
        .eq('requester_id', user.id).eq('recipient_id', userId).eq('status', 'pending')
        .order('created_at', { ascending: false }).limit(1).maybeSingle();
      requestId = request?.id;
    }
    if (requestId) sendFitCulturePush('friend_request', requestId);
    await Promise.all([searchUsers(), loadConnections()]);
  }

  async function respond(requestId, accept) {
    setBusyId(requestId);
    let error;
    try { ({ error } = await supabase.rpc('respond_fitculture_friend_request', { p_request_id: requestId, p_accept: accept })); }
    catch (respondError) { error = respondError; }
    setBusyId(null);
    if (error) { Alert.alert('Could not update request', error.message); return; }
    if (accept) sendFitCulturePush('friend_accepted', requestId);
    await Promise.all([loadConnections(), query.trim().length >= 2 ? searchUsers() : Promise.resolve()]);
  }

  const incoming = connections.filter(row => row.direction === 'incoming' && row.status === 'pending');
  const outgoing = connections.filter(row => row.direction === 'outgoing' && row.status === 'pending');
  const friends = connections.filter(row => row.status === 'accepted');

  return (
    <ScrollView showsVerticalScrollIndicator={false}>
      <Text style={styles.sectionTitle}>Friends</Text>
      <Text style={styles.smallCopy}>Find FitCulture athletes and stay motivated together.</Text>
      <View style={styles.card}>
        <Text style={styles.cardTitle}>Find people</Text>
        <View style={styles.friendSearchRow}>
          <TextInput value={query} onChangeText={setQuery} onSubmitEditing={searchUsers} placeholder="Search by name" placeholderTextColor="#819489" style={[styles.communityInput, styles.friendSearchInput]} returnKeyType="search" />
          <Pressable onPress={searchUsers} disabled={searching} style={styles.friendSearchButton}><Text style={styles.friendSearchButtonText}>{searching ? '…' : 'Search'}</Text></Pressable>
        </View>
        {!!errorMessage && <Text style={styles.healthMessage}>{errorMessage}</Text>}
        {results.map(row => (
          <View style={styles.friendRow} key={row.user_id}>
            <View style={styles.friendAvatar}><Text style={styles.friendAvatarText}>{(row.full_name || 'A').trim().charAt(0).toUpperCase()}</Text></View>
            <View style={{ flex: 1 }}><Text style={styles.rankName}>{row.full_name || 'FitCulture Athlete'}</Text><Text style={styles.rankPlace}>{row.city || 'FitCulture athlete'}</Text></View>
            {row.relationship === 'none' ? <Pressable onPress={() => sendRequest(row.user_id)} disabled={busyId === row.user_id} style={styles.friendAction}><Text style={styles.friendActionText}>{busyId === row.user_id ? '…' : '＋ Add'}</Text></Pressable>
              : row.relationship === 'sent' ? <Text style={styles.friendStatus}>Requested</Text>
              : row.relationship === 'received' ? <Text style={styles.friendStatus}>They requested you</Text>
              : <Text style={styles.friendStatus}>Friends ✓</Text>}
          </View>
        ))}
        {!results.length && !errorMessage && <Text style={styles.empty}>Search for another athlete by their name.</Text>}
      </View>

      <Text style={styles.sectionTitle}>Friend requests</Text>
      {loading ? <ActivityIndicator color={green} style={{ margin: 20 }} /> : incoming.length ? incoming.map(row => (
        <View style={styles.friendCard} key={row.request_id}>
          <View style={styles.friendRow}>
            <View style={styles.friendAvatar}><Text style={styles.friendAvatarText}>{(row.full_name || 'A').trim().charAt(0).toUpperCase()}</Text></View>
            <View style={{ flex: 1 }}><Text style={styles.rankName}>{row.full_name}</Text><Text style={styles.rankPlace}>{row.city || 'FitCulture athlete'}</Text></View>
          </View>
          <View style={styles.friendButtons}>
            <Button title={busyId === row.request_id ? 'Please wait…' : 'Accept'} onPress={() => respond(row.request_id, true)} disabled={busyId === row.request_id} style={styles.friendButton} />
            <Button title="Decline" secondary onPress={() => respond(row.request_id, false)} disabled={busyId === row.request_id} style={styles.friendButton} />
          </View>
        </View>
      )) : <Text style={styles.empty}>No new friend requests.</Text>}

      {outgoing.length > 0 && <View style={styles.card}><Text style={styles.cardTitle}>Sent requests</Text>{outgoing.map(row => <View style={styles.friendRow} key={row.request_id}><Text style={styles.friendAvatarText}>🤝</Text><View style={{ flex: 1 }}><Text style={styles.rankName}>{row.full_name}</Text><Text style={styles.rankPlace}>{row.city || 'Waiting for a reply'}</Text></View><Text style={styles.friendStatus}>Pending</Text></View>)}</View>}

      <Text style={styles.sectionTitle}>Your friends · {friends.length}</Text>
      {friends.length ? friends.map(row => (
        <View style={styles.friendCard} key={row.request_id}>
          <View style={styles.friendRow}><View style={styles.friendAvatar}><Text style={styles.friendAvatarText}>{(row.full_name || 'A').trim().charAt(0).toUpperCase()}</Text></View><View style={{ flex: 1 }}><Text style={styles.rankName}>{row.full_name}</Text><Text style={styles.rankPlace}>{row.city || 'FitCulture athlete'}</Text></View><Text style={styles.friendStatus}>Friends ✓</Text></View>
        </View>
      )) : <Text style={styles.empty}>Accept a request or search for people to add your first friend.</Text>}
    </ScrollView>
  );
}

function NotificationsScreen({ profile, isDemo }) {
  const [preferences, setPreferences] = useState(null);
  const [permission, setPermission] = useState('unknown');
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState('');

  useEffect(() => {
    let active = true;
    Promise.all([getNotificationPreferences(), getNotificationPermissionStatus()]).then(([saved, status]) => {
      if (!active) return;
      setPreferences(saved);
      setPermission(status);
    }).catch(() => {
      if (!active) return;
      setPreferences({ ...defaultNotificationPreferences });
      setPermission('unavailable');
    });
    return () => { active = false; };
  }, []);

  async function updatePreference(key, value) {
    if (!preferences || saving) return;
    const next = { ...preferences, [key]: value };
    setPreferences(next);
    setSaving(true);
    setNotice('');
    try {
      const result = await saveNotificationPreferences(next, profile);
      setPermission(result.granted ? 'granted' : await getNotificationPermissionStatus());
      setNotice(result.granted ? (next.push && result.pushEnabled ? 'Push alerts and your selected reminders are enabled.' : 'Your selected reminders are updated.') : result.disabled ? 'All FitCulture reminders are turned off.' : 'Allow notifications in your phone settings to enable reminders.');
    } catch (error) {
      setNotice(error?.message || 'Could not update notification settings.');
    } finally {
      setSaving(false);
    }
  }

  async function enableDailySet() {
    if (!preferences || saving) return;
    const next = { ...preferences, workout: true, quote: true, water: true };
    setPreferences(next);
    setSaving(true); setNotice('');
    try {
      const result = await saveNotificationPreferences(next, profile);
      setPermission(result.granted ? 'granted' : await getNotificationPermissionStatus());
      setNotice(result.granted ? 'Your daily nudges are set. You can fine-tune each one below.' : 'Allow notifications in your phone settings to schedule daily nudges.');
    } catch (error) { setNotice(error?.message || 'Could not enable daily nudges.'); }
    finally { setSaving(false); }
  }

  if (!preferences) return <ActivityIndicator color={green} style={{ margin: 24 }} />;
  const supported = Platform.OS !== 'web';
  const firstName = profile?.full_name?.trim()?.split(/\s+/)[0] || 'Athlete';

  return (
    <ScrollView showsVerticalScrollIndicator={false}>
      <Text style={styles.sectionTitle}>Your nudges 🔔</Text>
      <Text style={styles.smallCopy}>A little encouragement at the right time. Choose what you want to hear from FitCulture.</Text>
      <View style={styles.card}>
        <Text style={styles.eyebrow}>MADE FOR YOUR ROUTINE</Text>
        <Text style={styles.cardTitle}>A kinder nudge, {firstName}</Text>
        <Text style={styles.smallCopy}>Daily reminders are scheduled on this device. Push alerts can also arrive for workouts, friends, challenges and rewards when FitCulture is closed.</Text>
        {!supported && <Text style={styles.healthMessage}>Phone notifications need the Android/iOS app build; browser notifications are not enabled here.</Text>}
        {supported && permission === 'denied' && <><Text style={styles.healthMessage}>Notifications are blocked in phone settings. Allow FitCulture notifications there, then try again.</Text><Pressable onPress={() => Linking.openSettings()}><Text style={styles.signUp}>Open phone settings</Text></Pressable></>}
        {supported && permission !== 'granted' && <Button title={saving ? 'Setting up…' : 'Enable my daily nudges'} onPress={enableDailySet} disabled={saving} />}
        <Text style={[styles.eyebrow, { marginTop: 17 }]}>PICK YOUR REMINDERS</Text>
        {[
          { key: 'push', title: 'Activity & social alerts', detail: 'Push alerts for saved workouts, friend requests, challenge updates and rewards.', icon: '📣' },
          { key: 'workout', title: 'Move a little', detail: 'A gentle activity reminder, matched to your fitness goal.', timeKey: 'workoutTime', fallback: '18:30', icon: '👟' },
          { key: 'quote', title: 'Daily encouragement', detail: 'A fresh FitCulture quote for each day of the week.', timeKey: 'quoteTime', fallback: '08:30', icon: '✨' },
          { key: 'water', title: 'Midday reset', detail: 'A simple pause to stretch, hydrate and check in.', timeKey: 'waterTime', fallback: '13:00', icon: '💧' }
        ].map(item => (
          <View style={styles.nudgeSetting} key={item.key}>
            <View style={styles.nudgeHeading}>
              <Text style={styles.nudgeIcon}>{item.icon}</Text>
              <View style={{ flex: 1 }}><Text style={styles.nudgeTitle}>{item.title}</Text><Text style={styles.smallCopy}>{item.detail}</Text></View>
              <Switch value={preferences[item.key]} onValueChange={value => updatePreference(item.key, value)} disabled={!supported || saving || (item.key === 'push' && isDemo)} trackColor={{ false: '#335341', true: '#7CB64B' }} thumbColor={preferences[item.key] ? green : '#DCE6DF'} />
            </View>
            {preferences[item.key] && item.timeKey && <View style={styles.nudgeTimeRow}><Text style={styles.nudgeTimeLabel}>TIME</Text><TextInput value={preferences[item.timeKey]} onChangeText={value => setPreferences(current => ({ ...current, [item.timeKey]: value }))} onBlur={() => {
              const time = preferences[item.timeKey];
              if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time || '')) {
                setNotice('Enter a time in 24-hour format, such as 08:30.');
                updatePreference(item.timeKey, item.fallback);
                return;
              }
              updatePreference(item.timeKey, time);
            }} placeholder={item.fallback} placeholderTextColor="#819489" keyboardType="numbers-and-punctuation" maxLength={5} style={styles.nudgeTimeInput} /><Text style={styles.nudgeTimeLabel}>24-hour clock</Text></View>}
          </View>
        ))}
        {!!notice && <Text style={styles.healthMessage}>{notice}</Text>}
        {permission === 'granted' && <Text style={styles.smallCopy}>Notification permission is enabled on this device.</Text>}
      </View>
      <View style={styles.card}>
        <Text style={styles.eyebrow}>A PREVIEW</Text>
        <Text style={styles.cardTitle}>“A small walk still counts.”</Text>
        <Text style={styles.smallCopy}>Messages are designed to encourage—not guilt you. Choose the reminders that fit your day.</Text>
      </View>
      {isDemo && <Text style={styles.empty}>Demo mode can still schedule local device reminders; those preferences are saved on this phone.</Text>}
    </ScrollView>
  );
}

function Rewards({ profile, isDemo, setProfile, refresh }) {
  const [claiming, setClaiming] = useState(false);
  const [items, setItems] = useState([]);
  const [storeError, setStoreError] = useState('');
  const today = new Date().toISOString().slice(0, 10);
  const bonusClaimed = profile?.last_daily_claim === today;

  useEffect(() => {
    if (isDemo) {
      setItems([]);
      setStoreError('Sign in and apply the rewards migration to use the live reward store.');
      return;
    }
    supabase.from('reward_catalog').select('id,name,description,icon,cost').eq('active', true).order('cost')
      .then(({ data, error }) => { setItems(data || []); setStoreError(error?.message || ''); })
      .catch(error => setStoreError(error?.message || 'Could not connect to the reward store.'));
  }, [isDemo]);

  async function claim() {
    setClaiming(true);
    if (isDemo) {
      if (setProfile) {
        setProfile(p => {
          const newXp = (p?.xp || 0) + 25;
          return {
            ...p,
            xp: newXp,
            fitcoins: (p?.fitcoins || 0) + 25,
            last_daily_claim: today,
            level: Math.floor(newXp / 1000) + 1
          };
        });
      }
      setClaiming(false);
      Alert.alert('Bonus claimed!', 'You earned +25 XP and +25 FitCoins.');
      return;
    }

    let error;
    try { ({ error } = await supabase.rpc('claim_daily_bonus')); }
    catch (claimError) { error = claimError; }
    setClaiming(false);
    if (error) {
      Alert.alert('Daily bonus', error.message);
    } else {
      await refresh();
      const { data: { user } = {} } = await supabase.auth.getUser();
      if (user) {
        const { data: bonus } = await supabase.from('reward_transactions').select('id')
          .eq('user_id', user.id).eq('reason', 'Daily bonus').order('created_at', { ascending: false }).limit(1).maybeSingle();
        if (bonus?.id) sendFitCulturePush('daily_bonus', bonus.id);
      }
      Alert.alert('Bonus claimed', 'You earned 25 XP and 25 FitCoins.');
    }
  }

  async function redeem(item) {
    if (isDemo) {
      if ((profile?.fitcoins || 0) < item.cost) {
        Alert.alert('Not enough FitCoins', `You need ${item.cost} FitCoins for this reward.`);
        return;
      }
      setProfile(p => ({ ...p, fitcoins: p.fitcoins - item.cost }));
      Alert.alert('Reward redeemed', `${item.name} was recorded in your demo account.`);
      return;
    }
    let error;
    try { ({ error } = await supabase.rpc('redeem_fitculture_reward', { p_reward_id: item.id })); }
    catch (redeemError) { error = redeemError; }
    if (error) Alert.alert('Could not redeem reward', error.message);
    else {
      await refresh();
      const { data: { user } = {} } = await supabase.auth.getUser();
      if (user) {
        const { data: redemption } = await supabase.from('reward_redemptions').select('id')
          .eq('user_id', user.id).eq('reward_id', item.id).order('created_at', { ascending: false }).limit(1).maybeSingle();
        if (redemption?.id) sendFitCulturePush('reward_redeemed', redemption.id);
      }
      Alert.alert('Reward redeemed', `${item.name} has been added to your redemption history.`);
    }
  }

  return (
    <ScrollView showsVerticalScrollIndicator={false}>
      <View style={styles.rewardHero}>
        <Pill>FITCULTURE REWARDS</Pill>
        <Text style={styles.heroTitle}>Earn every{'\n'}win.</Text>
        <View style={styles.rewardLevel}>
          <Text style={styles.rewardLevelSmall}>LEVEL</Text>
          <Text style={styles.rewardLevelBig}>{profile?.level || 1}</Text>
          <Text style={styles.rewardLevelSmall}>{profile?.fitcoins || 0} FitCoins</Text>
        </View>
      </View>

      <View style={styles.card}>
        <Text style={styles.eyebrow}>ATHLETE PROGRESSION</Text>
        <Text style={styles.cardTitle}>Level {profile?.level || 1} · Momentum</Text>
        <View style={styles.xp}>
          <View style={[styles.xpFill, { width: `${Math.min(100, ((profile?.xp || 0) % 1000) / 10)}%` }]} />
        </View>
        <Text style={styles.smallCopy}>{(profile?.xp || 0) % 1000} / 1,000 XP to next level</Text>
        <Button
          title={bonusClaimed ? 'Daily bonus claimed ✓' : claiming ? 'Claiming…' : 'Claim daily bonus +25 XP / ◈'}
          onPress={claim}
          disabled={claiming || bonusClaimed}
        />
      </View>

      <Text style={styles.sectionTitle}>Reward store</Text>
      <View style={styles.store}>
        {items.map(item => (
          <View style={styles.storeItem} key={item.id}>
            <Text style={styles.storeIcon}>{item.icon}</Text>
            <Text style={styles.storeName}>{item.name}</Text>
            <Text style={styles.smallCopy}>{item.cost} FitCoins</Text>
            <Button
              title="Claim"
              secondary
              onPress={() => redeem(item)}
            />
          </View>
        ))}
        {!items.length && <Text style={styles.empty}>{storeError || 'No rewards are available right now.'}</Text>}
      </View>
    </ScrollView>
  );
}

function Coach({ isDemo, profile, messages: savedMessages, setMessages }) {
  const heightM = Number(profile?.height_cm) / 100;
  const weightKg = Number(profile?.weight_kg);
  const bmi = heightM > 0 && weightKg > 0 ? weightKg / (heightM * heightM) : null;
  const goalLabel = {
    weight_loss: 'Weight loss',
    weight_gain: 'Weight gain',
    maintain_weight: 'Maintain weight',
    general_fitness: 'General fitness'
  }[profile?.goal] || 'General fitness';
  const firstName = profile?.full_name?.trim()?.split(/\s+/)[0] || 'there';
  const [question, setQuestion] = useState('');
  const welcomeMessage = { from: 'ai', text: `Hey ${firstName} 👋 I’m Mira, your FitCulture workout buddy. I’ve got your ${goalLabel.toLowerCase()} goal in mind. What would feel helpful today?` };
  const messages = savedMessages?.length ? savedMessages : [welcomeMessage];
  const [sending, setSending] = useState(false);

  async function send(suggestedQuestion) {
    const q = (typeof suggestedQuestion === 'string' ? suggestedQuestion : question).trim();
    if (!q || sending) return;
    setQuestion('');
    setMessages(m => [...(m?.length ? m : [welcomeMessage]), { from: 'user', text: q }]);
    setSending(true);

    if (isDemo) {
      setTimeout(() => {
        const age = Number(profile?.age);
        const personalContext = `Your profile goal is ${goalLabel}${age ? `, age ${age}` : ''}${bmi ? `, calculated BMI ${bmi.toFixed(1)}` : ''}. `;
        let reply = `${personalContext}Start with 20–30 minutes of comfortable movement, 3 days this week, and increase gradually if it feels good. Include rest and stop if you feel pain, dizziness or unusual shortness of breath.`;
        const lower = q.toLowerCase();
        if (lower.includes('eat') || lower.includes('food') || lower.includes('meal') || lower.includes('protein')) {
          reply = `${personalContext}For food guidance, focus on regular balanced meals and hydration; BMI alone cannot determine your nutrition needs. A registered dietitian can tailor advice to your health and routine.`;
        } else if (lower.includes('run') || lower.includes('5k') || lower.includes('pace')) {
          reply = `${personalContext}Try a relaxed run/walk session: alternate 2 minutes easy jogging with 2 minutes walking for 20 minutes. Keep the effort conversational and build gradually.`;
        } else if (lower.includes('recover') || lower.includes('sleep') || lower.includes('sore')) {
          reply = `${personalContext}Choose a rest day or gentle walk and return gradually when soreness settles. Stop and seek medical advice for severe, sudden or persistent pain.`;
        }
        setMessages(m => [...m, { from: 'ai', text: reply }]);
        setSending(false);
      }, 500);
      return;
    }

    try {
      const history = messages.slice(-10).map(message => ({
        role: message.from === 'ai' ? 'assistant' : 'user',
        content: message.text
      }));
      const answer = await askCoach(q, history);
      setMessages(m => [...m, { from: 'ai', text: answer }]);
    } catch (e) {
      setMessages(m => [
        ...m,
        {
          from: 'ai',
          text: `Coach Mira is unavailable right now (${e.message || 'connection failed'}). Check that the ai-coach Supabase Edge Function is deployed and its provider key is configured.`
        }
      ]);
    } finally {
      setSending(false);
    }
  }

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
      <View style={styles.coachHeader}>
        <Text style={styles.eyebrow}>YOUR AI FITNESS ASSISTANT</Text>
        <Text style={styles.title}>Coach Mira</Text>
        <View style={styles.coachProfileCard}>
          <Text style={styles.coachProfileTitle}>Your coaching profile · {goalLabel}</Text>
          <Text style={styles.coachProfileCopy}>
            Age {profile?.age || '—'} · Height {profile?.height_cm || '—'} cm · Weight {profile?.weight_kg || '—'} kg · BMI {bmi ? bmi.toFixed(1) : '—'}
          </Text>
          <Text style={styles.coachProfileNote}>{Number(profile?.age) < 20 ? 'For under-20s, BMI needs age-and-sex percentile interpretation; this number is not an adult BMI category.' : 'BMI is a screening estimate, not a diagnosis. Coach Mira uses it with your goal and activity history.'}</Text>
          {isDemo && <Text style={styles.coachProfileNote}>Demo mode uses sample coaching; sign in to use your saved profile and AI Coach.</Text>}
        </View>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.coachPrompts}>
        {[
          'Make me a 20-minute workout',
          'Help me stay consistent',
          'How should I recover today?',
          'Review my recent progress'
        ].map(prompt => <Pressable key={prompt} onPress={() => send(prompt)} disabled={sending} style={styles.coachPrompt}><Text style={styles.coachPromptText}>{prompt}</Text></Pressable>)}
      </ScrollView>
      <FlatList
        data={sending ? [...messages, { from: 'ai', typing: true }] : messages}
        keyExtractor={(_, i) => String(i)}
        contentContainerStyle={{ padding: 16, gap: 10 }}
        renderItem={({ item }) => (
          <View style={[styles.bubble, item.from === 'user' && styles.userBubble]}>
            {item.typing ? <View style={styles.typingRow}><ActivityIndicator size="small" color={green} /><Text style={styles.typingText}>Mira is thinking…</Text></View>
              : <Text style={[styles.bubbleText, item.from === 'user' && styles.userBubbleText]}>{item.text}</Text>}
          </View>
        )}
      />
      <View style={styles.chatInput}>
        <TextInput
          value={question}
          onChangeText={setQuestion}
          maxLength={800}
          onSubmitEditing={() => send()}
          placeholder="Ask Coach Mira anything…"
          placeholderTextColor="#82968A"
          style={styles.chatText}
        />
        <Pressable onPress={send} style={styles.send}>
          <Text style={{ color: dark, fontWeight: '800' }}>↑</Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  webWrapper: {
    flex: 1,
    backgroundColor: '#04110C',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: Platform.OS === 'web' ? '100vh' : undefined
  },
  container: {
    flex: 1,
    width: '100%',
    maxWidth: Platform.OS === 'web' ? 460 : undefined,
    backgroundColor: dark,
    overflow: 'hidden',
    borderLeftWidth: Platform.OS === 'web' ? 1 : 0,
    borderRightWidth: Platform.OS === 'web' ? 1 : 0,
    borderColor: '#163826'
  },
  safe: {
    flex: 1,
    backgroundColor: dark,
    paddingTop: Platform.OS === 'android' ? 36 : 0
  },
  center: {
    flex: 1,
    backgroundColor: dark,
    justifyContent: 'center',
    alignItems: 'center'
  },
  login: {
    flex: 1,
    backgroundColor: dark,
    padding: 24
  },
  logo: {
    fontSize: 28,
    fontWeight: '800',
    color: '#fff'
  },
  loginBody: {
    flex: 1,
    justifyContent: 'center'
  },
  loginTitle: {
    fontSize: 42,
    fontWeight: '800',
    lineHeight: 46,
    color: '#fff',
    marginTop: 14
  },
  loginCopy: {
    fontSize: 14,
    color: '#B8CABD',
    lineHeight: 20,
    marginTop: 12
  },
  loginCard: {
    backgroundColor: '#fff',
    borderRadius: 20,
    padding: 20,
    marginTop: 24
  },
  loginCardTitle: {
    fontSize: 19,
    fontWeight: '800',
    color: dark,
    marginTop: 3,
    marginBottom: 8
  },
  formLabel: {
    color: muted,
    fontSize: 9,
    fontWeight: '800',
    letterSpacing: 1,
    marginBottom: 5,
    marginTop: 3
  },
  formRow: {
    flexDirection: 'row',
    gap: 8
  },
  input: {
    borderWidth: 1,
    borderColor: '#DBE5DD',
    borderRadius: 10,
    padding: 13,
    marginBottom: 11,
    color: dark
  },
  signUp: {
    color: '#327A54',
    fontWeight: '700',
    textAlign: 'center'
  },
  divider: {
    flexDirection: 'row',
    alignItems: 'center',
    marginVertical: 14
  },
  dividerLine: {
    flex: 1,
    height: 1,
    backgroundColor: '#E0E7E2'
  },
  dividerText: {
    fontSize: 9,
    fontWeight: '800',
    letterSpacing: 1,
    color: '#7C9184',
    marginHorizontal: 10
  },
  authMethodRow: {
    flexDirection: 'row',
    gap: 8,
    padding: 4,
    backgroundColor: '#EEF3EF',
    borderRadius: 11,
    marginBottom: 13,
    marginTop: 10
  },
  authMethod: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 8,
    paddingVertical: 9
  },
  authMethodSelected: {
    backgroundColor: '#D5F2C0'
  },
  authMethodText: {
    color: '#64776B',
    fontSize: 11,
    fontWeight: '700'
  },
  authMethodTextSelected: {
    color: '#173D28',
    fontWeight: '900'
  },
  phoneHelper: {
    color: '#637B6C',
    fontSize: 10,
    marginTop: -5,
    marginBottom: 10,
    lineHeight: 15
  },
  header: {
    padding: 18,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center'
  },
  headerRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8
  },
  eyebrow: {
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 1.2,
    color: muted
  },
  title: {
    fontSize: 27,
    fontWeight: '800',
    color: '#fff',
    marginTop: 3
  },
  level: {
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: 15,
    backgroundColor: green
  },
  levelText: {
    fontSize: 11,
    fontWeight: '900',
    color: dark
  },
  signOutBtn: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#29543E'
  },
  signOutText: {
    fontSize: 11,
    fontWeight: '700',
    color: '#93B49E'
  },
  bellButton: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#29543E'
  },
  bellText: {
    fontSize: 15
  },
  notificationTime: {
    color: '#fff',
    fontSize: 13
  },
  screen: {
    flex: 1,
    paddingHorizontal: 16
  },
  nav: {
    height: 66,
    backgroundColor: '#0B271B',
    flexDirection: 'row',
    justifyContent: 'space-around',
    borderTopWidth: 1,
    borderColor: '#1C4331'
  },
  navItem: {
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: 0,
    flex: 1
  },
  navIcon: {
    fontSize: 19,
    color: '#8AA193'
  },
  navText: {
    fontSize: 9,
    color: '#8AA193',
    marginTop: 2
  },
  navActive: {
    color: green,
    fontWeight: '800'
  },
  hero: {
    minHeight: 246,
    borderRadius: 20,
    backgroundColor: '#245B42',
    padding: 25,
    overflow: 'hidden'
  },
  heroTitle: {
    fontSize: 38,
    fontWeight: '900',
    lineHeight: 41,
    color: '#fff',
    marginTop: 10
  },
  heroText: {
    fontSize: 13,
    color: '#DBE9DE',
    lineHeight: 19,
    maxWidth: '65%',
    marginVertical: 15
  },
  button: {
    backgroundColor: green,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 10,
    alignItems: 'center',
    marginTop: 10
  },
  buttonText: {
    fontSize: 12,
    fontWeight: '900',
    color: dark
  },
  heroButton: {
    width: '66%',
    alignSelf: 'flex-start'
  },
  secondary: {
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: '#397855'
  },
  secondaryText: {
    color: '#266D43'
  },
  disabled: {
    opacity: 0.6
  },
  heroRing: {
    position: 'absolute',
    right: 16,
    top: 78,
    width: 98,
    height: 98,
    borderWidth: 9,
    borderColor: green,
    borderRightColor: '#5D9C78',
    borderRadius: 100,
    alignItems: 'center',
    justifyContent: 'center'
  },
  ringValue: {
    fontSize: 29,
    fontWeight: '900',
    color: '#fff'
  },
  ringLabel: {
    fontSize: 9,
    color: '#D6E6DC'
  },
  sectionTitle: {
    fontSize: 21,
    fontWeight: '800',
    color: '#fff',
    marginTop: 22,
    marginBottom: 8
  },
  metricRow: {
    flexDirection: 'row',
    gap: 8
  },
  metric: {
    backgroundColor: panel,
    flex: 1,
    borderRadius: 13,
    padding: 12
  },
  metricValue: {
    fontSize: 18,
    fontWeight: '900',
    color: '#fff',
    marginTop: 7
  },
  metricLabel: {
    fontSize: 9,
    color: muted,
    marginTop: 2
  },
  card: {
    backgroundColor: panel,
    borderRadius: 16,
    padding: 16,
    marginTop: 16
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center'
  },
  cardTitle: {
    fontSize: 19,
    fontWeight: '800',
    color: '#fff',
    marginTop: 3
  },
  link: {
    color: green,
    fontWeight: '800',
    fontSize: 11
  },
  quickGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 9,
    marginTop: 15
  },
  quick: {
    width: '47%',
    padding: 13,
    borderRadius: 12
  },
  quickIcon: {
    fontSize: 22
  },
  quickName: {
    color: '#fff',
    fontWeight: '900',
    fontSize: 12,
    marginTop: 6
  },
  coachCard: {
    backgroundColor: '#E4F6DA',
    borderRadius: 16,
    padding: 16,
    marginTop: 16
  },
  coachBadge: {
    height: 30,
    width: 30,
    borderRadius: 16,
    backgroundColor: green,
    textAlign: 'center',
    paddingTop: 7,
    fontWeight: '900',
    color: dark
  },
  coachEyebrow: {
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 1.2,
    color: '#26543A',
    marginTop: 8
  },
  coachCardTitle: {
    fontSize: 19,
    fontWeight: '800',
    color: dark,
    marginTop: 3
  },
  coachCopy: {
    fontSize: 11,
    color: '#244533',
    lineHeight: 16,
    marginTop: 7
  },
  coachLink: {
    color: '#1E6B40',
    fontWeight: '800',
    fontSize: 11,
    marginTop: 10
  },
  smallCopy: {
    fontSize: 11,
    color: muted,
    lineHeight: 16,
    marginTop: 7
  },
  healthMessage: {
    color: green,
    fontSize: 10,
    lineHeight: 15,
    marginTop: 8
  },
  activityInput: {
    borderWidth: 1,
    borderColor: '#397855',
    borderRadius: 10,
    padding: 12,
    marginTop: 12,
    color: '#fff'
  },
  communityInput: {
    borderWidth: 1,
    borderColor: '#397855',
    borderRadius: 10,
    padding: 12,
    marginTop: 11,
    marginBottom: 10,
    color: '#fff',
    backgroundColor: '#0A2419',
    minHeight: 44,
    textAlignVertical: 'top'
  },
  choiceRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 7,
    marginTop: 9
  },
  choice: {
    borderWidth: 1,
    borderColor: '#397855',
    borderRadius: 18,
    paddingHorizontal: 10,
    paddingVertical: 7
  },
  choiceSelected: {
    backgroundColor: green,
    borderColor: green
  },
  choiceText: {
    color: '#D5E5D9',
    fontSize: 10,
    fontWeight: '700'
  },
  choiceTextSelected: {
    color: dark
  },
  friendSearchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8
  },
  friendSearchInput: {
    flex: 1,
    minWidth: 0
  },
  friendSearchButton: {
    backgroundColor: green,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 13,
    marginTop: 1
  },
  friendSearchButtonText: {
    color: dark,
    fontSize: 12,
    fontWeight: '900'
  },
  friendRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#1A3A2A'
  },
  friendCard: {
    backgroundColor: panel,
    borderRadius: 14,
    paddingHorizontal: 14,
    marginTop: 10
  },
  friendAvatar: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#245B42'
  },
  friendAvatarText: {
    color: green,
    fontWeight: '900',
    fontSize: 15
  },
  friendAction: {
    borderWidth: 1,
    borderColor: green,
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: 18
  },
  friendActionText: {
    color: green,
    fontSize: 10,
    fontWeight: '900'
  },
  friendStatus: {
    color: green,
    fontSize: 10,
    fontWeight: '800'
  },
  friendButtons: {
    flexDirection: 'row',
    gap: 8,
    paddingBottom: 12
  },
  friendButton: {
    flex: 1
  },
  activityGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 11,
    marginTop: 13
  },
  activityCard: {
    width: '47%',
    height: 155,
    padding: 15,
    borderRadius: 16
  },
  activityIcon: {
    fontSize: 28
  },
  activityType: {
    fontSize: 8,
    color: '#D7EBDD',
    fontWeight: '800',
    letterSpacing: 1,
    marginTop: 15
  },
  activityName: {
    fontSize: 22,
    color: '#fff',
    fontWeight: '900',
    marginTop: 3
  },
  activityOpen: {
    fontSize: 10,
    color: '#fff',
    fontWeight: '700',
    marginTop: 8
  },
  back: {
    color: green,
    fontWeight: '800',
    fontSize: 12,
    margin: 16
  },
  activityHero: {
    marginHorizontal: 16,
    borderRadius: 18,
    padding: 21,
    minHeight: 246
  },
  detailName: {
    fontSize: 36,
    color: '#fff',
    fontWeight: '900',
    marginTop: 4
  },
  activityDesc: {
    fontSize: 12,
    color: '#E0EFE5',
    lineHeight: 18,
    maxWidth: '64%',
    marginTop: 6
  },
  liveMetric: {
    position: 'absolute',
    right: 18,
    bottom: 17,
    height: 105,
    width: 105,
    borderRadius: 60,
    borderWidth: 7,
    borderColor: green,
    borderRightColor: '#BDE0D0',
    alignItems: 'center',
    justifyContent: 'center'
  },
  liveValue: {
    fontSize: 22,
    fontWeight: '900',
    color: '#fff'
  },
  liveUnit: {
    fontSize: 8,
    color: '#D4E5DB'
  },
  timer: {
    fontSize: 10,
    color: green,
    fontWeight: '800',
    marginTop: 3
  },
  actionRow: {
    paddingHorizontal: 16,
    flexDirection: 'row',
    gap: 8
  },
  actionCol: {
    flex: 1
  },
  scope: {
    flexDirection: 'row',
    marginTop: 15,
    backgroundColor: '#0A2419',
    padding: 3,
    borderRadius: 8
  },
  scopeBtn: {
    flex: 1,
    paddingVertical: 6,
    alignItems: 'center',
    borderRadius: 6
  },
  scopeActive: {
    backgroundColor: '#327A54'
  },
  scopeText: {
    fontSize: 9,
    color: muted
  },
  scopeActiveText: {
    fontSize: 9,
    color: '#fff',
    fontWeight: '800'
  },
  rank: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 11,
    borderBottomWidth: 1,
    borderColor: '#1C4331'
  },
  rankNo: {
    color: green,
    fontWeight: '900',
    width: 32
  },
  rankName: {
    fontSize: 12,
    color: '#fff',
    fontWeight: '700'
  },
  rankPlace: {
    fontSize: 9,
    color: muted,
    marginTop: 2
  },
  rankScore: {
    fontSize: 11,
    color: green,
    fontWeight: '800'
  },
  empty: {
    fontSize: 11,
    color: muted,
    textAlign: 'center',
    paddingVertical: 25
  },
  tournament: {
    margin: 16,
    backgroundColor: '#3B2C26',
    borderRadius: 16,
    padding: 17
  },
  rewardHero: {
    height: 220,
    borderRadius: 18,
    backgroundColor: '#255B43',
    padding: 22,
    overflow: 'hidden'
  },
  rewardLevel: {
    position: 'absolute',
    right: 20,
    bottom: 18,
    width: 110,
    height: 110,
    borderRadius: 60,
    borderWidth: 7,
    borderColor: green,
    borderRightColor: '#629B7C',
    alignItems: 'center',
    justifyContent: 'center'
  },
  rewardLevelSmall: {
    fontSize: 8,
    color: '#D9EADD',
    fontWeight: '800'
  },
  rewardLevelBig: {
    fontSize: 36,
    color: '#fff',
    fontWeight: '900'
  },
  xp: {
    height: 10,
    backgroundColor: '#0A2419',
    borderRadius: 9,
    overflow: 'hidden',
    marginTop: 18
  },
  xpFill: {
    height: '100%',
    backgroundColor: green,
    borderRadius: 9
  },
  homeXp: {
    maxWidth: '65%',
    marginBottom: 8
  },
  homeXpText: {
    color: '#DBE9DE',
    fontSize: 10,
    marginTop: 5
  },
  homeGoals: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 12
  },
  goalCard: {
    flex: 1,
    minWidth: 0,
    backgroundColor: panel,
    borderRadius: 14,
    padding: 13
  },
  goalIcon: {
    fontSize: 16
  },
  goalPercent: {
    color: green,
    fontSize: 11,
    fontWeight: '800'
  },
  goalValue: {
    color: '#fff',
    fontSize: 21,
    fontWeight: '900',
    marginTop: 8
  },
  goalTrack: {
    height: 6,
    backgroundColor: '#193A29',
    borderRadius: 5,
    overflow: 'hidden',
    marginTop: 9
  },
  goalFill: {
    height: '100%',
    backgroundColor: green,
    borderRadius: 5
  },
  challengeIcon: {
    fontSize: 28,
    marginLeft: 10
  },
  recentRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 11,
    paddingVertical: 11,
    borderBottomWidth: 1,
    borderBottomColor: '#1A3A2A'
  },
  recentIcon: {
    width: 34,
    height: 34,
    textAlign: 'center',
    textAlignVertical: 'center',
    overflow: 'hidden',
    borderRadius: 17,
    backgroundColor: '#1A3A2A',
    fontSize: 17,
    paddingTop: 7
  },
  store: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10
  },
  storeItem: {
    width: '47%',
    backgroundColor: panel,
    borderRadius: 14,
    padding: 13
  },
  storeIcon: {
    fontSize: 28
  },
  storeName: {
    fontSize: 14,
    color: '#fff',
    fontWeight: '800',
    marginTop: 9
  },
  coachHeader: {
    paddingHorizontal: 16,
    paddingTop: 8
  },
  coachProfileCard: {
    backgroundColor: panel,
    borderRadius: 13,
    padding: 12,
    marginTop: 10
  },
  coachProfileTitle: {
    color: green,
    fontSize: 11,
    fontWeight: '900'
  },
  coachProfileCopy: {
    color: '#fff',
    fontSize: 11,
    lineHeight: 17,
    marginTop: 6
  },
  coachProfileNote: {
    color: muted,
    fontSize: 9,
    lineHeight: 13,
    marginTop: 5
  },
  coachPrompts: {
    paddingHorizontal: 16,
    paddingTop: 9,
    paddingBottom: 3,
    gap: 8
  },
  coachPrompt: {
    borderWidth: 1,
    borderColor: '#397855',
    borderRadius: 18,
    paddingHorizontal: 11,
    paddingVertical: 8,
    backgroundColor: '#0B271B'
  },
  coachPromptText: {
    color: '#D5E5D9',
    fontSize: 10,
    fontWeight: '700'
  },
  bubble: {
    alignSelf: 'flex-start',
    backgroundColor: panel,
    borderRadius: 13,
    padding: 12,
    maxWidth: '83%'
  },
  userBubble: {
    alignSelf: 'flex-end',
    backgroundColor: '#D7F1BA'
  },
  bubbleText: {
    fontSize: 13,
    color: '#fff',
    lineHeight: 20
  },
  typingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8
  },
  typingText: {
    color: muted,
    fontSize: 11,
    fontStyle: 'italic'
  },
  nudgeSetting: {
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#1A3A2A'
  },
  nudgeHeading: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9
  },
  nudgeIcon: {
    fontSize: 21,
    width: 28
  },
  nudgeTitle: {
    color: '#fff',
    fontWeight: '800',
    fontSize: 13
  },
  nudgeTimeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 8,
    marginLeft: 37
  },
  nudgeTimeLabel: {
    color: muted,
    fontSize: 9,
    fontWeight: '800'
  },
  nudgeTimeInput: {
    width: 72,
    borderWidth: 1,
    borderColor: '#397855',
    borderRadius: 8,
    paddingHorizontal: 9,
    paddingVertical: 6,
    color: '#fff',
    backgroundColor: '#0A2419',
    fontSize: 12,
    textAlign: 'center'
  },
  userBubbleText: {
    color: dark
  },
  chatInput: {
    flexDirection: 'row',
    margin: 12,
    backgroundColor: panel,
    borderRadius: 13,
    padding: 5,
    alignItems: 'center'
  },
  chatText: {
    flex: 1,
    color: '#fff',
    padding: 10,
    fontSize: 12
  },
  send: {
    height: 38,
    width: 38,
    borderRadius: 20,
    backgroundColor: green,
    alignItems: 'center',
    justifyContent: 'center'
  },
  pill: {
    alignSelf: 'flex-start',
    backgroundColor: '#DFF5CC',
    paddingHorizontal: 8,
    paddingVertical: 5,
    borderRadius: 8
  },
  pillText: {
    fontSize: 9,
    fontWeight: '900',
    letterSpacing: 1,
    color: dark
  }
});
