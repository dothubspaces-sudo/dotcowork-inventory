const { getAccessToken, creatorGetAll } = require('./zoho.js')

// Public and read-only: only names Creator already shows on the inventory page.
const CACHE_MS = 5 * 60 * 1000
let cache = null

const str = v => (v && typeof v === 'object') ? String(v.display_value || '') : (v == null ? '' : String(v)).trim()

// "Tidel Park" is the name of two locations, so those are told apart by the first part of the
// subtitle ("Tharamani", "Pattabiram"); a name that is unique ("Perungudi") is used as is.
function withLabels(rows) {
  const nameCount = {}
  rows.forEach(r => { nameCount[r.name] = (nameCount[r.name] || 0) + 1 })
  return rows.map(r => ({
    ...r,
    label: nameCount[r.name] > 1 ? (r.subtitle.split(',')[0].trim() || r.name) : r.name,
  }))
}

async function loadLocations(token) {
  const rows = await creatorGetAll(
    `report/Location_Master_Report?criteria=${encodeURIComponent('Status=="Active"')}`, token
  )
  const locations = rows.map(l => ({
    id:       String(l.ID),
    slug:     str(l.Location_Slug) || String(l.ID),
    name:     str(l.Location_Name),
    subtitle: str(l.Location_Subtitle),
  })).filter(l => l.slug && l.name)
  return withLabels(locations).sort((a, b) => a.label.localeCompare(b.label))
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'public, max-age=60')
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })
  try {
    if (!cache || Date.now() - cache.at > CACHE_MS) {
      cache = { at: Date.now(), locations: await loadLocations(await getAccessToken()) }
    }
    return res.status(200).json({ status: 'success', locations: cache.locations })
  } catch (err) {
    console.error('locations.js error:', err)
    return res.status(500).json({ error: err.message })
  }
}
