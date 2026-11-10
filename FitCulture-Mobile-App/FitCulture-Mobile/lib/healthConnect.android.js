import {
  aggregateRecord,
  ExerciseType,
  getGrantedPermissions,
  getSdkStatus,
  initialize,
  insertRecords,
  readRecords,
  requestPermission,
  SdkAvailabilityStatus
} from 'react-native-health-connect';

const permissionList = [
  { accessType: 'read', recordType: 'Steps' },
  { accessType: 'write', recordType: 'Steps' },
  { accessType: 'read', recordType: 'ExerciseSession' },
  { accessType: 'write', recordType: 'ExerciseSession' },
  { accessType: 'write', recordType: 'ExerciseRoute' },
  { accessType: 'read', recordType: 'Distance' },
  { accessType: 'write', recordType: 'Distance' },
  { accessType: 'read', recordType: 'ActiveCaloriesBurned' },
  { accessType: 'write', recordType: 'ActiveCaloriesBurned' }
];

const ownPackage = 'com.yourname.fitculture';

const activityForExerciseType = new Map([
  [ExerciseType.RUNNING, 'Running'],
  [ExerciseType.RUNNING_TREADMILL, 'Running'],
  [ExerciseType.BIKING, 'Cycling'],
  [ExerciseType.BIKING_STATIONARY, 'Cycling'],
  [ExerciseType.SWIMMING_POOL, 'Swimming'],
  [ExerciseType.SWIMMING_OPEN_WATER, 'Swimming'],
  [ExerciseType.YOGA, 'Yoga'],
  [ExerciseType.STRENGTH_TRAINING, 'Strength'],
  [ExerciseType.WEIGHTLIFTING, 'Strength']
]);

function localDayBounds(date = new Date()) {
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  const end = new Date(date);
  end.setHours(23, 59, 59, 999);
  const dayKey = [start.getFullYear(), String(start.getMonth() + 1).padStart(2, '0'), String(start.getDate()).padStart(2, '0')].join('-');
  return { start, end, dayKey };
}

function overlaps(record, session) {
  return new Date(record.startTime) < new Date(session.endTime) && new Date(record.endTime) > new Date(session.startTime);
}

async function initializeHealthConnect() {
  const status = await getSdkStatus();
  if (status === SdkAvailabilityStatus.SDK_UNAVAILABLE) {
    throw new Error('Health Connect is not available on this Android device.');
  }
  if (status === SdkAvailabilityStatus.SDK_UNAVAILABLE_PROVIDER_UPDATE_REQUIRED) {
    throw new Error('Install or update Health Connect, then try again.');
  }
  const ready = await initialize();
  if (!ready) throw new Error('Could not initialize Health Connect.');
}

export async function connectAndSyncHealthConnect(supabase) {
  await initializeHealthConnect();
  await requestPermission(permissionList);
  const granted = await getGrantedPermissions();
  const canReadSteps = granted.some(p => p.accessType === 'read' && p.recordType === 'Steps');
  const canReadWorkouts = granted.some(p => p.accessType === 'read' && p.recordType === 'ExerciseSession');
  let syncedSteps = null;
  let imported = 0;
  const now = new Date();

  if (canReadSteps) {
    const { start, end, dayKey } = localDayBounds(now);
    const totals = await aggregateRecord({
      recordType: 'Steps',
      timeRangeFilter: { operator: 'between', startTime: start.toISOString(), endTime: end.toISOString() }
    });
    syncedSteps = Math.max(0, Math.round(totals.COUNT_TOTAL || 0));
    if (syncedSteps > 0) {
      const { error } = await supabase.rpc('sync_health_connect_activity', {
        p_external_record_id: `steps:${dayKey}`,
        p_activity_type: 'Steps',
        p_distance_km: null,
        p_steps: syncedSteps,
        p_duration_seconds: 0,
        p_calories: null,
        p_started_at: start.toISOString()
      });
      if (error) throw error;
    }
  }

  if (canReadWorkouts) {
    const start = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const range = { operator: 'between', startTime: start.toISOString(), endTime: now.toISOString() };
    const [sessionsResult, distancesResult, caloriesResult] = await Promise.all([
      readRecords('ExerciseSession', { timeRangeFilter: range }),
      granted.some(p => p.accessType === 'read' && p.recordType === 'Distance')
        ? readRecords('Distance', { timeRangeFilter: range })
        : Promise.resolve({ records: [] }),
      granted.some(p => p.accessType === 'read' && p.recordType === 'ActiveCaloriesBurned')
        ? readRecords('ActiveCaloriesBurned', { timeRangeFilter: range })
        : Promise.resolve({ records: [] })
    ]);

    for (const session of sessionsResult.records) {
      const activityType = activityForExerciseType.get(session.exerciseType);
      const externalId = session.metadata?.id;
      if (!activityType || !externalId || session.metadata?.dataOrigin === ownPackage) continue;
      const source = session.metadata?.dataOrigin;
      const distanceMeters = distancesResult.records
        .filter(record => overlaps(record, session) && (!source || record.metadata?.dataOrigin === source))
        .reduce((sum, record) => sum + (record.distance?.inMeters || 0), 0);
      const calories = caloriesResult.records
        .filter(record => overlaps(record, session) && (!source || record.metadata?.dataOrigin === source))
        .reduce((sum, record) => sum + (record.energy?.inKilocalories || 0), 0);
      const { data, error } = await supabase.rpc('sync_health_connect_activity', {
        p_external_record_id: externalId,
        p_activity_type: activityType,
        p_distance_km: distanceMeters > 0 ? Number((distanceMeters / 1000).toFixed(3)) : null,
        p_steps: null,
        p_duration_seconds: Math.max(0, Math.round((new Date(session.endTime) - new Date(session.startTime)) / 1000)),
        p_calories: calories > 0 ? Math.round(calories) : null,
        p_started_at: session.startTime
      });
      if (error) throw error;
      if (data === true) imported += 1;
    }
  }

  if (!canReadSteps && !canReadWorkouts) {
    throw new Error('Allow at least Steps or Exercise sessions in the Health Connect permission screen.');
  }
  return { imported, steps: syncedSteps };
}

