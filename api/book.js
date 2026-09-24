const { getAccessToken, creatorGet, creatorPost, creatorPatch, creatorDelete } = require('./zoho.js')
const { requireAuth } = require('../lib/auth.js')
const { classify, nameOf, locationOf } = require('../lib/spaces.js')

// Creator v2.1 adds records through the form, but updates/deletes go through a report.
const BOOKINGS_REPORT = 'All_Spaces'

const BUSINESS_START_MIN = 9 * 60  // 9 AM
const BUSINESS_END_MIN   = 21 * 60 // 9 PM

function toCreatorDate(d) {
  if (!d) return '';
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const dt = new Date(d + 'T00:00:00');
  return `${String(dt.getDate()).padStart(2,'0')}-${months[dt.getMonth()]}-${dt.getFullYear()}`;
}

// Creator's Start_Time/End_Time fields store "HH:mm:ss" (24hr). Our frontend sends "HH:MM".
function toCreatorTime(t) {
  return `${t}:00`
}

function displayTime(mins) {
  const ap = mins >= 720 ? 'PM' : 'AM'
  let h12 = Math.floor(mins / 60) % 12
  if (h12 === 0) h12 = 12
  const m = String(mins % 60).padStart(2, '0')
  return `${h12}:${m} ${ap}`
}

// Handles "HH:MM" (24hr, from the frontend) and "HH:mm:ss" (as Creator stores/echoes it back)
function parseTimeToMinutes(t) {
  if (!t) return null
  const m = /^(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM|am|pm)?$/.exec(String(t).trim())
  if (!m) return null
  let h = parseInt(m[1], 10)
  const min = parseInt(m[2], 10)
  const ap = m[3] ? m[3].toUpperCase() : null
  if (ap === 'PM' && h !== 12) h += 12
  if (ap === 'AM' && h === 12) h = 0
  return h * 60 + min
}

