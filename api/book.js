const { getAccessToken, creatorGet, creatorPost } = require('./zoho.js')

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { cabin_number, client_name, booking_start, booking_end, purpose, total_pax } = req.body || {}

  if (!cabin_number || !client_name || !booking_start || !booking_end || !purpose) {
    return res.status(400).json({ error: 'Missing required fields' })
  }
  if (booking_end < booking_start) {
    return res.status(400).json({ error: 'End date must be after start date' })
  }

  try {
    const token = await getAccessToken()

    // Step 1 — find Inventory_Items record ID for this cabin
    const itemsData = await creatorGet(
      `report/Inventory_Items_Report?criteria=${encodeURIComponent(`Cabin_Number == "${cabin_number}"`)}&limit=1`,
      token
    )
    const item = (itemsData.data || [])[0]
    if (!item) {
      return res.status(404).json({ error: `No inventory item found for: ${cabin_number}` })
    }
    const inventoryItemId = item.ID

    // Step 2 — conflict check
    const conflictData = await creatorGet(
      `report/All_Spaces?criteria=${encodeURIComponent(`Inventory_Items == ${inventoryItemId} && Booking_Start <= "${booking_end}" && Booking_End >= "${booking_start}"`)}&limit=1`,
      token
    )
    if ((conflictData.data || []).length > 0) {
      const ex = conflictData.data[0]
      return res.status(409).json({
        error: `${cabin_number} is already booked from ${ex.Booking_Start} to ${ex.Booking_End} by ${ex.Client_Name}.`,
      })
    }

    // Step 3 — create Space_Bookings record
    const result = await creatorPost('form/Space_Bookings', {
      Inventory_Items: inventoryItemId,
      Client_Name:     client_name,
      Booking_Start:   booking_start,
      Booking_End:     booking_end,
      Purpose:         purpose,
      Total_Pax:       total_pax || 0,
    }, token)

    if (result.code === 3000) {
      return res.status(200).json({
        status:  'success',
        message: `Booking confirmed for ${cabin_number}`,
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
