import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { ...corsHeaders, 'Content-Type': 'application/json' },
});

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (request.method !== 'POST') return response({ error: 'Method not allowed' }, 405);

  const authorization = request.headers.get('Authorization');
  if (!authorization) return response({ error: 'Sign in required' }, 401);

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const userClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authorization } } });
  const admin = createClient(supabaseUrl, serviceRoleKey);
  const { data: { user }, error: authError } = await userClient.auth.getUser();
  if (authError || !user) return response({ error: 'Invalid session' }, 401);

  let payload: { event?: string; eventId?: string; dayStart?: string };
  try { payload = await request.json(); } catch { return response({ error: 'Invalid JSON' }, 400); }
  const event = payload.event;
  const eventId = payload.eventId;
  if (!event || !eventId) return response({ error: 'event and eventId are required' }, 400);

  let recipientId = user.id;
  let title = 'FitCulture';
  let body = 'A little progress is still progress. Keep showing up for yourself.';
  let route = 'Home';

  if (event === 'activity_completed') {
    const { data } = await admin.from('activity_sessions').select('id,activity_type,user_id')
      .eq('id', eventId).eq('user_id', user.id).maybeSingle();
    if (!data) return response({ error: 'Activity not found for this account' }, 403);
    title = 'Workout saved 👟';
    body = `Your ${data.activity_type.toLowerCase()} session is in. Nice work showing up!`;
    route = 'Activities';
    const parsedDayStart = payload.dayStart ? new Date(payload.dayStart) : new Date();
    if (Number.isNaN(parsedDayStart.getTime()) || parsedDayStart.getTime() > Date.now() || parsedDayStart.getTime() < Date.now() - 24 * 60 * 60 * 1000) {
      return response({ error: 'Invalid activity day' }, 400);
    }
    const { data: todaySessions } = await admin.from('activity_sessions').select('steps,distance_km,duration_seconds')
      .eq('user_id', user.id).eq('activity_type', data.activity_type).gte('created_at', parsedDayStart.toISOString());
    const totals = (todaySessions || []).reduce((sum, row) => sum + (data.activity_type === 'Steps'
      ? Number(row.steps || 0)
      : ['Running', 'Cycling', 'Swimming'].includes(data.activity_type)
        ? Number(row.distance_km || 0)
        : Number(row.duration_seconds || 0) / 60), 0);
    const goals: Record<string, number> = { Steps: 8500, Running: 5, Cycling: 20, Swimming: 1, Yoga: 30, Strength: 45 };
    const goal = goals[data.activity_type] || 0;
    if (goal && totals >= goal) {
      title = 'Daily target complete 🎉';
      body = `You hit your ${goal.toLocaleString()} ${data.activity_type === 'Steps' ? 'steps' : ['Yoga', 'Strength'].includes(data.activity_type) ? 'minutes' : 'km'} target. Celebrate this win!`;
      route = 'Home';
    } else if (goal) {
      const remaining = Math.max(0, Math.ceil(goal - totals));
      const unit = data.activity_type === 'Steps' ? 'steps' : ['Yoga', 'Strength'].includes(data.activity_type) ? 'min' : 'km';
      const left = ['Running', 'Cycling', 'Swimming'].includes(data.activity_type) ? remaining.toFixed(1) : remaining.toLocaleString();
      title = 'You’re making progress 💪';
      body = `${left} ${unit} left to reach today’s ${data.activity_type.toLowerCase()} target. Every bit counts.`;
      route = 'Home';
    }
  } else if (event === 'friend_request') {
    const { data } = await admin.from('friend_requests').select('id,requester_id,recipient_id,status')
      .eq('id', eventId).eq('requester_id', user.id).eq('status', 'pending').maybeSingle();
    if (!data) return response({ error: 'Friend request not found for this account' }, 403);
    recipientId = data.recipient_id;
    title = 'New FitCulture friend request 🤝';
    body = 'Someone wants to train and celebrate progress with you.';
    route = 'Friends';
  } else if (event === 'friend_accepted') {
    const { data } = await admin.from('friend_requests').select('id,requester_id,recipient_id,status')
      .eq('id', eventId).eq('recipient_id', user.id).eq('status', 'accepted').maybeSingle();
    if (!data) return response({ error: 'Accepted friend request not found for this account' }, 403);
    recipientId = data.requester_id;
    title = 'Friend request accepted 🎉';
    body = 'You have a new FitCulture friend. Cheer each other on!';
    route = 'Friends';
  } else if (event === 'challenge_joined') {
    const { data } = await admin.from('tournament_entries').select('tournament_id,user_id,tournaments!inner(id,title,created_by)')
      .eq('tournament_id', eventId).eq('user_id', user.id).maybeSingle();
    const ownerId = (data?.tournaments as { created_by?: string | null } | null)?.created_by;
    if (!data || !ownerId || ownerId === user.id) return response({ error: 'Challenge join not found for this account' }, 403);
    recipientId = ownerId;
    title = 'A new athlete joined your challenge 🏁';
    body = `Someone joined ${(data.tournaments as { title?: string }).title || 'your challenge'}.`;
    route = 'Challenges';
  } else if (event === 'challenge_created') {
    const { data } = await admin.from('tournaments').select('id,title,created_by').eq('id', eventId).eq('created_by', user.id).maybeSingle();
    if (!data) return response({ error: 'Challenge not found for this account' }, 403);
    title = 'Your challenge is live 🏁';
    body = `${data.title} is ready. Invite friends and get moving!`;
    route = 'Challenges';
  } else if (event === 'community_created') {
    const { data } = await admin.from('communities').select('id,name,created_by').eq('id', eventId).eq('created_by', user.id).maybeSingle();
    if (!data) return response({ error: 'Community not found for this account' }, 403);
    title = 'Your FitCulture community is live 👥';
    body = `${data.name} is ready. Invite people to build healthy habits together!`;
    route = 'Community';
  } else if (event === 'community_joined') {
    const { data } = await admin.from('community_members').select('community_id,user_id,communities!inner(id,name,created_by)')
      .eq('community_id', eventId).eq('user_id', user.id).maybeSingle();
    const ownerId = (data?.communities as { created_by?: string | null } | null)?.created_by;
    if (!data || !ownerId || ownerId === user.id) return response({ error: 'Community join not found for this account' }, 403);
    recipientId = ownerId;
    title = 'A new athlete joined your community 👋';
    body = `Someone joined ${(data.communities as { name?: string }).name || 'your community'}.`;
    route = 'Community';
  } else if (event === 'reward_claimed') {
    const { data } = await admin.from('tournament_entries').select('tournament_id,user_id,reward_claimed_at,tournaments!inner(title,reward_xp,reward_coins)')
      .eq('tournament_id', eventId).eq('user_id', user.id).not('reward_claimed_at', 'is', null).maybeSingle();
    if (!data) return response({ error: 'Claimed reward not found for this account' }, 403);
    const challenge = data.tournaments as { title?: string; reward_xp?: number; reward_coins?: number };
    title = 'Challenge reward unlocked 🏆';
    body = `You claimed ${challenge.reward_xp || 0} XP and ${challenge.reward_coins || 0} FitCoins for ${challenge.title || 'your challenge'}.`;
    route = 'Rewards';
  } else if (event === 'daily_bonus') {
    const { data } = await admin.from('reward_transactions').select('id,xp_delta,coin_delta,user_id,reason')
      .eq('id', eventId).eq('user_id', user.id).eq('reason', 'Daily bonus').maybeSingle();
    if (!data) return response({ error: 'Daily bonus not found for this account' }, 403);
    title = 'Your daily bonus is ready 🎁';
    body = `You earned ${data.xp_delta} XP and ${data.coin_delta} FitCoins. Come back tomorrow for another!`;
    route = 'Rewards';
  } else if (event === 'reward_redeemed') {
    const { data } = await admin.from('reward_redemptions').select('id,user_id,reward_catalog!inner(name)')
      .eq('id', eventId).eq('user_id', user.id).maybeSingle();
    if (!data) return response({ error: 'Reward redemption not found for this account' }, 403);
    title = 'Reward redeemed 🎁';
    body = `${(data.reward_catalog as { name?: string }).name || 'Your reward'} is in your redemption history.`;
    route = 'Rewards';
  } else {
    return response({ error: 'Unsupported notification event' }, 400);
  }

  const { data: devices, error: deviceError } = await admin.from('push_devices')
    .select('expo_push_token').eq('user_id', recipientId);
  if (deviceError) return response({ error: 'Could not load notification devices' }, 500);
  if (!devices?.length) return response({ sent: 0, reason: 'No opted-in device' });

  const { data: dispatch, error: dispatchError } = await admin.from('push_notification_events')
    .upsert({ actor_id: user.id, event_type: event, event_id: eventId }, {
      onConflict: 'actor_id,event_type,event_id', ignoreDuplicates: true,
    }).select('id').maybeSingle();
  if (dispatchError) return response({ error: 'Could not record notification event' }, 500);
  if (!dispatch) return response({ sent: 0, reason: 'Event already notified' });

  const messages = devices.map(({ expo_push_token }) => ({
    to: expo_push_token,
    title,
    body,
    sound: 'default',
    channelId: 'fitculture-nudges',
    data: { app: 'FitCulture', route, event },
  }));
  const expoResponse = await fetch('https://exp.host/--/api/v2/push/send', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Accept-encoding': 'gzip, deflate', 'Content-Type': 'application/json' },
    body: JSON.stringify(messages),
  });
  const expoResult = await expoResponse.json().catch(() => ({}));
  if (!expoResponse.ok) {
    await admin.from('push_notification_events').delete().eq('id', dispatch.id);
    return response({ error: 'Expo push service rejected the message', details: expoResult }, 502);
  }
  const tickets = Array.isArray(expoResult?.data) ? expoResult.data : [expoResult?.data];
  const invalidTokens = tickets.flatMap((ticket: { status?: string; details?: { error?: string } }, index: number) =>
    ticket?.details?.error === 'DeviceNotRegistered' ? [devices[index]?.expo_push_token].filter(Boolean) : []);
  if (invalidTokens.length) {
    await admin.from('push_devices').delete().in('expo_push_token', invalidTokens);
  }
  return response({ sent: messages.length, result: expoResult });
});
