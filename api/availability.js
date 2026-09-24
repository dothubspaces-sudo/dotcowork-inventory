const { isAuthed } = require('../lib/auth.js');
const { getAccessToken, creatorGetAll } = require('./zoho.js');
const { toCreatorDate, fromCreatorDate, isISODate } = require('../lib/dates.js');
const { classify, isOpenWorkspace, capacityOf, nameOf, locationOf } = require('../lib/spaces.js');
const cfg = require('../lib/config.js');

const BUSINESS_START_MIN = 9 * 60;  // 9 AM
const BUSINESS_END_MIN   = 21 * 60; // 9 PM

const refId = v => (v && typeof v === 'object') ? String(v.ID || '') : (v == null ? '' : String(v));
const refName = v => (v && typeof v === 'object') ? String(v.display_value || v.Cabin_Number || '') : (v == null ? '' : String(v));

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  // Accept ?date=YYYY-MM-DD&end_date=YYYY-MM-DD&location=<slug>
  // If only date passed, end_date defaults to date (single day check)
  const startDate = req.query.date     || new Date().toISOString().split("T")[0];
  const endDate   = req.query.end_date || startDate;
  // Cabin numbers repeat across locations, so a space is identified by its item ID and the
  // location narrows everything (items, bookings, contracts) to one site. Only compared in JS.
  const wantedLocation = String(req.query.location || "").trim().toLowerCase();

  // These go straight into Creator criteria strings, so only accept real ISO dates.
  if (!isISODate(startDate) || !isISODate(endDate)) {
    return res.status(400).json({ error: "date and end_date must be YYYY-MM-DD" });
  }

  try {
    // Step 1 — access token (cached across warm invocations by zoho.js)
    const token   = await getAccessToken();
    const base    = "https://creator.zoho.com/api/v2/dotcowork/workspace-inventory-manager/report";
    const headers = { Authorization: `Zoho-oauthtoken ${token}` };

    // Step 2 — fetch all inventory items + bookings that overlap the date range
    // Overlap: Booking_Start <= endDate AND Booking_End >= startDate
    const bookingCriteria = encodeURIComponent(
      `Booking_Start <= "${endDate}" && Booking_End >= "${startDate}"`
    );

    const [itemsRes, bookingsRes, contractRows] = await Promise.all([
      fetch(`${base}/Inventory_Items_Report?limit=200`, { headers }),
      fetch(`${base}/All_Spaces?criteria=${bookingCriteria}&limit=200`, { headers }),
      loadContractRows(token, startDate, endDate),
    ]);

    const [itemsData, bookingsData] = await Promise.all([
      itemsRes.json(),
      bookingsRes.json(),
    ]);

    const items = (itemsData.data || []).filter(i =>
      !wantedLocation || locationOf(i).slug.toLowerCase() === wantedLocation
    );
    const bookings = bookingsData.data || [];
    const itemById = {};
    const itemByName = {};
    items.forEach(i => {
      itemById[String(i.ID)] = i;
      const n = nameOf(i);
      if (n && !itemByName[n]) itemByName[n] = i;
    });
    const contractBooked = mapContractOccupancy(contractRows, itemById);

    // A booking belongs to the item it points at. Only when Creator gave no item ID at all is the cabin's
    // display name used (within this location); a booking for another location's item must never match by name.
    const itemForBooking = b => {
      const link = b.Inventory_Items;
      const id = (link && typeof link === 'object') ? String(link.ID || '') : '';
      return id ? (itemById[id] || null) : (itemByName[refName(link)] || null);
    };

    // Step 3 — build booked map keyed by item ID (last-overlap wins, matches prior behavior)
    // and, for hourly spaces, collect every overlapping booking so slot-level availability can be derived
    const bookedMap = {};
    const bookingsByItem = {};
    const bookingItem = new Map();
    bookings.forEach(b => {
      const item = itemForBooking(b);
      if (!item) return;
      bookingItem.set(b, item);
      const itemId = String(item.ID);
      bookedMap[itemId] = {
        id:            b.ID || "",
        client:        b.Client_Name  || "",
        purpose:       b.Purpose      || "",
        pax:           b.Total_Pax    || 0,
        booking_start: b.Booking_Start || "",
        booking_end:   b.Booking_End   || "",
      };
      if (classify(item) === 'hourly') {
        (bookingsByItem[itemId] ||= []).push(b);
      }
    });

    // Step 4 — map every inventory item with its status
    const spaces = items.map(item => {
      const itemId  = String(item.ID);
      const name    = nameOf(item);
      const kind    = classify(item);
      const open    = isOpenWorkspace(item);
      // A cabin under an active contract shows as occupied; contracts never cover the hourly spaces.
      const contract = contractBooked[itemId];
      const booking  = contract ? contractBooking(contract, open) : bookedMap[itemId];
      const base = {
        item_id:        itemId,
        cabin_number:   name,
        display_name:   item.Unit_Label     || name,
        workspace_type: item.Workspace_Type || "",
        capacity:       open ? capacityOf(item) : (item.No_of_Seats || item.Capacity || 0),
        location:       locationOf(item).slug,
        kind,
      };

      if (kind === 'hourly') {
        const { slots, fullyBookedEveryDay } = buildHourlySlots(
          bookingsByItem[itemId] || [], startDate, endDate
        );
        return {
          ...base,
          hourly: true,
          status: fullyBookedEveryDay ? "Booked" : "Available",
          slots,
          ...(booking ? bookingFields(booking) : {}),
        };
      }

      // Open workspace is shared: it only shows Booked once every seat is leased.
      if (open) {
        const leased = contract ? contract.seatsLeased : 0;
        return {
          ...base,
          open_workspace: true,
          seats_leased:   leased,
          status: leased > 0 && leased >= base.capacity ? "Booked" : "Available",
          ...(booking ? bookingFields(booking) : {}),
        };
      }

      return {
        ...base,
        status: booking ? "Booked" : "Available",
        ...(booking ? bookingFields(booking) : {}),
      };
    });

    // Flat, undeduplicated list of every booking overlapping the range — unlike `spaces`
    // (one status snapshot per cabin), this keeps every booking so a cabin with multiple
    // bookings in the range (e.g. across a whole month) isn't collapsed to just the last one.
    const allBookings = bookings.filter(b => bookingItem.has(b)).map(b => {
      const item = bookingItem.get(b);
      return {
        id:            b.ID || "",
        item_id:       String(item.ID),
        cabin_number:  nameOf(item),
        location:      locationOf(item).slug,
        client:        b.Client_Name  || "",
        purpose:       b.Purpose      || "",
        pax:           b.Total_Pax    || 0,
        booking_start: b.Booking_Start || "",
        booking_end:   b.Booking_End   || "",
        start_time:    b.Start_Time    || "",
        end_time:      b.End_Time      || "",
      };
    }).filter(b => b.cabin_number && b.id);

    // Booking IDs are what edit/cancel act on, so they're only sent to logged-in users.
    // The floor plan itself (status, client, times) stays visible to everyone as before.
    const authed = isAuthed(req);
    return res.status(200).json({
      status:   "success",
      authed,
      location: wantedLocation,
      date:     startDate,
      end_date: endDate,
      spaces:   authed ? spaces : stripIds(spaces),
      bookings: authed ? allBookings : [],
    });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
}

