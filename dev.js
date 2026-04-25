// 로컬 개발 서버 - Vercel 없이 Express 직접 실행
require('dotenv').config();
const path = require('path');
const express = require('express');
const app = require('./api/server');

// public 폴더 정적 파일 서빙 (Vercel에서는 자동이지만 로컬에선 직접)
app.use(express.static(path.join(__dirname, 'public')));

// SPA 폴백 - 모든 미정의 경로는 index.html로
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('');
  console.log('🏃 SM러닝크루 트래커 (로컬 모드)');
  console.log(`   http://localhost:${PORT}`);
  console.log('');
  console.log(`   Strava Client ID: ${process.env.STRAVA_CLIENT_ID ? '✅ 설정됨' : '⚠️  미설정'}`);
  console.log(`   데이터 저장: ${process.env.KV_REST_API_URL ? 'Vercel KV' : '로컬 JSON 파일'}`);
  console.log('');
});
