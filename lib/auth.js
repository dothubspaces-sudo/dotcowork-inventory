const crypto = require('crypto')

const COOKIE      = 'dc_session'
const MAX_AGE_SEC = 12 * 60 * 60

function secret() {
  const s = process.env.AUTH_SECRET
  if (!s) throw new Error('AUTH_SECRET is not configured')
  return s
}

function sign(payload) {
  return crypto.createHmac('sha256', secret()).update(payload).digest('base64url')
}

function createToken() {
  const payload = String(Math.floor(Date.now() / 1000) + MAX_AGE_SEC)
  return `${payload}.${sign(payload)}`
}

function verifyToken(token) {
  if (!token) return false
  const [payload, sig] = token.split('.')
  if (!payload || !sig) return false
  const a = Buffer.from(sig)
  const b = Buffer.from(sign(payload))
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false
  return Number(payload) > Math.floor(Date.now() / 1000)
}

function parseCookies(req) {
  const out = {}
  ;(req.headers.cookie || '').split(';').forEach(part => {
    const i = part.indexOf('=')
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim())
  })
  return out
}

// Fails closed: a missing AUTH_SECRET or a malformed cookie means "not logged in".
function isAuthed(req) {
  try { return verifyToken(parseCookies(req)[COOKIE]) } catch { return false }
}

function requireAuth(req, res) {
  if (isAuthed(req)) return true
  res.status(401).json({ error: 'Login required', code: 'auth_required' })
  return false
}

// Hash both sides so the comparison is constant-time regardless of length.
function passwordMatches(input) {
  const expected = process.env.TEAM_PASSWORD
  if (!expected || typeof input !== 'string') return false
  const a = crypto.createHash('sha256').update(input).digest()
  const b = crypto.createHash('sha256').update(expected).digest()
  return crypto.timingSafeEqual(a, b)
}

function sessionCookie(token) {
  return `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${MAX_AGE_SEC}`
}

function clearCookie() {
  return `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`
}

module.exports = { isAuthed, requireAuth, passwordMatches, createToken, sessionCookie, clearCookie }
