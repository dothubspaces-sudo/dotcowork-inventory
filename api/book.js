export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { cabin_number, client_name, booking_start, booking_end, purpose, total_pax } = req.body || {};

  // Basic validation
  if (!cabin_number || !client_name || !booking_start || !booking_end || !purpose) {
    return res.status(400).json({ error: "Missing required fields" });
  }
  if (booking_end < booking_start) {
    return res.status(400).json({ error: "End date must be after start date" });
  }

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
    const base    = "https://creator.zoho.com/api/v2/dotcowork/workspace-inventory-manager";
    const headers = {
      Authorization:  `Zoho-oauthtoken ${token}`,
      "Content-Type": "application/json",
    };

    // Step 2 — find the Inventory_Items record ID for this cabin_number
    const itemsRes = await fetch(
      `${base}/report/Inventory_Items_Report?criteria=${encodeURIComponent(`Cabin_Number == "${cabin_number}"`)}&limit=1`,
      { headers }
    );
    const itemsData = await itemsRes.json();
    const item = (itemsData.data || [])[0];
    if (!item) {
      return res.status(404).json({ error: `No inventory item found for cabin: ${cabin_number}` });
    }
    const inventoryItemId = item.ID;

    // Step 3 — conflict check: is this cabin already booked in this date range?
    const conflictCriteria = encodeURIComponent(
      `Inventory_Items.ID == ${inventoryItemId} && Booking_Start <= "${booking_end}" && Booking_End >= "${booking_start}"`
    );
    const conflictRes  = await fetch(
      `${base}/report/All_Spaces?criteria=${conflictCriteria}&limit=1`,
      { headers }
    );
    const conflictData = await conflictRes.json();
    if ((conflictData.data || []).length > 0) {
      const existing = conflictData.data[0];
      return res.status(409).json({
        error: `${cabin_number} is already booked from ${existing.Booking_Start} to ${existing.Booking_End} by ${existing.Client_Name}.`,
      });
    }

    // Step 4 — create the Space_Bookings record
    const payload = {
      data: {
        Inventory_Items: inventoryItemId,
        Client_Name:     client_name,
        Booking_Start:   booking_start,
        Booking_End:     booking_end,
        Purpose:         purpose,
        Total_Pax:       total_pax || 0,
      },
    };

    const bookRes  = await fetch(`${base}/form/Space_Bookings`, {
      method:  "POST",
      headers,
      body:    JSON.stringify(payload),
    });
    const bookData = await bookRes.json();

    if (bookData.code === 3000 || bookRes.ok) {
      return res.status(200).json({
        status:  "success",
        message: `Booking confirmed for ${cabin_number}`,
        id:      bookData.data?.ID || null,
      });
    } else {
      return res.status(500).json({ error: "Creator rejected the booking", detail: bookData });
    }

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
}
