const { getAccessToken, creatorGet, creatorGetAll, creatorPost, creatorPatch, creatorDelete } = require('./zoho.js')
const { requireAuth } = require('../lib/auth.js')
const { toCreatorDate, fromCreatorDate, isISODate, todayISO, daysBetween } = require('../lib/dates.js')
const cfg = require('../lib/config.js')

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const RENEWAL_STATUSES = ['Not Due', 'Notice Sent', 'Renewed', 'Declined']
const OPEN_RENEWAL = ['Not Due', 'Notice Sent']

class HttpError extends Error {
  constructor(status, message, extra) {
    super(message)
    this.status = status
    this.extra = extra || {}
  }
}

// ── Creator value helpers ──

const lookupId = v => (v && typeof v === 'object') ? String(v.ID || '') : (v == null ? '' : String(v))
const lookupName = v => (v && typeof v === 'object') ? String(v.display_value || '') : ''
const text = v => (v && typeof v === 'object') ? String(v.url || v.value || v.display_value || '') : (v == null ? '' : String(v))
const num = v => { const n = Number(String(v == null ? '' : v).replace(/,/g, '')); return Number.isFinite(n) ? n : 0 }
const round2 = n => Math.round(n * 100) / 100

// ── Reading ──

async function loadState(token) {
  const [items, contracts, lines] = await Promise.all([
    creatorGetAll(`report/${cfg.ITEMS_REPORT}`, token),
    creatorGetAll(`report/${cfg.CONTRACT_REPORT}`, token),
    creatorGetAll(`report/${cfg.LINE_REPORT}`, token),
  ])
  const itemsById = {}
  items.forEach(i => { itemsById[String(i.ID)] = i })
  const linesByContract = {}
  lines.forEach(l => { (linesByContract[lookupId(l.Contract)] ||= []).push(l) })
  return { items, itemsById, contracts, lines, linesByContract }
}

function isLeasableCabin(item) {
  const number = item.Cabin_Number
  return !!number && !cfg.HOURLY_SPACES.has(number) && cfg.CABIN_TYPE_PATTERN.test(String(item.Workspace_Type || ''))
}

function buildCatalog(items) {
  return items.filter(isLeasableCabin).map(i => ({
    item_id:        String(i.ID),
    cabin_number:   i.Cabin_Number,
    label:          i.Unit_Label || i.Cabin_Number,
    seats:          num(i.No_of_Seats || i.Capacity),
    workspace_type: i.Workspace_Type || '',
    location:       lookupName(i.Location_Master),
    location_id:    lookupId(i.Location_Master),
  })).sort((a, b) => a.cabin_number.localeCompare(b.cabin_number, undefined, { numeric: true }))
}

// Only Active/Terminated is stored in Creator; everything time-based is derived so it can't go stale.
function derivePhase(status, start, end, today) {
  if (status === 'Terminated') return 'terminated'
  if (start > today) return 'upcoming'
  if (end < today) return 'expired'
  return daysBetween(today, end) <= cfg.EXPIRING_DAYS ? 'expiring' : 'active'
}

function shapeContract(c, rawLines, itemsById, today) {
  const cabins = rawLines.map(l => {
    const item = itemsById[lookupId(l.Inventory_Items)] || {}
    return {
      line_id:       String(l.ID),
      item_id:       lookupId(l.Inventory_Items),
      cabin_number:  item.Cabin_Number || lookupName(l.Inventory_Items),
      seats:         num(l.Seats),
      monthly_price: num(l.Monthly_Price),
    }
  })
  const firstItem = cabins.length ? itemsById[cabins[0].item_id] : null
  const start = fromCreatorDate(c.Start_Date)
  const end = fromCreatorDate(c.End_Date)
  const status = c.Status || 'Active'
  return {
    id:                     String(c.ID),
    contract_no:            text(c.Contract_No),
    location:               lookupName(c.Location_Master) || (firstItem ? lookupName(firstItem.Location_Master) : ''),
    company_name:           text(c.Company_Name),
    contact_person:         text(c.Contact_Person),
    contact_phone:          text(c.Contact_Phone),
    contact_email:          text(c.Contact_Email),
    start_date:             start,
    end_date:               end,
    total_seats:            num(c.Total_Seats) || cabins.reduce((s, l) => s + l.seats, 0),
    monthly_rent:           num(c.Monthly_Rent) || cabins.reduce((s, l) => s + l.monthly_price, 0),
    security_deposit:       num(c.Security_Deposit),
    status,
    renewal_status:         c.Renewal_Status || 'Not Due',
    renewal_notice_sent_on: text(c.Renewal_Notice_Sent_On),
    renewed_from:           lookupId(c.Renewed_From),
    contract_doc_url:       text(c.Contract_Doc_URL),
    terminated_on:          fromCreatorDate(c.Terminated_On),
    notes:                  text(c.Notes),
    cabins,
    days_to_expiry:         end ? daysBetween(today, end) : null,
    phase:                  derivePhase(status, start, end, today),
  }
}

