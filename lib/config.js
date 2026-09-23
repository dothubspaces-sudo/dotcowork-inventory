// Zoho Creator link names for the contracts feature. If the forms/reports are named
// differently in Creator, change them here and nowhere else.
module.exports = {
  CONTRACT_FORM:   'Contracts',
  CONTRACT_REPORT: 'All_Contracts',
  LINE_FORM:       'Contract_Cabins',
  LINE_REPORT:     'Contract_Cabins_Report',
  BOOKINGS_REPORT: 'All_Spaces',
  ITEMS_REPORT:    'Inventory_Items_Report',

  // Meeting rooms, board room, training room and auditorium can never be under a contract.
  HOURLY_SPACES: new Set(['C-23', 'C-24', 'C-25', 'Training Room', 'Auditorium']),

  // Contracts are only for private cabins; matched loosely so "Private Cabin" / "5-seater cabin" both count.
  CABIN_TYPE_PATTERN: /cabin/i,

  // In the inventory every item, meeting rooms and the auditorium included, has Workspace_Type "Private Cabin",
  // so the type alone can't tell them apart. Anything named like a shared/event space is never leasable.
  NON_CABIN_NAME_PATTERN: /meeting|board|conference|training|auditorium/i,

  EXPIRING_DAYS: 30,
}
