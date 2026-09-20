# Contracts: Zoho Creator and Vercel setup

The Contracts feature stores its data in the same Zoho Creator app as the rest of the inventory
(`dotcowork` / `workspace-inventory-manager`). The Creator API cannot create forms, so the two forms below
have to be built by hand in the Creator UI. Field **link names** must match exactly (they are the names in
the API). If you would rather use different names, change them in [`lib/config.js`](../lib/config.js).

## 1. Vercel environment variables

Set these for **Production and Preview**:

| Name | Value |
| --- | --- |
| `TEAM_PASSWORD` | The shared password the team types to sign in. Make it long. |
| `AUTH_SECRET` | A random string of 32+ characters. Used to sign login cookies. Changing it signs everyone out. |

The existing `ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET` and `ZOHO_REFRESH_TOKEN` stay as they are.

## 2. API scopes on the Zoho refresh token

Editing and cancelling bookings and everything in Contracts need more than read/create. The refresh token
must include:

```
ZohoCreator.form.CREATE
ZohoCreator.report.READ
ZohoCreator.report.UPDATE
ZohoCreator.report.DELETE
```

If it was generated with only read/create, edits and cancellations fail with an authorization error and a
new refresh token with these scopes is needed.

## 3. Form `Contracts`

Report link name: `Contracts_Report` (Creator's auto-created report, same pattern as `Inventory_Items_Report`; check it under the report's settings).

| Field link name | Type | Notes |
| --- | --- | --- |
| `Contract_No` | Auto number | Prefix `DC-`, e.g. `DC-0001`. Make this the lookup display value. |
| `Location_Master` | Lookup to Location Master | |
| `Company_Name` | Single line | Required |
| `Contact_Person` | Single line | Required |
| `Contact_Phone` | Single line | Required |
| `Contact_Email` | Email | Required. Renewal notices are sent here. |
| `Start_Date` | Date | Required |
| `End_Date` | Date | Required |
| `Total_Seats` | Number | Written by the app (sum of cabins) |
| `Monthly_Rent` | Currency / Decimal | Written by the app (sum of cabins) |
| `Security_Deposit` | Currency / Decimal | |
| `Status` | Dropdown: `Active`, `Terminated` | Default `Active` |
| `Renewal_Status` | Dropdown: `Not Due`, `Notice Sent`, `Renewed`, `Declined` | Default `Not Due` |
| `Renewal_Notice_Sent_On` | Date-Time | Set by the renewal workflow |
| `Renewed_From` | Lookup to Contracts | Links a renewal to the contract it replaces. Add it after the form is saved (it looks up its own form). |
| `Add_On_To` | Lookup to Contracts | Set by the **Add cabin** button: a cabin taken mid-agreement gets its own contract and term, linked to the contract it was added to. Add it after the form is saved. |
| `Contract_Doc_URL` | URL | Reserved for contract generation (later phase) |
| `Terminated_On` | Date | |
| `Notes` | Multi line | |

Only `Active` / `Terminated` are stored. "Upcoming", "Expiring" (30 days or less) and "Expired" are worked out
from the dates every time, so they never go stale.

## 4. Form `Contract_Cabins`

One row per cabin per contract. Report link name: `Contract_Cabins_Report`. Create `Contracts` first, since `Contract` looks it up.

| Field link name | Type | Notes |
| --- | --- | --- |
| `Contract` | Lookup to Contracts | Required |
| `Inventory_Items` | Lookup to Inventory Items | Required |
| `Seats` | Number | |
| `Monthly_Price` | Currency / Decimal | |

### Cabins added mid-agreement

A client who takes another cabin during their agreement gets a **new contract** for that cabin, with its own
start date, end date, price and renewal cycle, using **Add cabin** on the original contract's row. The new
contract is linked back through `Add_On_To`; the original is not changed. Each contract gets its own 30-day
renewal email, because the terms differ. Renewing an add-on keeps it linked to the contract it was added to.