function withOccupancy(catalog, contracts) {
  const pick = c => c && {
    contract_id: c.id, contract_no: c.contract_no, company_name: c.company_name,
    start_date: c.start_date, end_date: c.end_date, days_to_expiry: c.days_to_expiry,
  }
  return catalog.map(cabin => {
    const uses = c => c.cabins.some(l => l.item_id === cabin.item_id)
    const current = contracts.find(c => (c.phase === 'active' || c.phase === 'expiring') && uses(c))
    const upcoming = contracts.filter(c => c.phase === 'upcoming' && uses(c))
      .sort((a, b) => a.start_date.localeCompare(b.start_date))[0]
    // Ended but never renewed/declined/terminated: the team still needs to act on it.
    const overdue = contracts.filter(c => c.phase === 'expired' && OPEN_RENEWAL.includes(c.renewal_status) && uses(c))
      .sort((a, b) => b.end_date.localeCompare(a.end_date))[0]
    return {
      ...cabin,
      state:         current ? 'occupied' : (overdue ? 'overdue' : 'vacant'),
      contract:      pick(current || overdue),
      next_contract: pick(upcoming),
    }
  })
}

function summarize(contracts, cabins) {
  const current = contracts.filter(c => c.phase === 'active' || c.phase === 'expiring')
  const within = n => current.filter(c => c.days_to_expiry <= n).length
  return {
    active_contracts:          current.length,
    cabins_total:              cabins.length,
    cabins_occupied:           cabins.filter(c => c.state === 'occupied').length,
    seats_occupied:            current.reduce((s, c) => s + c.total_seats, 0),
    monthly_recurring_revenue: round2(current.reduce((s, c) => s + c.monthly_rent, 0)),
    expiring_30:               within(30),
    expiring_60:               within(60),
    expiring_90:               within(90),
    renewals_pending:          current.filter(c => c.phase === 'expiring' && OPEN_RENEWAL.includes(c.renewal_status)).length,
    overdue:                   contracts.filter(c => c.phase === 'expired' && OPEN_RENEWAL.includes(c.renewal_status)).length,
  }
}

async function listContracts(req, res, token) {
  const state = await loadState(token)
  const today = todayISO()
  const wanted = String(req.query.location || '').trim().toLowerCase()
  const catalogAll = buildCatalog(state.items)

  let contracts = state.contracts
    .map(c => shapeContract(c, state.linesByContract[String(c.ID)] || [], state.itemsById, today))
    .sort((a, b) => a.end_date.localeCompare(b.end_date))
  let catalog = catalogAll
  if (wanted) {
    contracts = contracts.filter(c => c.location.toLowerCase() === wanted)
    catalog = catalogAll.filter(c => c.location.toLowerCase() === wanted)
  }

  const cabins = withOccupancy(catalog, contracts)
  return res.status(200).json({
    status:    'success',
    today,
    locations: [...new Set(catalogAll.map(c => c.location).filter(Boolean))],
    contracts,
    cabins,
    summary:   summarize(contracts, cabins),
  })
}

// ── Validation ──