export async function writeWorkoutToHealthConnect({ activityType, startedAt, endedAt, distanceKm, steps, calories, route = [] }) {
  await initializeHealthConnect();
  const granted = await getGrantedPermissions();
  const has = (accessType, recordType) => granted.some(p => p.accessType === accessType && p.recordType === recordType);
  const startTime = new Date(startedAt).toISOString();
  const endTime = new Date(endedAt).toISOString();
  const duration = (new Date(endTime) - new Date(startTime)) / 1000;
  const exerciseType = {
    Running: ExerciseType.RUNNING,
    Cycling: ExerciseType.BIKING,
    Swimming: ExerciseType.SWIMMING_POOL,
    Yoga: ExerciseType.YOGA,
    Strength: ExerciseType.STRENGTH_TRAINING
  }[activityType];
  const records = [];

  if (has('write', 'ExerciseSession') && exerciseType != null && duration > 0) {
    const session = {
      recordType: 'ExerciseSession',
      exerciseType,
      title: `FitCulture ${activityType}`,
      startTime,
      endTime,
      metadata: { clientRecordId: `fitculture:${startTime}:${activityType}`, clientRecordVersion: 1 }
    };
    if (has('write', 'ExerciseRoute') && route.length > 1) {
      session.exerciseRoute = {
        route: route.map(point => ({
          time: new Date(point.timestamp || Date.now()).toISOString(),
          latitude: point.latitude,
          longitude: point.longitude,
          ...(Number.isFinite(point.accuracy) ? { horizontalAccuracy: { value: point.accuracy, unit: 'meters' } } : {})
        }))
      };
    }
    records.push(session);
  }
  if (has('write', 'Distance') && Number(distanceKm) > 0) {
    records.push({
      recordType: 'Distance',
      distance: { value: Number(distanceKm), unit: 'kilometers' },
      startTime,
      endTime,
      metadata: { clientRecordId: `fitculture:distance:${startTime}:${activityType}`, clientRecordVersion: 1 }
    });
  }
  if (has('write', 'Steps') && activityType === 'Steps' && Number(steps) > 0) {
    records.push({
      recordType: 'Steps',
      count: Math.round(Number(steps)),
      startTime,
      endTime,
      metadata: { clientRecordId: `fitculture:steps:${startTime}`, clientRecordVersion: 1 }
    });
  }
  if (has('write', 'ActiveCaloriesBurned') && Number(calories) > 0) {
    records.push({
      recordType: 'ActiveCaloriesBurned',
      energy: { value: Math.round(Number(calories)), unit: 'kilocalories' },
      startTime,
      endTime,
      metadata: { clientRecordId: `fitculture:calories:${startTime}:${activityType}`, clientRecordVersion: 1 }
    });
  }

  if (records.length) await insertRecords(records);
  return records.length;
}