// The space being booked. Cabin numbers repeat across locations, so the item ID is what identifies it.
// A cabin number (plus location) is still accepted for callers that don't have the ID.
async function findItem(token, { item_id, cabin_number, location }) {
  if (item_id) {
    if (!/^\d+$/.test(String(item_id))) return { error: { status: 400, message: 'Invalid space' } }
    const data = await creatorGet(
      `report/Inventory_Items_Report?criteria=${encodeURIComponent(`ID == ${item_id}`)}&limit=1`, token
    )
    const item = (data.data || [])[0]
    return item ? { item } : { error: { status: 404, message: 'That space was not found' } }
  }

  if (/["\\]/.test(cabin_number)) return { error: { status: 400, message: 'Invalid cabin number' } }
  const data = await creatorGet(
    `report/Inventory_Items_Report?criteria=${encodeURIComponent(`Cabin_Number == "${cabin_number}"`)}&limit=50`, token
  )
  let matches = data.data || []
  if (location) matches = matches.filter(i => locationOf(i).slug.toLowerCase() === String(location).toLowerCase())
  if (!matches.length) return { error: { status: 404, message: `No inventory item found for: ${cabin_number}` } }
  if (matches.length > 1) return { error: { status: 409, message: `${cabin_number} exists in more than one location; choose the location.` } }
  return { item: matches[0] }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, PATCH, DELETE, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') return res.status(200).end()

  if ((req.method === 'PATCH' || req.method === 'DELETE') && !requireAuth(req, res)) return

  if (req.method === 'DELETE') {
    const id = req.query.id
    if (!id) return res.status(400).json({ error: 'Missing booking id' })
    try {
      const token = await getAccessToken()
      const result = await creatorDelete(`report/${BOOKINGS_REPORT}/${id}`, token)
      if (result.code === 3000) {
        return res.status(200).json({ status: 'success', message: 'Booking cancelled' })
      }
      return res.status(500).json({ error: 'Creator rejected the cancellation', detail: result })
    } catch (err) {
      console.error('book.js delete error:', err)
      return res.status(500).json({ error: err.message })
    }
  }

  if (req.method !== 'POST' && req.method !== 'PATCH') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const isEdit = req.method === 'PATCH'
  const { item_id, cabin_number, location, client_name, booking_start, booking_end, purpose, total_pax, start_time, end_time, booking_id } = req.body || {}
  if ((!item_id && !cabin_number) || !client_name || !booking_start || !booking_end || !purpose) {
    return res.status(400).json({ error: 'Missing required fields' })
  }
  if (isEdit && !booking_id) {
    return res.status(400).json({ error: 'Missing booking id' })
  }
  if (booking_end < booking_start) {
    return res.status(400).json({ error: 'End date must be after start date' })
  }

  try {
    const token = await getAccessToken()
    const found = await findItem(token, { item_id, cabin_number, location })
    if (found.error) return res.status(found.error.status).json({ error: found.error.message })
    const item = found.item
    if (location && locationOf(item).slug.toLowerCase() !== String(location).toLowerCase()) {
      return res.status(400).json({ error: 'That space is not in the selected location' })
    }

    const inventoryItemId = item.ID
    const spaceName = nameOf(item) || cabin_number
    const isHourly = classify(item) === 'hourly'
    let startMin = null, endMin = null

    if (isHourly) {
      if (booking_start !== booking_end) {
        return res.status(400).json({ error: `${spaceName} can only be booked one day at a time — pick a time slot instead.` })
      }
      if (!start_time || !end_time) {
        return res.status(400).json({ error: 'Select a start and end time' })
      }
      startMin = parseTimeToMinutes(start_time)
      endMin = parseTimeToMinutes(end_time)
      if (startMin == null || endMin == null || startMin >= endMin) {
        return res.status(400).json({ error: 'Invalid time range' })
      }
      if (startMin < BUSINESS_START_MIN || endMin > BUSINESS_END_MIN) {
        return res.status(400).json({ error: 'Bookings are only available between 9 AM and 9 PM' })
      }
    }

    let criteria = `Inventory_Items == ${inventoryItemId} && Booking_Start <= "${toCreatorDate(booking_end)}" && Booking_End >= "${toCreatorDate(booking_start)}"`
    if (isEdit) criteria += ` && ID != ${booking_id}`
    const conflictData = await creatorGet(
      `report/All_Spaces?criteria=${encodeURIComponent(criteria)}&limit=${isHourly ? 50 : 1}`,
      token
    )
    const conflicts = conflictData.data || []

    if (isHourly) {
      let clash = null
      for (const ex of conflicts) {
        const exHasTime = !!(ex.Start_Time && ex.End_Time)
        if (!exHasTime) { clash = ex; break }
        const exStart = parseTimeToMinutes(ex.Start_Time)
        const exEnd = parseTimeToMinutes(ex.End_Time)
        if (exStart == null || exEnd == null || (startMin < exEnd && endMin > exStart)) { clash = ex; break }
      }
      if (clash) {
        const exHasTime = !!(clash.Start_Time && clash.End_Time)
        const clashRange = exHasTime
          ? `${displayTime(parseTimeToMinutes(clash.Start_Time))}–${displayTime(parseTimeToMinutes(clash.End_Time))}`
          : null
        return res.status(409).json({
          error: exHasTime
            ? `${spaceName} is already booked ${clashRange} on ${clash.Booking_Start} by ${clash.Client_Name}.`
            : `${spaceName} is already booked all day on ${clash.Booking_Start} by ${clash.Client_Name}.`,
        })
      }
    } else if (conflicts.length > 0) {
      const ex = conflicts[0]
      return res.status(409).json({
        error: `${spaceName} is already booked from ${ex.Booking_Start} to ${ex.Booking_End} by ${ex.Client_Name}.`,
      })
    }

    const payload = {
      Inventory_Items: inventoryItemId,
      Client_Name:     client_name,
      Booking_Start:   toCreatorDate(booking_start),
      Booking_End:     toCreatorDate(booking_end),
      Purpose:         purpose,
      Total_Pax:       total_pax || 0,
    }
    if (isHourly) {
      payload.Start_Time = toCreatorTime(start_time)
      payload.End_Time   = toCreatorTime(end_time)
    }

    if (isEdit) {
      const result = await creatorPatch(`report/${BOOKINGS_REPORT}/${booking_id}`, payload, token)
      if (result.code === 3000) {
        return res.status(200).json({ status: 'success', message: `Booking updated for ${spaceName}`, id: booking_id })
      }
      return res.status(500).json({ error: 'Creator rejected the update', detail: result })
    }

    const result = await creatorPost('form/Space_Bookings', payload, token)
    if (result.code === 3000) {
      return res.status(200).json({
        status:  'success',
        message: `Booking confirmed for ${spaceName}`,
        id:      result.data?.ID || null,
      })
    } else {
      return res.status(500).json({ error: 'Creator rejected the booking', detail: result })
    }
  } catch (err) {
    console.error('book.js error:', err)
    return res.status(500).json({ error: err.message })
  }
}