const bookingFields = b => ({
  id:            b.id,
  client:        b.client,
  purpose:       b.purpose,
  pax:           b.pax,
  booking_start: b.booking_start,
  booking_end:   b.booking_end,
});

// Long-term contracts occupy cabins on the floor plan. If the Contracts forms aren't set up in
// Creator yet (or Creator errors), the floor plan must keep working, so failures are logged and skipped.
async function loadContractRows(token, startDate, endDate) {
  try {
    const criteria = encodeURIComponent(
      `Status == "Active" && Start_Date <= "${toCreatorDate(endDate)}" && End_Date >= "${toCreatorDate(startDate)}"`
    );
    const [contracts, lines] = await Promise.all([
      creatorGetAll(`report/${cfg.CONTRACT_REPORT}?criteria=${criteria}`, token),
      creatorGetAll(`report/${cfg.LINE_REPORT}`, token),
    ]);
    return { contracts, lines };
  } catch (err) {
    console.error('contracts overlay skipped:', err.message);
    return { contracts: [], lines: [] };
  }
}

// Item ID -> the active contracts touching it in this range. Only items in the requested location
// are in itemById, so another location's contracts can never show up here.
function mapContractOccupancy({ contracts, lines }, itemById) {
  const contractsById = {};
  contracts.forEach(c => { contractsById[String(c.ID)] = c; });

  const out = {};
  lines.forEach(l => {
    const c = contractsById[refId(l.Contract)];
    const item = itemById[refId(l.Inventory_Items)];
    if (!c || !item || classify(item) !== 'leasable') return;
    const seats = Number(l.Seats) || 0;
    const entry = (out[String(item.ID)] ||= { seatsLeased: 0, contracts: [] });
    entry.seatsLeased += seats;
    entry.contracts.push({ company: c.Company_Name || "", start: c.Start_Date || "", end: c.End_Date || "", seats });
  });
  return out;
}

