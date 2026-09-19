const { isAuthed, passwordMatches, createToken, sessionCookie, clearCookie } = require('../lib/auth.js')

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store')

  if (req.method === 'GET') {
    return res.status(200).json({ authed: isAuthed(req) })
  }

  if (req.method === 'DELETE') {
    res.setHeader('Set-Cookie', clearCookie())
    return res.status(200).json({ status: 'success' })
  }

  if (req.method === 'POST') {
    if (!process.env.TEAM_PASSWORD || !process.env.AUTH_SECRET) {
      return res.status(500).json({ error: 'Login is not configured on the server' })
    }
    const { password } = req.body || {}
    if (!passwordMatches(password)) {
      await new Promise(r => setTimeout(r, 600))
      return res.status(401).json({ error: 'Incorrect password' })
    }
    res.setHeader('Set-Cookie', sessionCookie(createToken()))
    return res.status(200).json({ status: 'success' })
  }

  return res.status(405).json({ error: 'Method not allowed' })
}
