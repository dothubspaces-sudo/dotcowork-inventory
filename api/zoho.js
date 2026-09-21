// zoho.js — shared Zoho auth + Creator helpers for dotcowork-inventory
const TOKEN_URL = 'https://accounts.zoho.com/oauth/v2/token'
const BASE_URL  = 'https://www.zohoapis.com/creator/v2.1/data/dotcowork/workspace-inventory-manager'

let cachedToken = null
let tokenExpiry  = 0

async function getAccessToken() {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken
  const params = new URLSearchParams({
    client_id:     process.env.ZOHO_CLIENT_ID,
    client_secret: process.env.ZOHO_CLIENT_SECRET,
    refresh_token: process.env.ZOHO_REFRESH_TOKEN,
    grant_type:    'refresh_token',
  })
  const res  = await fetch(TOKEN_URL, { method: 'POST', body: params })
  const data = await res.json()
  if (!data.access_token) throw new Error('Failed to get Zoho access token')
  cachedToken = data.access_token
  tokenExpiry  = Date.now() + 50 * 60 * 1000
  return cachedToken
}

async function creatorGet(path, token) {
  const res = await fetch(`${BASE_URL}/${path}`, {
    headers: { Authorization: `Zoho-oauthtoken ${token}` },
  })
  return res.json()
}

// Creator reports "no records" as 3100 (nothing matched the criteria) or 9220 (the report is empty).
const NO_RECORDS_CODES = [3100, 9220]

// Reads every page of a report (Creator caps a page at 200). The no-records codes mean an empty
// list; any other non-3000 code is a real error (e.g. the report doesn't exist) and is thrown, not swallowed.
async function creatorGetAll(path, token, pageSize = 200, maxPages = 25) {
  const sep = path.includes('?') ? '&' : '?'
  const out = []
  for (let page = 0; page < maxPages; page++) {
    const res = await creatorGet(`${path}${sep}from=${page * pageSize + 1}&limit=${pageSize}`, token)
    if (res.code && res.code !== 3000 && !NO_RECORDS_CODES.includes(res.code)) {
      throw new Error(`Creator error ${res.code}: ${res.message || 'request failed'}`)
    }
    const rows = res.data || []
    out.push(...rows)
    if (rows.length < pageSize) break
  }
  return out
}

async function creatorPost(path, data, token) {
  const res = await fetch(`${BASE_URL}/${path}`, {
    method:  'POST',
    headers: {
      Authorization:  `Zoho-oauthtoken ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ data }),
  })
  const result = await res.json()
  console.log('creatorPost result:', JSON.stringify(result))
  return result
}

async function creatorPatch(path, data, token) {
  const res = await fetch(`${BASE_URL}/${path}`, {
    method:  'PATCH',
    headers: {
      Authorization:  `Zoho-oauthtoken ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ data }),
  })
  const result = await res.json()
  console.log('creatorPatch result:', JSON.stringify(result))
  return result
}

async function creatorDelete(path, token) {
  const res = await fetch(`${BASE_URL}/${path}`, {
    method:  'DELETE',
    headers: { Authorization: `Zoho-oauthtoken ${token}` },
  })
  const result = await res.json()
  console.log('creatorDelete result:', JSON.stringify(result))
  return result
}

module.exports = { getAccessToken, creatorGet, creatorGetAll, creatorPost, creatorPatch, creatorDelete }
