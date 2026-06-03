export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    // Step 1 — get fresh access token
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
    const token = tokenData.access_token;
    const base = "https://creator.zoho.com/api/v2/dotcowork/workspace-inventory-manager/report";
    const headers = { Authorization: `Zoho-oauthtoken ${token}` };

    // Step 2 — fetch all 4 reports in parallel
    const [locRes, invRes, priceRes, voRes] = await Promise.all([
      fetch(`${base}/Location_Master_Report?criteria=Status%3D%3D%22Active%22&limit=200`, { headers }),
      fetch(`${base}/Inventory_Items_Report?criteria=Status%3D%3D%22Available%22&limit=200`, { headers }),
      fetch(`${base}/Pricing_Master_Report?limit=200`, { headers }),
      fetch(`${base}/VO_Pricing_Report?limit=200`, { headers }),
    ]);

    const [locData, invData, priceData, voData] = await Promise.all([
      locRes.json(), invRes.json(), priceRes.json(), voRes.json()
    ]);

    const locations = (locData.data || []);
    const inventory = (invData.data || []);
    const pricing   = (priceData.data || []);
    const vo        = (voData.data || []);

    // Step 3 — join data by location ID
    const result = locations.map(loc => {
      const locId = loc.ID;
      return {
        id:          loc.Location_Slug,
        name:        loc.Location_Name,
        subtitle:    loc.Location_Subtitle,
        address:     loc.Address,
        maps_url:    (loc.Google_Maps_URL || "").replace(/<[^>]+>/g, "").trim(),
        website_url: (loc.Website_URL || "").replace(/<[^>]+>/g, "").trim(),
        tagline:     loc.Tagline,
        inventory: inventory
          .filter(i => i.Location_Master?.ID == locId)
          .map(i => ({
            workspace_type: i.Workspace_Type,
            no_of_seats:    i.No_of_Seats,
            quantity:       i.Quantity,
            unit_label:     i.Unit_Label,
            status:         i.Status,
            display_order:  i.Display_Order,
          }))
          .sort((a,b) => (a.display_order||99) - (b.display_order||99)),
        pricing: (() => {
          const p = pricing.find(p => p.Location_Master?.ID == locId);
          return p ? {
            price_per_seat_month:  p.Price_Per_Seat_Month,
            aggregator_commission: p.Aggregator_Commission,
          } : {};
        })(),
        vo_pricing: vo
          .filter(v => v.Location_Master?.ID == locId)
          .map(v => ({
            price_per_year:        v.Price_Per_Year,
            features:              v.Features_field,
            aggregator_commission: v.Aggregator_Commission,
          })),
      };
    });

    return res.status(200).json({ status: "success", locations: result });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
}
