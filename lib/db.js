const fs = require('fs');
const path = require('path');

const EMPTY_DB = {
  members: [],
  activities: [],
  penalties: [],
  subscriptions: [],
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
  for (const key of ['running-tracker', 'running-tracker-backup']) {
    try {
      const data = await redis.get(key);
      if (data && data.members && Array.isArray(data.members)) {
        ensureDBFields(data);
        if (key === 'running-tracker-backup') {
          console.log(`[DB] Restored from backup: ${data.members.length} members`);
          try { await redis.set('running-tracker', data); } catch(e) {}
        }
        return data;
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
    if (data.members.length === 0) {
      try {
        const existing = await loadFromRedis();
        if (existing && existing.members && existing.members.length > 0) {
          console.error(`[DB] BLOCKED: refusing to overwrite ${existing.members.length} members with empty data`);
          return;
        }
      } catch(e) {}
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
