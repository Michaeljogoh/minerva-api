/**
 * Probe whether this Steel account supports Profiles and the Credentials API.
 *
 * Usage (from api/):
 *   node --env-file=.env scripts/probe-steel-features.mjs
 *
 * Creates one short session with persistProfile, releases it, reuses the
 * profile once, and creates + deletes a throwaway credential. Cleans up after
 * itself. Exit code 1 if any feature is unavailable.
 */
import Steel from 'steel-sdk';

const apiKey = process.env.STEEL_API_KEY?.trim();
if (!apiKey) {
  console.error('FAIL: STEEL_API_KEY is not set.');
  process.exit(1);
}

const client = new Steel({ steelAPIKey: apiKey });
const results = {};

function errText(err) {
  return `${err?.status ?? ''} ${err?.message ?? err}`.trim();
}

async function probeProfiles() {
  let first;
  let second;
  try {
    first = await client.sessions.create({ persistProfile: true, timeout: 60_000 });
    console.log(`profiles: session ${first.id} created, profileId=${first.profileId ?? '(none yet)'}`);
    await client.sessions.release(first.id);

    // The profile is uploaded after release; give it a moment to reach READY.
    let profileId = first.profileId;
    if (!profileId) {
      throw new Error('session did not return a profileId');
    }
    let status = '';
    for (let i = 0; i < 10; i++) {
      const profile = await client.profiles.get(profileId);
      status = profile.status ?? '';
      if (status === 'READY' || status === 'FAILED') break;
      await new Promise((r) => setTimeout(r, 2000));
    }
    console.log(`profiles: profile ${profileId} status=${status}`);
    if (status !== 'READY') {
      throw new Error(`profile did not reach READY (status=${status})`);
    }

    second = await client.sessions.create({ profileId, timeout: 60_000 });
    console.log(`profiles: reuse session ${second.id} created`);
    await client.sessions.release(second.id);
    results.profiles = { ok: true };
  } catch (err) {
    results.profiles = { ok: false, error: errText(err) };
    for (const s of [first, second]) {
      if (s?.id) await client.sessions.release(s.id).catch(() => {});
    }
  }
}

async function probeCredentials() {
  const origin = 'https://probe.minerva.invalid';
  const namespace = 'minerva-probe';
  try {
    await client.credentials.create({
      origin,
      namespace,
      label: 'minerva probe (safe to delete)',
      value: { username: 'probe', password: 'probe-not-a-real-password' },
    });
    const list = await client.credentials.list({ namespace });
    console.log(`credentials: created, list returned ${list.credentials?.length ?? 0} item(s)`);
    results.credentials = { ok: true };
  } catch (err) {
    results.credentials = { ok: false, error: errText(err) };
  } finally {
    await client.credentials.delete({ origin, namespace }).catch(() => {});
  }
}

await probeProfiles();
await probeCredentials();

console.log('\nRESULT', JSON.stringify(results, null, 2));
process.exit(Object.values(results).every((r) => r.ok) ? 0 : 1);
