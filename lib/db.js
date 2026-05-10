const fs = require('fs');
const path = require('path');

const EMPTY_DB = {
  members: [],
  activities: [],
  penalties: [],
  subscriptions: [],
  exemptions: [],
  settings: {}
};

const DEFAULT_SETTINGS = {
  challengeName: 'SM러닝크루',
  challengeStart: '2026-04-19',
  firstWeekEnd: '2026-04-26',
  challengeEnd: null,
  requiredKm: 20,
  penaltyAmount: 100000
};

const isVercel = !!process.env.VERCEL;
const LOCAL_DB_PATH = isVercel
  ? path.join('/tmp', 'data.json')
  : path.join(__dirname, '..', 'data.json');

const redisUrl = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const redisToken = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const useRedis = !!(redisUrl && redisToken);

let redis = null;
if (useRedis) {
  try {
    const { Redis } = require('@upstash/redis');
    redis = new Redis({ url: redisUrl, token: redisToken });
  } catch (e) {
    console.error('[DB] Redis init error:', e.message);
  }
}

function ensureDBFields(data) {
  if (!data.members) data.members = [];
  if (!data.activities) data.activities = [];
  if (!data.penalties) data.penalties = [];
  if (!data.subscriptions) data.subscriptions = [];
  if (!data.exemptions) data.exemptions = [];
  if (!data.settings) data.settings = {};
  return data;
}

function loadLocal() {
  try {
    if (fs.existsSync(LOCAL_DB_PATH)) {
      return ensureDBFields(JSON.parse(fs.readFileSync(LOCAL_DB_PATH, 'utf8')));
    }
  } catch (e) { console.error('Local DB read error:', e.message); }
  return { ...EMPTY_DB };
}

function saveLocal(data) {
  fs.writeFileSync(LOCAL_DB_PATH, JSON.stringify(data, null, 2), 'utf8');
}

async function loadFromRedis() {
  // 1순위: 메인 키에 멤버가 1명 이상 있어야 "정상"
  // 2순위: 메인이 비어있으면 백업에서 자동 복구
  for (const key of ['running-tracker', 'running-tracker-backup']) {
    try {
      const data = await redis.get(key);
      const hasRealData = data && Array.isArray(data.members) && data.members.length > 0;
      if (hasRealData) {
        ensureDBFields(data);
        if (key === 'running-tracker-backup') {
          console.log(`[DB] Restored from backup: ${data.members.length} members`);
          try { await redis.set('running-tracker', data); } catch(e) {}
        }
        return data;
      }
      if (key === 'running-tracker' && data && Array.isArray(data.members)) {
        console.warn('[DB] Main key empty — falling through to backup');
      }
    } catch (e) {
      console.error(`[DB] Redis load error (${key}):`, e.message);
    }
  }
  return null;
}

async function loadDB() {
  if (redis) {
    const data = await loadFromRedis();
    if (data) return data;
    return { ...EMPTY_DB };
  }
  return loadLocal();
}

async function saveDB(data) {
  if (!data) return;
  ensureDBFields(data);

  if (redis) {
    // 빈 멤버 데이터 저장 방지 (강화 버전)
    if (data.members.length === 0) {
      let existing = null;
      let lookupFailed = false;
      try {
        const main = await redis.get('running-tracker');
        const backup = await redis.get('running-tracker-backup');
        if (main && Array.isArray(main.members) && main.members.length > 0) existing = main;
        else if (backup && Array.isArray(backup.members) && backup.members.length > 0) existing = backup;
      } catch (e) {
        lookupFailed = true;
        console.error('[DB] Empty-write safeguard lookup failed:', e.message);
      }
      if (existing) {
        console.error(`[DB] BLOCKED: refusing to overwrite ${existing.members.length} members with empty data`);
        return;
      }
      if (lookupFailed) {
        console.error('[DB] BLOCKED: empty save while Redis lookup failing');
        return;
      }
    }
    try {
      if (data.members.length > 0) {
        await redis.set('running-tracker-backup', data);
      }
      await redis.set('running-tracker', data);
    } catch (e) {
      console.error('[DB] Redis save error:', e.message);
    }
  } else {
    saveLocal(data);
  }
}

module.exports = { loadDB, saveDB, DEFAULT_SETTINGS };
