// The one place that decides what an Inventory Item is, so availability, booking and contracts agree.
//
//   hourly   - meeting / board / conference rooms and other event spaces, booked by the hour
//   leasable - private cabins and open workspace, put under long-term contracts
//   other    - anything else
//
// The Workspace_Type decides. While a location's types are still all "Private Cabin", the name
// rules below keep the meeting rooms and event spaces from being treated as cabins.

const HOURLY_TYPE = /meeting|board|conference|training|auditorium|event/i
const HOURLY_NAME = /meeting|board|conference|training|auditorium/i
const LEGACY_HOURLY = new Set(['C-23', 'C-24', 'C-25', 'Training Room', 'Auditorium'])
const LEASABLE_TYPE = /cabin|open\s*workspace/i
const OPEN_WORKSPACE = /open\s*workspace/i

const text = v => (v && typeof v === 'object') ? String(v.display_value || '') : (v == null ? '' : String(v))
const num = v => { const n = Number(String(v == null ? '' : v).replace(/,/g, '')); return Number.isFinite(n) ? n : 0 }

// What people call the space: its cabin number, or its label for items that have no number (open workspace).
function nameOf(item) {
  return text(item.Cabin_Number) || text(item.Unit_Label)
}

function classify(item) {
  const type = text(item.Workspace_Type)
  const name = nameOf(item)
  if (HOURLY_TYPE.test(type)) return 'hourly'
  if (LEGACY_HOURLY.has(name) || HOURLY_NAME.test(`${name} ${text(item.Unit_Label)}`)) return 'hourly'
  if (LEASABLE_TYPE.test(type)) return 'leasable'
  return 'other'
}

function isOpenWorkspace(item) {
  return OPEN_WORKSPACE.test(text(item.Workspace_Type))
}

// Seats a space can hold. For open workspace the item's Quantity is its seat count (as on the inventory page).
function capacityOf(item) {
  const seats = num(item.No_of_Seats || item.Capacity)
  return isOpenWorkspace(item) ? (num(item.Quantity) || seats) : seats
}

// Location is identified by the Location_Master slug, the lookup's display value (e.g. "tidel-omr").
function locationOf(item) {
  const l = item.Location_Master
  return { slug: text(l), id: (l && typeof l === 'object') ? String(l.ID || '') : '' }
}

module.exports = { classify, isOpenWorkspace, capacityOf, nameOf, locationOf }
