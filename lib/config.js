// Zoho Creator link names for the contracts feature. If the forms/reports are named
// differently in Creator, change them here and nowhere else.
// (What counts as a cabin, open workspace or hourly room is decided in lib/spaces.js.)
module.exports = {
  CONTRACT_FORM:   'Contracts',
  CONTRACT_REPORT: 'All_Contracts',
  LINE_FORM:       'Contract_Cabins',
  LINE_REPORT:     'Contract_Cabins_Report',
  BOOKINGS_REPORT: 'All_Spaces',
  ITEMS_REPORT:    'Inventory_Items_Report',

  EXPIRING_DAYS: 30,

  // Switch for the move of meeting-room booking to the DOT Cowork portal. Set ROOMS_IN_PORTAL=1 on the Vercel project and
  // this tool stops taking meeting-room (hourly) bookings and stops showing their availability, because that now lives in the
  // portal (Admin > Bookings and Floor plan). Cabins, open workspace and contracts are unchanged. Off unless set.
  roomsInPortal: () => process.env.ROOMS_IN_PORTAL === '1',
  portalAdminUrl: () => String(process.env.PORTAL_ADMIN_URL || '').trim(),
}
