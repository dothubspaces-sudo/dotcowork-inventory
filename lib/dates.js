const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// "2026-09-19" -> "19-Sep-2026" (the date format Creator reads and writes)
function toCreatorDate(iso) {
  if (!iso) return ''
  const [y, m, d] = iso.split('-')
  return `${d}-${MONTHS[Number(m) - 1]}-${y}`
}

// "19-Sep-2026" or "19-Sep-2026 10:30:00" -> "2026-09-19". Passes ISO dates through, '' if unparseable.
function fromCreatorDate(s) {
  if (!s) return ''
  const m = /^(\d{2})-([A-Za-z]{3})-(\d{4})/.exec(String(s))
  if (m) {
    const mi = MONTHS.findIndex(x => x.toLowerCase() === m[2].toLowerCase())
    return mi < 0 ? '' : `${m[3]}-${String(mi + 1).padStart(2, '0')}-${m[1]}`
  }
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? String(s).slice(0, 10) : ''
}

function isISODate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false
  const d = new Date(s + 'T00:00:00Z')
  return !isNaN(d) && d.toISOString().slice(0, 10) === s
}

// The team works in IST; Vercel runs in UTC, so "today" must be computed explicitly.
function todayISO() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })
}

function daysBetween(fromISO, toISO) {
  const a = Date.parse(fromISO + 'T00:00:00Z')
  const b = Date.parse(toISO + 'T00:00:00Z')
  return Math.round((b - a) / 86400000)
}

module.exports = { toCreatorDate, fromCreatorDate, isISODate, todayISO, daysBetween }