function parseContractBody(body, catalogById) {
  const str = (v, max = 200) => String(v == null ? '' : v).trim().slice(0, max)
  const f = {
    company_name:     str(body.company_name),
    contact_person:   str(body.contact_person),
    contact_phone:    str(body.contact_phone, 40),
    contact_email:    str(body.contact_email),
    start_date:       str(body.start_date, 10),
    end_date:         str(body.end_date, 10),
    notes:            str(body.notes, 2000),
    security_deposit: round2(num(body.security_deposit)),
  }

  if (!f.company_name)   throw new HttpError(400, 'Company name is required')
  if (!f.contact_person) throw new HttpError(400, 'Contact person is required')
  if (!f.contact_phone)  throw new HttpError(400, 'Contact number is required')
  if (!EMAIL_RE.test(f.contact_email)) throw new HttpError(400, 'A valid contact email is required')
  if (!isISODate(f.start_date) || !isISODate(f.end_date)) throw new HttpError(400, 'Start and end dates are required')
  if (f.end_date <= f.start_date) throw new HttpError(400, 'End date must be after the start date')
  if (f.security_deposit < 0) throw new HttpError(400, 'Security deposit cannot be negative')

  const raw = Array.isArray(body.cabins) ? body.cabins : []
  if (!raw.length) throw new HttpError(400, 'Select at least one cabin')

  const seen = new Set()
  const lines = raw.map(l => {
    const itemId = String(l.item_id || '')
    const item = catalogById[itemId]
    if (!item) throw new HttpError(400, 'Only private cabins can be put under a contract (not meeting rooms, the board room, training room or auditorium)')
    if (seen.has(itemId)) throw new HttpError(400, `${item.cabin_number} is selected twice`)
    seen.add(itemId)
    const seats = l.seats == null || l.seats === '' ? item.seats : Number(l.seats)
    if (!Number.isInteger(seats) || seats < 1 || seats > 500) throw new HttpError(400, `Seats for ${item.cabin_number} must be a whole number`)
    const blank = l.monthly_price == null || String(l.monthly_price).trim() === ''
    const price = Number(l.monthly_price)
    if (blank || !Number.isFinite(price) || price < 0) throw new HttpError(400, `Enter a monthly price for ${item.cabin_number}`)
    return { item_id: itemId, seats, monthly_price: round2(price) }
  })

  const locationIds = new Set(lines.map(l => catalogById[l.item_id].location_id))
  if (locationIds.size > 1) throw new HttpError(400, 'All cabins in one contract must be in the same location')

  return { fields: f, lines, location_id: [...locationIds][0] || '' }
}

function contractPayload(input) {
  const { fields: f, lines, location_id } = input
  return {
    Company_Name:     f.company_name,
    Contact_Person:   f.contact_person,
    Contact_Phone:    f.contact_phone,
    Contact_Email:    f.contact_email,
    Start_Date:       toCreatorDate(f.start_date),
    End_Date:         toCreatorDate(f.end_date),
    Total_Seats:      lines.reduce((s, l) => s + l.seats, 0),
    Monthly_Rent:     round2(lines.reduce((s, l) => s + l.monthly_price, 0)),
    Security_Deposit: f.security_deposit,
    Notes:            f.notes,
    ...(location_id ? { Location_Master: location_id } : {}),
  }
}

