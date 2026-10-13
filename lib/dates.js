const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// "2026-09-19" -> "19-Sep-2026" (the date format Creator reads and writes)
function toCreatorDate(iso) {
  if (!iso) return ''
  const [y, m, d] = iso.split('-')
  return `${d}-${MONTHS[Number(m) - 1]}-${y}`
}

// Whatever Creator (or an import) hands back for a date -> "2026-09-19", '' if it can't be read.
// Handles "19-Sep-2026" (with or without a time), "19-September-2026", "19 Sep 2026", "Sep 19, 2026",
// "2026-09-19", "19/09/2026" (day first, as in India; month first only when the 2nd part is over 12),
// "9-Sep-2026" (no zero padding) and Excel serial numbers such as 45037.
function fromCreatorDate(s) {
  if (s == null || s === '') return ''
  const str = String(s).trim()
  const pad = n => String(n).padStart(2, '0')
  const monthIdx = name => MONTHS.findIndex(x => x.toLowerCase() === String(name).slice(0, 3).toLowerCase())
  const ok = (y, m, d) => {
    const iso = `${y}-${pad(m)}-${pad(d)}`
    return isISODate(iso) ? iso : ''
  }
  let m
  if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(str))) return ok(m[1], m[2], m[3])
  if ((m = /^(\d{1,2})[-\/ .]([A-Za-z]{3,9})[-\/ .,]+(\d{4})/.exec(str))) {
    const mi = monthIdx(m[2]); return mi < 0 ? '' : ok(m[3], mi + 1, m[1])
  }
  if ((m = /^([A-Za-z]{3,9})[ .-]+(\d{1,2}),?[ -]+(\d{4})/.exec(str))) {
    const mi = monthIdx(m[1]); return mi < 0 ? '' : ok(m[3], mi + 1, m[2])
  }
  if ((m = /^(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{4})/.exec(str))) {
    const a = Number(m[1]), b = Number(m[2])
    return b > 12 ? ok(m[3], a, b) : ok(m[3], b, a)
  }
  if (/^\d{5}(\.\d+)?$/.test(str)) {
    const d = new Date(Date.UTC(1899, 11, 30) + Math.floor(Number(str)) * 86400000)
    return d.toISOString().slice(0, 10)
  }
  return ''
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
