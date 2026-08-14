// _zoho.js — shared Zoho auth + Creator helpers for dotcowork-inventory

const TOKEN_URL = 'https://accounts.zoho.com/oauth/v2/token'
const BASE_URL  = 'https://www.zohoapis.com/creator/v2.1/data/dotcowork/workspace-inventory-manager'

let cachedToken = null
let tokenExpiry  = 0

export async function getAccessToken() {
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

export async function creatorGet(path, token) {
  const res = await fetch(`${BASE_URL}/${path}`, {
    headers: { Authorization: `Zoho-oauthtoken ${token}` },
  })
  return res.json()
}

export async function creatorPost(path, data, token) {
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