// Booking-shaped record so the existing tooltip/labels work unchanged. A cabin shows the contract that
// starts latest (same as bookings); shared open workspace shows every contract's seats together.
function contractBooking(entry, open) {
  const byStartDesc = entry.contracts.slice().sort((a, b) => fromCreatorDate(b.start).localeCompare(fromCreatorDate(a.start)));
  const latest = byStartDesc[0];
  if (!open) {
    return { id: "", client: latest.company, purpose: "Long-term contract", pax: latest.seats, booking_start: latest.start, booking_end: latest.end };
  }
  const byStart = byStartDesc.slice().reverse();
  const byEnd = entry.contracts.slice().sort((a, b) => fromCreatorDate(b.end).localeCompare(fromCreatorDate(a.end)));
  return {
    id: "",
    client: latest.company + (entry.contracts.length > 1 ? ` +${entry.contracts.length - 1} more` : ""),
    purpose: "Long-term contract",
    pax: entry.seatsLeased,
    booking_start: byStart[0].start,
    booking_end: byEnd[0].end,
  };
}

function stripIds(spaces) {
  return spaces.map(({ id, ...rest }) => (
    rest.slots ? { ...rest, slots: rest.slots.map(({ id: slotId, ...slot }) => slot) } : rest
  ));
}

// ── hourly slot helpers ──

// Creator dates come back as "DD-Mon-YYYY"; normalize to ISO for day-range comparisons
function parseCreatorDateToISO(d) {
  if (!d) return null;
  const m = /^(\d{2})-([A-Za-z]{3})-(\d{4})$/.exec(d);
  if (!m) return d;
  const months = { Jan:'01',Feb:'02',Mar:'03',Apr:'04',May:'05',Jun:'06',Jul:'07',Aug:'08',Sep:'09',Oct:'10',Nov:'11',Dec:'12' };
  return `${m[3]}-${months[m[2]]}-${m[1]}`;
}

// Creator's Start_Time/End_Time fields store "HH:mm:ss" (24hr)
function parseTimeToMinutes(t) {
  if (!t) return null;
  const m = /^(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM|am|pm)?$/.exec(String(t).trim());
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  const ap = m[3] ? m[3].toUpperCase() : null;
  if (ap === 'PM' && h !== 12) h += 12;
  if (ap === 'AM' && h === 12) h = 0;
  return h * 60 + min;
}

function minutesToHHMM(mins) {
  const h = String(Math.floor(mins / 60)).padStart(2, '0');
  const m = String(mins % 60).padStart(2, '0');
  return `${h}:${m}`;
}

function dateRangeDays(startDate, endDate) {
  const days = [];
  const cur = new Date(startDate + 'T00:00:00Z');
  const end = new Date(endDate + 'T00:00:00Z');
  while (cur <= end) {
    days.push(cur.toISOString().split('T')[0]);
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return days;
}

// Builds per-day slot info for an hourly space and determines whether every
// day in the queried range has zero free time (used for the floor-plan badge)
function buildHourlySlots(bookingsForCabin, startDate, endDate) {
  const days = dateRangeDays(startDate, endDate);
  const slots = [];
  const coveredByDay = {};
  days.forEach(d => { coveredByDay[d] = []; });

  bookingsForCabin.forEach(b => {
    const bStart = parseCreatorDateToISO(b.Booking_Start);
    const bEnd   = parseCreatorDateToISO(b.Booking_End);
    const hasTime = !!(b.Start_Time && b.End_Time);
    const startMin = hasTime ? parseTimeToMinutes(b.Start_Time) : BUSINESS_START_MIN;
    const endMin   = hasTime ? parseTimeToMinutes(b.End_Time)   : BUSINESS_END_MIN;
    if (startMin == null || endMin == null) return;
    const info = { id: b.ID || '', client: b.Client_Name || '', purpose: b.Purpose || '', pax: b.Total_Pax || 0, full_day: !hasTime };

    days.forEach(d => {
      if (!bStart || !bEnd || d < bStart || d > bEnd) return;
      slots.push({ date: d, start: minutesToHHMM(startMin), end: minutesToHHMM(endMin), ...info });
      coveredByDay[d].push([startMin, endMin]);
    });
  });

  let fullyBookedEveryDay = days.length > 0;
  days.forEach(d => {
    const intervals = coveredByDay[d].sort((a, b) => a[0] - b[0]);
    let coverage = 0, curEnd = BUSINESS_START_MIN;
    intervals.forEach(([s, e]) => {
      const start = Math.max(s, curEnd);
      if (e > start) { coverage += e - start; curEnd = Math.max(curEnd, e); }
    });
    if (coverage < (BUSINESS_END_MIN - BUSINESS_START_MIN)) fullyBookedEveryDay = false;
  });

  return { slots, fullyBookedEveryDay };
}
