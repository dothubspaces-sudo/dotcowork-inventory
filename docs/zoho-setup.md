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

Report link name: `All_Contracts`.

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

## 6. Renewal reminders and overdue alerts (two Creator schedules)

Both run on form `Contracts`, **Daily at 09:00** in the app's time zone (IST). Sender is
`renewals@dotcoworking.com`, which must be an allowed sender in Creator (verify the address in Creator's email/sender
settings, and set up SPF/DKIM for the domain so the mail is not filtered as spam). If a script errors on the `from`
address, that is the cause.

### 6a. Renewal reminders: 30, 14, 7 and 3 days before the end date

**Record criteria:**

```
Status == "Active" && (Renewal_Status == "Not Due" || Renewal_Status == "Notice Sent") && End_Date >= zoho.currentdate && End_Date <= zoho.currentdate.addDay(30)
```

**Script** (runs once per matching contract; the client is emailed, the team is CC'd):

```deluge
sender = "renewals@dotcoworking.com";
ccList = "manager@dotcoworking.com, shiva@dotcoworking.com, sales@dotcoworking.com, manoj@dotcoworking.com";

// Days left until the end date (the criteria guarantees it is today or later)
daysLeft = zoho.currentdate.daysBetween(input.End_Date).abs().toLong();

// Which reminder we are now due for: 30, 14, 7 or 3 days before the end
if(daysLeft <= 3)
{
	stage = 3;
}
else if(daysLeft <= 7)
{
	stage = 7;
}
else if(daysLeft <= 14)
{
	stage = 14;
}
else
{
	stage = 30;
}

// Which reminder was sent last. It is worked out from the date the last notice went out, so no extra
// field is needed, and an extended end date automatically restarts the 30/14/7/3 cycle.
lastStage = 999;
if(input.Renewal_Notice_Sent_On != null)
{
	lastNoticeDate = input.Renewal_Notice_Sent_On.toDate();
	if(lastNoticeDate <= input.End_Date)
	{
		daysLeftAtLastNotice = lastNoticeDate.daysBetween(input.End_Date).abs().toLong();
		if(daysLeftAtLastNotice <= 3)
		{
			lastStage = 3;
		}
		else if(daysLeftAtLastNotice <= 7)
		{
			lastStage = 7;
		}
		else if(daysLeftAtLastNotice <= 14)
		{
			lastStage = 14;
		}
		else if(daysLeftAtLastNotice <= 30)
		{
			lastStage = 30;
		}
	}
}

// Send only when a new (closer) reminder is due. Never sends twice for the same stage, and if a daily
// run was missed the next run sends the current stage instead of the missed one.
if(stage < lastStage)
{
	cabinList = List();
	for each line in Contract_Cabins[Contract == input.ID]
	{
		cabinList.add(line.Inventory_Items.Cabin_Number);
	}
	cabins = cabinList.toString(", ");
	endText = input.End_Date.toString("dd MMM yyyy");
	dayWord = if(daysLeft == 1, "day", "days");

	sendmail
	[
		from: sender
		to: input.Contact_Email
		cc: ccList
		subject: "Reminder: your DOT Cowork agreement for " + cabins + " ends in " + daysLeft + " " + dayWord + " (" + endText + ")"
		message: "<p>Dear " + input.Contact_Person + ",</p>"
			+ "<p>This is a reminder that your agreement with DOT Cowork for <b>" + cabins + "</b> "
			+ "(" + input.Company_Name + ") ends on <b>" + endText + "</b>, which is in <b>" + daysLeft + " " + dayWord + "</b>.</p>"
			+ "<p>To renew, please reply to this email or contact our team and we will prepare the renewal "
			+ "agreement for you.</p>"
			+ "<p>Regards,<br/>Team DOT Cowork</p>"
	]

	input.Renewal_Status = "Notice Sent";
	input.Renewal_Notice_Sent_On = zoho.currenttime;
}
```

How it behaves:

- One email when 30 days or fewer remain, then again at 14 or fewer, 7 or fewer and 3 or fewer. Each stage is sent once.
- A contract created with, say, 10 days left gets the 14-day-stage email on the next run, then the 7 and 3-day ones.
- It stops as soon as `Renewal_Status` becomes `Renewed` or `Declined` (the portal's **Renew** button sets `Renewed`), or
  the contract is terminated. If the team renews outside the portal, set `Renewal_Status` by hand or the reminders
  keep going.
- An add-on cabin has its own end date, so it gets its own reminders.

### 6b. Overdue alert: contracts past their end date with no decision

Goes to the **team only** (not the client), on the day after the end date and then every 7 days (day 1, 8, 15, 22, ...).

**Record criteria:**

```
Status == "Active" && (Renewal_Status == "Not Due" || Renewal_Status == "Notice Sent") && End_Date < zoho.currentdate
```

**Script:**

```deluge
sender = "renewals@dotcoworking.com";
teamList = "manager@dotcoworking.com, shiva@dotcoworking.com, sales@dotcoworking.com, manoj@dotcoworking.com";

daysOverdue = input.End_Date.daysBetween(zoho.currentdate).abs().toLong();

// The schedule runs daily; only send on day 1 after the end date and every 7 days after that
if(daysOverdue % 7 == 1)
{
	cabinList = List();
	for each line in Contract_Cabins[Contract == input.ID]
	{
		cabinList.add(line.Inventory_Items.Cabin_Number);
	}
	cabins = cabinList.toString(", ");
	endText = input.End_Date.toString("dd MMM yyyy");
	dayWord = if(daysOverdue == 1, "day", "days");

	sendmail
	[
		from: sender
		to: teamList
		subject: "Action needed: " + input.Contract_No + " (" + input.Company_Name + ") ended " + daysOverdue + " " + dayWord + " ago"
		message: "<p>The following contract has ended and has no renewal decision recorded.</p>"
			+ "<p><b>" + input.Contract_No + "</b> - " + input.Company_Name + "<br/>"
			+ "Cabins: " + cabins + "<br/>"
			+ "Ended: " + endText + " (" + daysOverdue + " " + dayWord + " ago)<br/>"
			+ "Contact: " + input.Contact_Person + ", " + input.Contact_Phone + ", " + input.Contact_Email + "</p>"
			+ "<p>Please renew it or terminate it in the portal's Contracts tab. "
			+ "This alert repeats every 7 days until the contract is renewed, declined or terminated.</p>"
	]
}
```

The alert stops when the contract is renewed (the portal's **Renew** button), its renewal status is set to `Declined`, or it
is terminated.

### 6c. Testing safely

These scripts send real email. Test on a hand-made contract (with one `Contract_Cabins` row):

- Use **your own address** as `Contact_Email`, and temporarily change `ccList` / `teamList` to your own address too.
- Renewal: try end dates of 29, 13, 6 and 2 days from today. Each should send one email when the schedule runs, and
  running it again should send nothing.
- Overdue: an end date 1 day ago should send, 3 days ago should not, 8 days ago should send.
- If a run sends nothing, or the numbers in the email look wrong (for example a negative number of days), tell us. That
  points to the sign of `daysBetween` in your Creator version.
- Put the real team addresses back afterwards and delete the test records.

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
6. Run both schedules against test contracts as described in section 6c and confirm the emails and CC.
