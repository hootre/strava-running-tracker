const axios = require('axios');

const CLIENT_ID = () => process.env.STRAVA_CLIENT_ID;
const CLIENT_SECRET = () => process.env.STRAVA_CLIENT_SECRET;

async function exchangeToken(code) {
  const res = await axios.post('https://www.strava.com/oauth/token', {
    client_id: CLIENT_ID(),
    client_secret: CLIENT_SECRET(),
    code,
    grant_type: 'authorization_code'
  });
  return res.data;
}

async function refreshAccessToken(refreshToken) {
  const res = await axios.post('https://www.strava.com/oauth/token', {
    client_id: CLIENT_ID(),
    client_secret: CLIENT_SECRET(),
    refresh_token: refreshToken,
    grant_type: 'refresh_token'
  });
  return res.data;
}

async function getActivities(accessToken, afterTimestamp) {
  let page = 1;
  let all = [];

  while (true) {
    const res = await axios.get('https://www.strava.com/api/v3/athlete/activities', {
      headers: { Authorization: `Bearer ${accessToken}` },
      params: { after: afterTimestamp, per_page: 100, page }
    });
    if (res.data.length === 0) break;
    all = all.concat(res.data);
    page++;
    if (res.data.length < 100) break;
  }

  return all;
}

module.exports = { exchangeToken, refreshAccessToken, getActivities };
