export default async function handler(req, res) {
  // CORS headers — allow any origin (aggregator portals)
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  try {
    // Step 1 — get fresh access token using refresh token
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
      console.error("Token error:", tokenData);
      return res.status(500).json({ error: "Failed to get access token", detail: tokenData });
    }

    const accessToken = tokenData.access_token;

    // Step 2 — call the Deluge standalone function
    const creatorRes = await fetch(
      "https://creator.zoho.com/api/v2/dotcowork/workspace-inventory-manager/function/get_inventory/execute",
      {
        method: "POST",
        headers: {
          Authorization: `Zoho-oauthtoken ${accessToken}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: "arguments={}",
      }
    );

    const raw = await creatorRes.text();

    // Step 3 — parse and return
    let data;
    try {
      data = JSON.parse(raw);
    } catch (e) {
      // Creator sometimes returns the function output as a string inside result
      data = { raw };
    }

    // If Creator wraps it in a result field, unwrap it
    if (data.result) {
      try {
        data = JSON.parse(data.result);
      } catch (e) {
        data = data.result;
      }
    }

    return res.status(200).json(data);

  } catch (err) {
    console.error("Inventory API error:", err);
    return res.status(500).json({ error: err.message });
  }
}
