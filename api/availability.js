const HOURLY_SPACES = new Set(['C-23', 'C-24', 'C-25', 'Training Room', 'Auditorium']);
const BUSINESS_START_MIN = 9 * 60;  // 9 AM
const BUSINESS_END_MIN   = 21 * 60; // 9 PM

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  // Accept ?date=YYYY-MM-DD&end_date=YYYY-MM-DD
  // If only date passed, end_date defaults to date (single day check)
  const startDate = req.query.date     || new Date().toISOString().split("T")[0];
  const endDate   = req.query.end_date || startDate;

  try {
    // Step 1 — access token
    const tokenRes = await fetch("https://accounts.zoho.com/oauth/v2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        refresh_token: process.env.ZOHO_REFRESH_TOKEN,
        client_id:     process.env.ZOHO_CLIENT_ID,
        client_secret: process.env.ZOHO_CLIENT_SECRET,
        grant_type:    "refresh_token",
      }),
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) {
      return res.status(500).json({ error: "Failed to get access token", detail: tokenData });
    }
    const token   = tokenData.access_token;
    const base    = "https://creator.zoho.com/api/v2/dotcowork/workspace-inventory-manager/report";
    const headers = { Authorization: `Zoho-oauthtoken ${token}` };

    // Step 2 — fetch all inventory items + bookings that overlap the date range
    // Overlap: Booking_Start <= endDate AND Booking_End >= startDate
    const bookingCriteria = encodeURIComponent(
      `Booking_Start <= "${endDate}" && Booking_End >= "${startDate}"`
    );

    const [itemsRes, bookingsRes] = await Promise.all([
      fetch(`${base}/Inventory_Items_Report?limit=200`, { headers }),
      fetch(`${base}/All_Spaces?criteria=${bookingCriteria}&limit=200`, { headers }),
    ]);

    const [itemsData, bookingsData] = await Promise.all([
      itemsRes.json(),
      bookingsRes.json(),
    ]);

    const items    = itemsData.data    || [];
    const bookings = bookingsData.data || [];

    // Step 3 — build booked map keyed by Cabin_Number (last-overlap wins, matches prior behavior)
    // and, for hourly spaces, collect every overlapping booking so slot-level availability can be derived
    const bookedMap = {};
    const bookingsByCabin = {};
    bookings.forEach(b => {
      const cabinNum = b.Inventory_Items?.display_value || b.Inventory_Items?.Cabin_Number || b.Inventory_Items || "";
      if (!cabinNum) return;
      bookedMap[cabinNum] = {
        client:        b.Client_Name  || "",
        purpose:       b.Purpose      || "",
        pax:           b.Total_Pax    || 0,
        booking_start: b.Booking_Start || "",
        booking_end:   b.Booking_End   || "",
      };
      if (HOURLY_SPACES.has(cabinNum)) {
        (bookingsByCabin[cabinNum] ||= []).push(b);
      }
    });

    // Step 4 — map every inventory item with its status
    const spaces = items.map(item => {
      const cabinNum = item.Cabin_Number || "";
      const booking  = bookedMap[cabinNum];
      const base = {
        cabin_number:   cabinNum,
        display_name:   item.Unit_Label     || cabinNum,
        workspace_type: item.Workspace_Type || "",
        capacity:       item.No_of_Seats    || item.Capacity || 0,
        location:       item.Location_Master?.display_value || "",
      };

      if (HOURLY_SPACES.has(cabinNum)) {
        const { slots, fullyBookedEveryDay } = buildHourlySlots(
          bookingsByCabin[cabinNum] || [], startDate, endDate
        );
        return {
          ...base,
          hourly: true,
          status: fullyBookedEveryDay ? "Booked" : "Available",
          slots,
          ...(booking ? {
            client:        booking.client,
            purpose:       booking.purpose,
            pax:           booking.pax,
            booking_start: booking.booking_start,
            booking_end:   booking.booking_end,
          } : {}),
        };
      }

      return {
        ...base,
        status: booking ? "Booked" : "Available",
        ...(booking ? {
          client:        booking.client,
          purpose:       booking.purpose,
          pax:           booking.pax,
          booking_start: booking.booking_start,
          booking_end:   booking.booking_end,
        } : {}),
      };
    });

    return res.status(200).json({
      status:   "success",
      date:     startDate,
      end_date: endDate,
      spaces,
    });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
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
  const cur = new Date(startDate + 'T00:00:00');
  const end = new Date(endDate + 'T00:00:00');
  while (cur <= end) {
    days.push(cur.toISOString().split('T')[0]);
    cur.setDate(cur.getDate() + 1);
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
    const info = { client: b.Client_Name || '', purpose: b.Purpose || '', pax: b.Total_Pax || 0, full_day: !hasTime };

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