// A cabin can't be in two overlapping contracts, and can't overlap an existing short-term booking.
async function assertNoConflicts(token, catalogById, state, { lines, start, end, excludeContractId }) {
  const clashes = []
  const wanted = new Set(lines.map(l => l.item_id))

  state.contracts.forEach(c => {
    if (String(c.ID) === String(excludeContractId) || (c.Status || 'Active') === 'Terminated') return
    const cStart = fromCreatorDate(c.Start_Date)
    const cEnd = fromCreatorDate(c.End_Date)
    if (!(cStart <= end && cEnd >= start)) return
    ;(state.linesByContract[String(c.ID)] || []).forEach(l => {
      const itemId = lookupId(l.Inventory_Items)
      if (wanted.has(itemId)) {
        clashes.push(`${catalogById[itemId].cabin_number} is already under contract ${text(c.Contract_No) || text(c.Company_Name)} (${cStart} to ${cEnd}).`)
      }
    })
  })

  await Promise.all(lines.map(async l => {
    const criteria = `Inventory_Items == ${l.item_id} && Booking_Start <= "${toCreatorDate(end)}" && Booking_End >= "${toCreatorDate(start)}"`
    const found = await creatorGet(`report/${cfg.BOOKINGS_REPORT}?criteria=${encodeURIComponent(criteria)}&limit=1`, token)
    const b = (found.data || [])[0]
    if (b) clashes.push(`${catalogById[l.item_id].cabin_number} has a booking for ${b.Client_Name} (${b.Booking_Start} to ${b.Booking_End}).`)
  }))

  if (clashes.length) throw new HttpError(409, clashes.join(' '))
}

// ── Writing ──

async function patchRecord(token, report, id, payload) {
  const r = await creatorPatch(`report/${report}/${id}`, payload, token)
  if (r.code !== 3000) throw new HttpError(500, 'Creator rejected the update', { detail: r })
}

async function insertContract(token, input, renewedFrom) {
  const payload = {
    ...contractPayload(input),
    Status:         'Active',
    Renewal_Status: 'Not Due',
    ...(renewedFrom ? { Renewed_From: renewedFrom } : {}),
  }
  const created = await creatorPost(`form/${cfg.CONTRACT_FORM}`, payload, token)
  if (created.code !== 3000 || !created.data || !created.data.ID) {
    throw new HttpError(500, 'Creator rejected the contract', { detail: created })
  }
  const contractId = created.data.ID
  const lineIds = []
  try {
    for (const l of input.lines) {
      const r = await creatorPost(`form/${cfg.LINE_FORM}`, {
        Contract: contractId, Inventory_Items: l.item_id, Seats: l.seats, Monthly_Price: l.monthly_price,
      }, token)
      if (r.code !== 3000 || !r.data || !r.data.ID) throw new Error(`Creator rejected a cabin line: ${JSON.stringify(r)}`)
      lineIds.push(r.data.ID)
    }
  } catch (err) {
    // Creator has no cross-form transaction, so undo what was written.
    for (const id of lineIds) await creatorDelete(`report/${cfg.LINE_REPORT}/${id}`, token).catch(() => {})
    await creatorDelete(`report/${cfg.CONTRACT_REPORT}/${contractId}`, token).catch(() => {})
    throw new HttpError(500, 'Could not save the cabins for this contract, so nothing was saved', { detail: err.message })
  }
  return contractId
}

// Add new cabins first, then update, then remove, so a mid-way failure leaves too many cabins, never too few.
async function syncLines(token, state, contractId, wantedLines) {
  const existing = state.linesByContract[String(contractId)] || []
  const existingByItem = {}
  existing.forEach(l => { existingByItem[lookupId(l.Inventory_Items)] = l })
  const wantedIds = new Set(wantedLines.map(l => l.item_id))

  for (const l of wantedLines.filter(l => !existingByItem[l.item_id])) {
    const r = await creatorPost(`form/${cfg.LINE_FORM}`, {
      Contract: contractId, Inventory_Items: l.item_id, Seats: l.seats, Monthly_Price: l.monthly_price,
    }, token)
    if (r.code !== 3000) throw new HttpError(500, 'Creator rejected a cabin line', { detail: r })
  }
  for (const l of wantedLines.filter(l => existingByItem[l.item_id])) {
    await patchRecord(token, cfg.LINE_REPORT, existingByItem[l.item_id].ID, { Seats: l.seats, Monthly_Price: l.monthly_price })
  }
  for (const l of existing.filter(l => !wantedIds.has(lookupId(l.Inventory_Items)))) {
    const r = await creatorDelete(`report/${cfg.LINE_REPORT}/${l.ID}`, token)
    if (r.code !== 3000) throw new HttpError(500, 'Creator rejected removing a cabin', { detail: r })
  }
}

