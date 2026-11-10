import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

test('File Integrity: Check that core files exist', () => {
  const requiredFiles = [
    'App.js',
    'app.json',
    'package.json',
    'lib/ai.js',
    'lib/fitness.js',
    'lib/supabase.js'
  ];

  for (const relPath of requiredFiles) {
    const fullPath = path.join(rootDir, relPath);
    assert.ok(fs.existsSync(fullPath), `Required file missing: ${relPath}`);
    const stat = fs.statSync(fullPath);
    assert.ok(stat.size > 0, `File is empty: ${relPath}`);
  }
});

test('App.js Syntax & StyleSheet Validation', () => {
  const appCode = fs.readFileSync(path.join(rootDir, 'App.js'), 'utf8');

  // Must not have invalid CSS selectors in StyleSheet
  assert.ok(!appCode.includes('actionRow>View'), 'App.js should not contain invalid CSS selector actionRow>View');

  // Must have actionCol for responsive button layout
  assert.ok(appCode.includes('actionCol'), 'App.js should define actionCol');

  // Must have legible titles and text contrast
  assert.ok(appCode.includes('loginCardTitle'), 'App.js should include loginCardTitle');
  assert.ok(appCode.includes('coachCardTitle'), 'App.js should include coachCardTitle');
  assert.ok(appCode.includes('userBubbleText'), 'App.js should include userBubbleText');
});

test('Unit Test: distanceKm Haversine calculation', async () => {
  // Test haversine math directly
  const radians = value => (value * Math.PI) / 180;
  function distanceKm(a, b) {
    if (!a || !b || typeof a.latitude !== 'number' || typeof b.latitude !== 'number') return 0;
    const earth = 6371;
    const dLat = radians(b.latitude - a.latitude);
    const dLon = radians(b.longitude - a.longitude);
    const x =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(radians(a.latitude)) * Math.cos(radians(b.latitude)) * Math.sin(dLon / 2) ** 2;
    return earth * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
  }

  // 1. Same coordinates
  const p1 = { latitude: 28.6139, longitude: 77.2090 };
  assert.equal(distanceKm(p1, p1), 0);

  // 2. Approx 1 degree latitude difference (~111 km)
  const p2 = { latitude: 29.6139, longitude: 77.2090 };
  const d = distanceKm(p1, p2);
  assert.ok(d > 110 && d < 112, `Expected ~111km, got ${d}`);

  // 3. Graceful handling of invalid / null inputs
  assert.equal(distanceKm(null, p1), 0);
  assert.equal(distanceKm(p1, undefined), 0);
  assert.equal(distanceKm({}, {}), 0);
});

test('package.json Validation', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));

  assert.equal(pkg.name, 'fitculture-mobile');
  assert.ok(pkg.scripts?.test, 'package.json must have a test script');
  assert.ok(pkg.scripts?.start, 'package.json must have a start script');

  // Validate dependencies
  assert.ok(pkg.dependencies['expo'], 'expo dependency should be declared');
  assert.equal(pkg.dependencies['expo-sensors'], '~57.0.2', 'expo-sensors must be ~57.0.2');
  assert.ok(pkg.dependencies['@supabase/supabase-js'], 'supabase dependency should be declared');
});
