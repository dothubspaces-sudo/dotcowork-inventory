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
  if (!data.access_token) {
    // Zoho's own reason (invalid_code, invalid_client, ...) — never the credentials themselves.
    const why = data.error || data.message || `HTTP ${res.status}`
    console.error('Zoho token refresh failed:', JSON.stringify({ error: data.error, message: data.message }))
    throw new Error(`Failed to get Zoho access token (${why})`)
  }
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

// Whole-report reads go through the same API version the floor plan (availability.js) reads with, which is
// known to return every column of Inventory_Items_Report. The newer v2.1 read can return only a report's
// quick-view fields, which left the Contracts tab without cabin numbers and types.
const READ_BASE = 'https://creator.zoho.com/api/v2/dotcowork/workspace-inventory-manager'

async function creatorReadPage(path, token) {
  const res = await fetch(`${READ_BASE}/${path}`, {
    headers: { Authorization: `Zoho-oauthtoken ${token}` },
  })
  return res.json()
}

// Reads every page of a report (Creator caps a page at 200). The no-records codes mean an empty
// list; any other non-3000 code is a real error (e.g. the report doesn't exist) and is thrown, not swallowed.
async function creatorGetAll(path, token, pageSize = 200, maxPages = 25) {
  const sep = path.includes('?') ? '&' : '?'
  const out = []
  for (let page = 0; page < maxPages; page++) {
    const res = await creatorReadPage(`${path}${sep}from=${page * pageSize + 1}&limit=${pageSize}`, token)
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

// Creator answers 2945 when the API token wasn't generated with the scope the call needs (e.g. the token can
// read and create but not update or delete). Say that plainly instead of a generic "rejected".
function creatorRejection(result, fallback) {
  if (result && result.code === 2945) {
    return 'Zoho has not given this app permission to change or delete records (the API token is missing the ZohoCreator.report.UPDATE / ZohoCreator.report.DELETE scopes). The admin needs to regenerate the Zoho token with those scopes: see docs/zoho-setup.md.'
  }
  return fallback
}

module.exports = { creatorRejection, getAccessToken, creatorGet, creatorGetAll, creatorPost, creatorPatch, creatorDelete }
