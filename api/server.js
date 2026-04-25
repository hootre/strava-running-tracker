const express = require('express');
const axios = require('axios');
const { loadDB, saveDB, DEFAULT_SETTINGS } = require('../lib/db');
const { exchangeToken, refreshAccessToken, getActivities } = require('../lib/strava');

const app = express();
app.use(express.json());

// ============================================================
// 보안 확인
// ============================================================
if (!process.env.ADMIN_PASSWORD) {
  console.warn('[SECURITY] ADMIN_PASSWORD 환경변수가 설정되지 않았습니다!');
}

// CORS
app.use((req, res, next) => {
  const origin = req.headers.origin;
  const baseUrl = process.env.BASE_URL || '';
  const vercelUrl = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : '';
  const allowedOrigins = [baseUrl, vercelUrl, 'http://localhost:3000', 'http://localhost:3001'].filter(Boolean);
  const isAllowed = !origin
    || allowedOrigins.some(o => origin === o || origin.startsWith(o))
    || !process.env.VERCEL;
  if (isAllowed) res.header('Access-Control-Allow-Origin', origin || '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ============================================================
// web-push 초기화 (VAPID 키가 설정된 경우에만)
// ============================================================
let webpush = null;
if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  try {
    webpush = require('web-push');
    webpush.setVapidDetails(
      process.env.VAPID_EMAIL || 'mailto:admin@example.com',
      process.env.VAPID_PUBLIC_KEY,
      process.env.VAPID_PRIVATE_KEY
    );
    console.log('[Push] web-push 초기화 완료');
  } catch (e) {
    console.error('[Push] web-push 초기화 실패:', e.message);
  }
}

// ============================================================
// 헬퍼 함수
// ============================================================
function getBaseUrl() {
  return process.env.BASE_URL || `https://${process.env.VERCEL_URL}` || 'http://localhost:3000';
}

const isRun = (a) =>
  a.type === 'Run' || a.type === 'running' ||
  a.sport_type === 'Run' || a.sport_type === 'running';

function getSettings(db) {
  return { ...DEFAULT_SETTINGS, ...(db.settings || {}) };
}

// 서버 사이드 현재 주 시작일 계산
function getCurrentWeekStartServer(date, settings) {
  const d = new Date(date);
  const dateStr = d.toISOString().split('T')[0];
  if (dateStr >= settings.challengeStart && dateStr <= settings.firstWeekEnd) {
    return settings.challengeStart;
  }
  const day = d.getDay();
  const diff = day === 0 ? 6 : day - 1;
  const monday = new Date(d);
  monday.setDate(d.getDate() - diff);
  return monday.toISOString().split('T')[0];
}

// ============================================================
// 주간 범위 계산 (동적 설정 기반)
// ============================================================
function getWeekRanges(settings) {
  const ranges = [];
  ranges.push({ start: settings.challengeStart, end: settings.firstWeekEnd });

  // firstWeekEnd 다음날부터 첫 번째 월요일 찾기
  let cur = new Date(settings.firstWeekEnd + 'T00:00:00');
  cur.setDate(cur.getDate() + 1);
  while (cur.getDay() !== 1) cur.setDate(cur.getDate() + 1);

  const today = new Date();
  today.setHours(23, 59, 59, 999);
  const challengeEnd = settings.challengeEnd
    ? new Date(settings.challengeEnd + 'T23:59:59')
    : null;
  const cutoff = challengeEnd && challengeEnd < today ? challengeEnd : today;

  while (cur <= cutoff) {
    const start = cur.toISOString().split('T')[0];
    const end = new Date(cur);
    end.setDate(cur.getDate() + 6);
    ranges.push({ start, end: end.toISOString().split('T')[0] });
    cur.setDate(cur.getDate() + 7);
  }
  return ranges;
}

// ============================================================
// 벌금 계산 (동적 설정 기반)
// ============================================================
function calculatePenalties(db, settings) {
  const s = settings || getSettings(db);
  const newPenalties = [];
  const weekRanges = getWeekRanges(s);

  for (const member of db.members) {
    const memberRuns = db.activities.filter(a => a.strava_id === member.strava_id && isRun(a));
    for (const week of weekRanges) {
      const weekRunsData = memberRuns.filter(a => {
        const d = a.start_date_local.split('T')[0];
        return d >= week.start && d <= week.end;
      });
      const totalDistance = weekRunsData.reduce((sum, a) => sum + (a.distance || 0), 0);
      const totalKm = totalDistance / 1000;
      const passed = totalKm >= s.requiredKm;
      newPenalties.push({
        strava_id: member.strava_id,
        week_start: week.start,
        week_end: week.end,
        run_count: weekRunsData.length,
        total_distance: totalDistance,
        total_km: Math.round(totalKm * 10) / 10,
        passed,
        penalty_amount: passed ? 0 : s.penaltyAmount
      });
    }
  }
  db.penalties = newPenalties;
}

// ============================================================
// 이번 달 km 계산
// ============================================================
function getMonthlyKm(activities, stravaId) {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  const prefix = `${year}-${String(month).padStart(2, '0')}`;
  const total = activities
    .filter(a => a.strava_id === stravaId && isRun(a) && a.start_date_local.startsWith(prefix))
    .reduce((sum, a) => sum + (a.distance || 0), 0);
  return Math.round(total / 100) / 10;
}

// ============================================================
// 푸시 알림 발송
// ============================================================
async function sendDeadlineNotifications(db, settings) {
  if (!webpush) return { sent: 0, failed: 0, skipped: 0, error: 'VAPID 키가 설정되지 않았습니다' };

  const s = settings || getSettings(db);
  const now = new Date();
  const weekStart = getCurrentWeekStartServer(now, s);
  const results = { sent: 0, failed: 0, skipped: 0 };
  const expiredEndpoints = [];

  for (const member of db.members) {
    const penalty = (db.penalties || []).find(
      p => p.strava_id === member.strava_id && p.week_start === weekStart
    );
    if (!penalty || penalty.passed) { results.skipped++; continue; }

    const remaining = Math.max(0, s.requiredKm - (penalty.total_km || 0));
    const subs = (db.subscriptions || []).filter(sub => sub.strava_id === member.strava_id);
    if (!subs.length) { results.skipped++; continue; }

    const dayNames = ['일', '월', '화', '수', '목', '금', '토'];
    const dayName = dayNames[now.getDay()];
    const payload = JSON.stringify({
      title: `⏰ ${s.challengeName} 마감 임박!`,
      body: `${member.name}님, ${dayName}요일까지 ${remaining.toFixed(1)}km 더 뛰어야 해요! (현재 ${penalty.total_km}/${s.requiredKm}km)`,
      url: '/'
    });

    for (const sub of subs) {
      try {
        await webpush.sendNotification(sub.subscription, payload);
        results.sent++;
      } catch (err) {
        console.error(`Push failed for ${member.name}:`, err.statusCode, err.message);
        if (err.statusCode === 410 || err.statusCode === 404) {
          expiredEndpoints.push(sub.subscription.endpoint);
        }
        results.failed++;
      }
    }
  }

  // 만료된 구독 정리
  if (expiredEndpoints.length > 0) {
    db.subscriptions = (db.subscriptions || []).filter(
      s => !expiredEndpoints.includes(s.subscription.endpoint)
    );
    await saveDB(db);
  }

  return results;
}

// ============================================================
// Strava OAuth
// ============================================================
app.get('/auth/strava', (req, res) => {
  const redirectUri = `${getBaseUrl()}/auth/callback`;
  const stravaUrl = `https://www.strava.com/oauth/authorize?client_id=${process.env.STRAVA_CLIENT_ID}&response_type=code&redirect_uri=${redirectUri}&scope=activity:read_all&approval_prompt=auto`;
  const baseUrl = getBaseUrl();

  res.send(`<!DOCTYPE html>
<html lang="ko"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Strava 연결</title>
<style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:-apple-system,sans-serif;background:#0F172A;color:#F1F5F9;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}.container{text-align:center;max-width:360px}.icon{font-size:48px;margin-bottom:16px}h2{font-size:20px;margin-bottom:12px}p{color:#94A3B8;font-size:14px;line-height:1.6;margin-bottom:24px}.btn{display:inline-block;background:#FC4C02;color:white;padding:14px 32px;border-radius:12px;text-decoration:none;font-size:16px;font-weight:700}.guide{background:#1E293B;border-radius:12px;padding:20px;margin-top:20px;text-align:left}.guide h3{font-size:15px;margin-bottom:10px;color:#FC4C02}.guide ol{padding-left:20px;color:#94A3B8;font-size:13px;line-height:2}.hide{display:none}</style>
</head><body><div class="container">
<div id="normal" class="hide"><div class="icon">🏃</div><h2>Strava 연결 중...</h2><p>잠시만 기다려주세요</p></div>
<div id="inapp" class="hide"><div class="icon">🔒</div><h2>외부 브라우저에서 열어주세요</h2><p>카카오톡/인스타 등에서는 Strava 로그인이 차단됩니다.</p>
<a class="btn" id="openExternal" href="#">외부 브라우저로 열기</a>
<div class="guide"><h3>자동으로 안 열리면:</h3><ol><li>우측 상단 ⋯ 메뉴 클릭</li><li>"다른 브라우저로 열기" 선택</li><li>Chrome 또는 Safari에서 재시도</li></ol></div></div>
</div>
<script>
var stravaUrl="${stravaUrl}";var authPage="${baseUrl}/auth/strava-go";var ua=navigator.userAgent||'';
var isInApp=/KAKAOTALK|NAVER|Instagram|FB_IAB|FBAN|Line/i.test(ua);
if(isInApp){document.getElementById('inapp').style.display='block';var btn=document.getElementById('openExternal');
if(/KAKAOTALK/i.test(ua)){btn.href='kakaotalk://web/openExternal?url='+encodeURIComponent(authPage);}
else if(/Android/i.test(ua)){btn.href='intent://'+authPage.replace(/https?:\/\//,''+'#Intent;scheme=https;package=com.android.chrome;end');}
else{btn.href=authPage;btn.setAttribute('target','_blank');}
}else{document.getElementById('normal').style.display='block';setTimeout(function(){window.location.href=stravaUrl;},500);}
</script></body></html>`);
});

app.get('/auth/strava-go', (req, res) => {
  const redirectUri = `${getBaseUrl()}/auth/callback`;
  res.redirect(`https://www.strava.com/oauth/authorize?client_id=${process.env.STRAVA_CLIENT_ID}&response_type=code&redirect_uri=${redirectUri}&scope=activity:read_all&approval_prompt=auto`);
});

app.get('/auth/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send('인증 코드가 없습니다.');
  try {
    const data = await exchangeToken(code);
    const { athlete, access_token, refresh_token, expires_at } = data;
    const db = await loadDB();
    const existingIdx = db.members.findIndex(m => m.strava_id === athlete.id);
    const memberData = {
      strava_id: athlete.id,
      name: `${athlete.firstname || ''} ${athlete.lastname || ''}`.trim() || `User_${athlete.id}`,
      profile: athlete.profile_medium || '',
      access_token, refresh_token, token_expires_at: expires_at,
      created_at: new Date().toISOString()
    };
    if (existingIdx >= 0) {
      db.members[existingIdx] = { ...db.members[existingIdx], ...memberData };
    } else {
      if (db.members.length >= 10) return res.status(400).send('최대 참가자 수(10명)에 도달했습니다.');
      memberData.id = Date.now();
      db.members.push(memberData);
    }
    try {
      const settings = getSettings(db);
      const after = Math.floor(Date.now() / 1000) - (90 * 24 * 60 * 60);
      const allActivities = await getActivities(access_token, after);
      const runs = allActivities.filter(isRun);
      db.activities = db.activities.filter(a => a.strava_id !== athlete.id);
      for (const run of runs) {
        db.activities.push({ strava_id: athlete.id, activity_id: run.id, name: run.name,
          distance: run.distance, moving_time: run.moving_time,
          start_date: run.start_date, start_date_local: run.start_date_local,
          type: run.type, sport_type: run.sport_type });
      }
      calculatePenalties(db, settings);
    } catch (syncErr) { console.error('Auto-sync error:', syncErr.message); }
    await saveDB(db);
    res.redirect(`/#connected&sid=${athlete.id}&name=${encodeURIComponent(memberData.name)}`);
  } catch (err) {
    const detail = err.response?.data || err.message;
    console.error('OAuth error:', detail);
    res.status(500).send(`<h2>Strava 인증 실패</h2><p>${JSON.stringify(detail)}</p><a href="/">돌아가기</a>`);
  }
});

app.get('/auth/token-callback', (req, res) => {
  const { code, error } = req.query;
  if (error) return res.send(`<html><body style="font-family:sans-serif;background:#0F172A;color:#F1F5F9;display:flex;align-items:center;justify-content:center;min-height:100vh"><div style="text-align:center"><h2>❌ 승인 거부됨</h2><p>${error}</p></div></body></html>`);
  res.send(`<html><body style="font-family:sans-serif;background:#0F172A;color:#F1F5F9;display:flex;align-items:center;justify-content:center;min-height:100vh"><div style="text-align:center;max-width:400px;padding:20px"><h2 style="color:#22C55E">✅ 승인 완료!</h2><p style="color:#94A3B8;margin:16px 0">아래 코드를 대표님에게 보내주세요:</p><div style="background:#1E293B;padding:16px;border-radius:12px;font-size:11px;word-break:break-all;color:#FC4C02;font-weight:700">${code}</div><p style="color:#64748B;font-size:12px;margin-top:16px">이 페이지를 닫아도 됩니다</p></div></body></html>`);
});

// ============================================================
// 토큰 갱신
// ============================================================
async function ensureToken(member, db) {
  const now = Math.floor(Date.now() / 1000);
  if (member.token_expires_at > now + 600) return member.access_token;
  try {
    let data;
    if (member.client_id && member.client_secret) {
      const tokenRes = await axios.post('https://www.strava.com/oauth/token', {
        client_id: member.client_id, client_secret: member.client_secret,
        refresh_token: member.refresh_token, grant_type: 'refresh_token'
      });
      data = tokenRes.data;
    } else {
      data = await refreshAccessToken(member.refresh_token);
    }
    const idx = db.members.findIndex(m => m.strava_id === member.strava_id);
    if (idx >= 0) {
      db.members[idx].access_token = data.access_token;
      db.members[idx].refresh_token = data.refresh_token;
      db.members[idx].token_expires_at = data.expires_at;
    }
    return data.access_token;
  } catch (err) {
    console.error(`Token refresh failed for ${member.name}:`, err.message);
    return null;
  }
}

// ============================================================
// API: 설정 조회 (공개)
// ============================================================
app.get('/api/settings', async (req, res) => {
  const db = await loadDB();
  const s = getSettings(db);
  res.json({
    ...s,
    vapidConfigured: !!process.env.VAPID_PUBLIC_KEY,
    vapidPublicKey: process.env.VAPID_PUBLIC_KEY || null
  });
});

// ============================================================
// API: 설정 저장 (관리자)
// ============================================================
app.post('/api/admin/settings', async (req, res) => {
  const { password, ...newSettings } = req.body;
  const adminPw = process.env.ADMIN_PASSWORD || 'bora1234';
  if (password !== adminPw) return res.status(403).json({ error: '비밀번호 오류' });

  const allowed = ['challengeName','challengeStart','firstWeekEnd','challengeEnd','requiredKm','penaltyAmount'];
  const filtered = {};
  for (const key of allowed) {
    if (newSettings[key] !== undefined) {
      filtered[key] = newSettings[key] === '' ? null : newSettings[key];
    }
  }
  if (filtered.requiredKm) filtered.requiredKm = Number(filtered.requiredKm);
  if (filtered.penaltyAmount) filtered.penaltyAmount = Number(filtered.penaltyAmount);

  const db = await loadDB();
  db.settings = { ...getSettings(db), ...filtered };
  calculatePenalties(db, db.settings);
  await saveDB(db);
  res.json({ ok: true, settings: db.settings });
});

// ============================================================
// API: 푸시 구독 저장
// ============================================================
app.post('/api/subscribe', async (req, res) => {
  const { strava_id, subscription } = req.body;
  if (!strava_id || !subscription || !subscription.endpoint) {
    return res.status(400).json({ error: '필수 파라미터 누락' });
  }

  const db = await loadDB();
  if (!db.subscriptions) db.subscriptions = [];

  // 같은 endpoint 있으면 업데이트, 없으면 추가
  const existing = db.subscriptions.findIndex(s => s.subscription.endpoint === subscription.endpoint);
  if (existing >= 0) {
    db.subscriptions[existing] = { strava_id, subscription, updated_at: new Date().toISOString() };
  } else {
    db.subscriptions.push({ strava_id, subscription, created_at: new Date().toISOString() });
  }
  await saveDB(db);
  res.json({ ok: true });
});

// ============================================================
// API: 푸시 구독 해제
// ============================================================
app.delete('/api/subscribe', async (req, res) => {
  const { endpoint } = req.body;
  if (!endpoint) return res.status(400).json({ error: 'endpoint 필요' });
  const db = await loadDB();
  db.subscriptions = (db.subscriptions || []).filter(s => s.subscription.endpoint !== endpoint);
  await saveDB(db);
  res.json({ ok: true });
});

// ============================================================
// API: Vercel Cron - 마감 임박 알림 자동 발송
// (vercel.json cron: 매주 목/금/토 오후 6시 KST = 09:00 UTC)
// ============================================================
app.get('/api/cron', async (req, res) => {
  // Vercel Cron 요청 검증
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const authHeader = req.headers['authorization'];
    if (authHeader !== `Bearer ${cronSecret}`) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  const now = new Date();
  const day = now.getDay(); // 0=일, 4=목, 5=금, 6=토
  if (![4, 5, 6].includes(day)) {
    return res.json({ skipped: true, reason: '알림 발송 요일이 아닙니다 (목/금/토만 발송)' });
  }

  const db = await loadDB();
  const settings = getSettings(db);
  calculatePenalties(db, settings);

  const results = await sendDeadlineNotifications(db, settings);
  console.log('[Cron] 알림 발송 결과:', results);
  res.json({ ok: true, day, results });
});

// ============================================================
// API: 관리자 수동 알림 발송
// ============================================================
app.post('/api/admin/notify', async (req, res) => {
  const { password } = req.body;
  const adminPw = process.env.ADMIN_PASSWORD || 'bora1234';
  if (password !== adminPw) return res.status(403).json({ error: '비밀번호 오류' });

  if (!webpush) {
    return res.status(400).json({ error: 'VAPID 키가 설정되지 않았습니다. .env 파일을 확인해주세요.' });
  }

  const db = await loadDB();
  const settings = getSettings(db);
  calculatePenalties(db, settings);

  const results = await sendDeadlineNotifications(db, settings);
  res.json({ ok: true, results });
});

// ============================================================
// API: 데이터 동기화
// ============================================================
app.post('/api/sync', async (req, res) => {
  const db = await loadDB();
  if (!db.members || db.members.length === 0) {
    return res.json({ results: [], summary: { ok: 0, errors: 0, noToken: 0, total: 0 }, message: 'no_members' });
  }

  const settings = getSettings(db);
  const results = [];
  const after = Math.floor(Date.now() / 1000) - (90 * 24 * 60 * 60);
  let changed = false;

  for (const member of db.members) {
    if (!member.access_token) {
      results.push({ name: member.name, status: 'no_token' });
      continue;
    }
    try {
      const token = await ensureToken(member, db);
      if (!token) {
        results.push({ name: member.name, status: 'token_error', message: '토큰 갱신 실패 - 재연결 필요' });
        continue;
      }
      const allActivities = await getActivities(token, after);
      const runs = allActivities.filter(isRun);
      db.activities = db.activities.filter(a => a.strava_id !== member.strava_id);
      for (const run of runs) {
        db.activities.push({
          strava_id: member.strava_id, activity_id: run.id, name: run.name,
          distance: run.distance, moving_time: run.moving_time,
          start_date: run.start_date, start_date_local: run.start_date_local,
          type: run.type, sport_type: run.sport_type
        });
      }
      results.push({ name: member.name, status: 'ok', synced: runs.length });
      changed = true;
    } catch (err) {
      const statusCode = err.response?.status;
      const errMsg = statusCode === 401 ? '인증 만료 - 재연결 필요'
        : statusCode === 429 ? 'Strava API 요청 한도 초과'
        : err.message;
      results.push({ name: member.name, status: 'error', message: errMsg });
    }
  }

  if (changed) {
    calculatePenalties(db, settings);
    await saveDB(db);
  }

  const ok = results.filter(r => r.status === 'ok').length;
  const errors = results.filter(r => r.status === 'error' || r.status === 'token_error').length;
  const noToken = results.filter(r => r.status === 'no_token').length;
  res.json({ results, summary: { ok, errors, noToken, total: results.length } });
});

// ============================================================
// API: 대시보드
// ============================================================
app.get('/api/dashboard', async (req, res) => {
  const db = await loadDB();
  const settings = getSettings(db);
  calculatePenalties(db, settings);

  const members = db.members.map(member => {
    const activities = db.activities
      .filter(a => a.strava_id === member.strava_id && isRun(a))
      .sort((a, b) => b.start_date_local.localeCompare(a.start_date_local));
    const penalties = (db.penalties || [])
      .filter(p => p.strava_id === member.strava_id)
      .sort((a, b) => b.week_start.localeCompare(a.week_start));
    const totalPenalty = penalties.filter(p => !p.passed).reduce((s, p) => s + p.penalty_amount, 0);
    const monthlyKm = getMonthlyKm(db.activities, member.strava_id);
    return {
      id: member.id, strava_id: member.strava_id, name: member.name,
      profile: member.profile, connected: !!member.access_token,
      activities, allRuns: activities, penalties, totalPenalty, monthlyKm
    };
  });

  res.json({
    members,
    settings: {
      ...settings,
      vapidConfigured: !!process.env.VAPID_PUBLIC_KEY,
      vapidPublicKey: process.env.VAPID_PUBLIC_KEY || null
    }
  });
});

// ============================================================
// API: 관리자 - 멤버 등록
// ============================================================
app.post('/api/admin/add-member', async (req, res) => {
  const { password, name, client_id, client_secret, auth_code } = req.body;
  const adminPw = process.env.ADMIN_PASSWORD || 'bora1234';
  if (password !== adminPw) return res.status(403).json({ error: '비밀번호 오류' });
  if (!name || !client_id || !client_secret || !auth_code) {
    return res.status(400).json({ error: '모든 항목이 필수입니다' });
  }
  try {
    const tokenRes = await axios.post('https://www.strava.com/oauth/token', {
      client_id, client_secret, code: auth_code, grant_type: 'authorization_code'
    });
    const { access_token, refresh_token: new_refresh_token, expires_at } = tokenRes.data;
    const athleteRes = await axios.get('https://www.strava.com/api/v3/athlete', {
      headers: { Authorization: `Bearer ${access_token}` }
    });
    const athlete = athleteRes.data;
    const db = await loadDB();
    const settings = getSettings(db);
    const existingIdx = db.members.findIndex(m => m.strava_id === athlete.id);
    const memberData = {
      strava_id: athlete.id, name, profile: athlete.profile_medium || '',
      access_token, refresh_token: new_refresh_token, client_id, client_secret,
      token_expires_at: expires_at, created_at: new Date().toISOString()
    };
    if (existingIdx >= 0) {
      db.members[existingIdx] = { ...db.members[existingIdx], ...memberData };
    } else {
      if (db.members.length >= 10) return res.status(400).json({ error: '최대 참가자 수(10명) 초과' });
      memberData.id = Date.now();
      db.members.push(memberData);
    }
    try {
      const after = Math.floor(Date.now() / 1000) - (90 * 24 * 60 * 60);
      const allActivities = await getActivities(access_token, after);
      const runs = allActivities.filter(isRun);
      db.activities = db.activities.filter(a => a.strava_id !== athlete.id);
      for (const run of runs) {
        db.activities.push({
          strava_id: athlete.id, activity_id: run.id, name: run.name,
          distance: run.distance, moving_time: run.moving_time,
          start_date: run.start_date, start_date_local: run.start_date_local,
          type: run.type, sport_type: run.sport_type
        });
      }
      calculatePenalties(db, settings);
    } catch (syncErr) { console.error('Auto-sync after add:', syncErr.message); }
    await saveDB(db);
    res.json({ ok: true, name: memberData.name, strava_id: athlete.id });
  } catch (err) {
    console.error('Add member error:', err.response?.data || err.message);
    res.status(400).json({ error: 'Authorization Code가 유효하지 않습니다.' });
  }
});

// ============================================================
// API: 멤버 목록 / 삭제
// ============================================================
app.get('/api/members', async (req, res) => {
  const db = await loadDB();
  res.json(db.members.map(m => ({
    id: m.id, strava_id: m.strava_id, name: m.name,
    profile: m.profile, connected: !!m.access_token
  })));
});

app.delete('/api/members/:stravaId', async (req, res) => {
  const { password } = req.body;
  const adminPw = process.env.ADMIN_PASSWORD || 'bora1234';
  if (password !== adminPw) return res.status(403).json({ error: '비밀번호 오류' });
  const db = await loadDB();
  const sid = parseInt(req.params.stravaId);
  db.members = db.members.filter(m => m.strava_id !== sid);
  db.activities = db.activities.filter(a => a.strava_id !== sid);
  db.penalties = (db.penalties || []).filter(p => p.strava_id !== sid);
  db.subscriptions = (db.subscriptions || []).filter(s => s.strava_id !== sid);
  await saveDB(db);
  res.json({ ok: true });
});

// ============================================================
// API: 디버그
// ============================================================
app.get('/api/debug', async (req, res) => {
  const db = await loadDB();
  const settings = getSettings(db);
  res.json({
    kv_url_set: !!process.env.KV_REST_API_URL,
    kv_token_set: !!process.env.KV_REST_API_TOKEN,
    vercel: !!process.env.VERCEL,
    storage_mode: (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) ? 'Vercel KV' : '/tmp (임시)',
    admin_password_set: !!process.env.ADMIN_PASSWORD,
    vapid_configured: !!process.env.VAPID_PUBLIC_KEY,
    settings,
    db: {
      memberCount: db.members?.length || 0,
      activityCount: db.activities?.length || 0,
      subscriptionCount: db.subscriptions?.length || 0,
      members: (db.members || []).map(m => ({ name: m.name, strava_id: m.strava_id, connected: !!m.access_token }))
    }
  });
});

module.exports = app;