async function saveNewContract(req, res, token, renewedFrom) {
  const state = await loadState(token)
  const catalogById = {}
  buildCatalog(state.items).forEach(c => { catalogById[c.item_id] = c })
  const input = parseContractBody(req.body || {}, catalogById)
  await assertNoConflicts(token, catalogById, state, {
    lines: input.lines, start: input.fields.start_date, end: input.fields.end_date, excludeContractId: renewedFrom,
  })
  const id = await insertContract(token, input, renewedFrom)
  return { id, state }
}

async function createContract(req, res, token) {
  const { id } = await saveNewContract(req, res, token, null)
  return res.status(200).json({ status: 'success', id, message: 'Contract created' })
}

async function renewContract(req, res, token, oldId) {
  if (!oldId) throw new HttpError(400, 'Missing contract id')
  const state = await loadState(token)
  const old = state.contracts.find(c => String(c.ID) === String(oldId))
  if (!old) throw new HttpError(404, 'Contract not found')
  if ((old.Status || 'Active') === 'Terminated') throw new HttpError(400, 'A terminated contract cannot be renewed')

  const { id } = await saveNewContract(req, res, token, oldId)
  let warning
  try {
    await patchRecord(token, cfg.CONTRACT_REPORT, oldId, { Renewal_Status: 'Renewed' })
  } catch (err) {
    warning = 'The renewed contract was created, but the old one could not be marked as Renewed. Please update it manually.'
  }
  return res.status(200).json({ status: 'success', id, message: 'Contract renewed', ...(warning ? { warning } : {}) })
}

async function updateContract(req, res, token, id) {
  if (!id) throw new HttpError(400, 'Missing contract id')
  const body = req.body || {}
  const state = await loadState(token)
  const existing = state.contracts.find(c => String(c.ID) === String(id))
  if (!existing) throw new HttpError(404, 'Contract not found')
  if ((existing.Status || 'Active') === 'Terminated') throw new HttpError(400, 'This contract is terminated and can no longer be changed')

  if (body.action === 'terminate') {
    await patchRecord(token, cfg.CONTRACT_REPORT, id, { Status: 'Terminated', Terminated_On: toCreatorDate(todayISO()) })
    return res.status(200).json({ status: 'success', message: 'Contract terminated' })
  }

  if (body.action === 'renewal_status') {
    if (!RENEWAL_STATUSES.includes(body.renewal_status)) throw new HttpError(400, 'Invalid renewal status')
    await patchRecord(token, cfg.CONTRACT_REPORT, id, { Renewal_Status: body.renewal_status })
    return res.status(200).json({ status: 'success', message: 'Renewal status updated' })
  }

  const catalogById = {}
  buildCatalog(state.items).forEach(c => { catalogById[c.item_id] = c })
  const input = parseContractBody(body, catalogById)
  await assertNoConflicts(token, catalogById, state, {
    lines: input.lines, start: input.fields.start_date, end: input.fields.end_date, excludeContractId: id,
  })

  await syncLines(token, state, id, input.lines)
  const payload = contractPayload(input)
  // A moved end date (e.g. an informal extension) restarts the renewal cycle so the next 30-day notice still goes out.
  if (fromCreatorDate(existing.End_Date) !== input.fields.end_date) payload.Renewal_Status = 'Not Due'
  await patchRecord(token, cfg.CONTRACT_REPORT, id, payload)
  return res.status(200).json({ status: 'success', message: 'Contract updated' })
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store')
  if (!requireAuth(req, res)) return
  try {
    const token = await getAccessToken()
    const { action, id } = req.query
    if (req.method === 'GET') return await listContracts(req, res, token)
    if (req.method === 'POST' && action === 'renew') return await renewContract(req, res, token, id)
    if (req.method === 'POST') return await createContract(req, res, token)
    if (req.method === 'PATCH') return await updateContract(req, res, token, id)
    return res.status(405).json({ error: 'Method not allowed' })
  } catch (err) {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, ...err.extra })
    console.error('contracts.js error:', err)
    return res.status(500).json({ error: err.message })
  }
}