## 5. Which items count as cabins

A cabin can be put under contract if its **Inventory Item** has a `Cabin_Number`, its `Workspace_Type`
contains the word "cabin" (e.g. `Private Cabin`), and it is not one of the hourly spaces (C-23, C-24, C-25,
Training Room, Auditorium). Meeting rooms, the board room, the training room and the auditorium can never be
put under a contract. Please confirm the real `Workspace_Type` values in Zoho; if the cabins use a different
word, tell us and we will adjust `CABIN_TYPE_PATTERN` in `lib/config.js`.

## 6. Renewal email (scheduled workflow, 30 days before expiry)

In Creator: **Workflow > Schedules > Create**, on form `Contracts`, frequency **Daily** at 09:00 in the
app's time zone (IST), with this record criteria:

```
Status == "Active" && Renewal_Status == "Not Due" && End_Date >= zoho.currentdate && End_Date <= zoho.currentdate.addDay(30)
```

Script (runs once per matching contract). Replace `team@yourdomain.com` with the team address to CC:

```deluge
cabinList = List();
for each line in Contract_Cabins[Contract == input.ID]
{
	cabinList.add(line.Inventory_Items.Cabin_Number);
}
cabins = cabinList.toString(", ");
endText = input.End_Date.toString("dd MMM yyyy");

sendmail
[
	from: zoho.adminuserid
	to: input.Contact_Email
	cc: "team@yourdomain.com"
	subject: "Your DOT Cowork agreement for " + cabins + " expires on " + endText
	message: "<p>Dear " + input.Contact_Person + ",</p>"
		+ "<p>This is a reminder that your agreement with DOT Cowork for <b>" + cabins + "</b> "
		+ "(" + input.Company_Name + ") ends on <b>" + endText + "</b>.</p>"
		+ "<p>To renew, please reply to this email or contact our team and we will prepare the renewal "
		+ "agreement for you.</p>"
		+ "<p>Regards,<br/>Team DOT Cowork</p>"
]

input.Renewal_Status = "Notice Sent";
input.Renewal_Notice_Sent_On = zoho.currenttime;
```

How it behaves:

- The window is "30 days or fewer", not "exactly 30". On a normal day the notice goes out on day 30. If a
  daily run is ever missed, the next run still catches the contract.
- Setting `Renewal_Status` to `Notice Sent` stops the same contract being emailed again.
- A contract created with fewer than 30 days left gets its notice on the next daily run.
- If a contract's end date is moved later (an extension) the app puts `Renewal_Status` back to `Not Due`, so the
  next 30-day notice still goes out.
- The sender needs to be allowed in Creator (`from: zoho.adminuserid` is the app admin). Send a test by
  running the schedule once against a contract ending in about 30 days.

## 7. Loading existing contracts

Creator's built-in **Import** can load a spreadsheet, so no code is needed: import the contracts into
`Contracts` first (dates as `dd-MMM-yyyy`), then import the cabin rows into `Contract_Cabins`, mapping each
row's `Contract` (by Contract No) and `Inventory_Items` (by Cabin Number).

## 8. First real test (before relying on it)

The code has been tested against a mock of Creator's API, not the live account. On a Vercel preview deployment:

1. Sign in, open **Contracts**. It should load (empty) with no error banner.
2. Create a throwaway contract for one cabin. Check it in Creator, then check the cabin shows **Booked** on the
   floor plan with the company name.
3. Try to create an overlapping contract for the same cabin. It should be refused.
4. Edit it (change the price), renew it, then terminate the renewal.
   Then use **Add cabin** on a contract, pick a different cabin with its own dates, and check the new contract
   shows "Add-on to DC-…" while the original shows "Add-ons: DC-…" and is unchanged.
5. On the floor plan's **Bookings** tab, edit and cancel a throwaway booking. This confirms the update/delete
   calls and the scopes in section 2.
6. Run the renewal schedule against a test contract ending in about 30 days and confirm the email and CC.
