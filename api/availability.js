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

    // Step 3 — build booked map keyed by Cabin_Number
    // Booking has Inventory_Items lookup field → Cabin_Number
    const bookedMap = {};
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
    });

    // Step 4 — map every inventory item with its status
    const spaces = items.map(item => {
      const cabinNum = item.Cabin_Number || "";
      const booking  = bookedMap[cabinNum];
      return {
        cabin_number:   cabinNum,
        display_name:   item.Unit_Label     || cabinNum,
        workspace_type: item.Workspace_Type || "",
        capacity:       item.No_of_Seats    || item.Capacity || 0,
        location:       item.Location_Master?.display_value || "",
        status:         booking ? "Booked" : "Available",
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
