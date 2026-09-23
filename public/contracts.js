// Contracts tab for the floor plan page. Self-contained: everything is private to this
// closure except the CT object, and all element ids/classes are prefixed ct/ct- so nothing
// here can touch the floor plan, bookings or meeting-room code.
(function(){
// This page is Tharamani's. Creator names that location by its slug ("tidel-omr"), so the first request asks for
// "Tharamani", finds nothing by that name, and switches to whichever location matches this pattern.
const DEFAULT_LOCATION='Tharamani';
const DEFAULT_LOCATION_PATTERN=/tharamani|tidel/i;
// What people see. The slug only shows when there is more than one location to tell apart.
const place=()=>data&&data.locations.length>1?curLoc:DEFAULT_LOCATION;
const $=n=>document.getElementById('ct'+n.charAt(0).toUpperCase()+n.slice(1));
const esc=s=>String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const inr=n=>new Intl.NumberFormat('en-IN',{style:'currency',currency:'INR',maximumFractionDigits:0}).format(n||0);
const ymd=d=>d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
const fmtDate=iso=>iso?new Date(iso+'T00:00:00').toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric'}):'—';
const addDays=(iso,n)=>{const d=new Date(iso+'T00:00:00');d.setDate(d.getDate()+n);return ymd(d);};
const diffDays=(a,b)=>Math.round((new Date(b+'T00:00:00')-new Date(a+'T00:00:00'))/86400000);

let data=null,curLoc=DEFAULT_LOCATION,filter='current',query='',form=null;

const FILTERS=[
  ['current','Current',c=>c.phase==='active'||c.phase==='expiring'],
  ['expiring','Expiring ≤30d',c=>c.phase==='expiring'],
  ['upcoming','Upcoming',c=>c.phase==='upcoming'],
  ['expired','Expired',c=>c.phase==='expired'],
  ['terminated','Terminated',c=>c.phase==='terminated'],
  ['all','All',()=>true]
];

/* ── messages ── */
let bannerTimer=null;
function notify(msg,kind){
  const b=$('banner');
  b.className=kind||'ok';b.textContent=msg;
  clearTimeout(bannerTimer);
  if(kind!=='err')bannerTimer=setTimeout(()=>{b.className='';},6000);
}

/* ── loading ── */
async function load(retriedLoc){
  $('gate').style.display='none';
  try{
    const r=await apiFetch('/api/contracts?location='+encodeURIComponent(curLoc));
    if(r.status===401){showGate();return;}
    const d=await r.json();
    if(!r.ok||d.status!=='success'){
      $('content').style.display='none';
      notify((d.error||'Could not load contracts')+'. If the Contracts forms have not been created in Zoho Creator yet, see docs/zoho-setup.md.','err');
      return;
    }
    if(!retriedLoc&&d.locations.length&&!d.locations.some(l=>l.toLowerCase()===curLoc.toLowerCase())){
      curLoc=d.locations.find(l=>DEFAULT_LOCATION_PATTERN.test(l))||d.locations[0];return load(true);
    }
    data=d;
    $('banner').className='';
    render();
  }catch(e){
    notify('Could not reach the server.','err');
  }
}

function showGate(){
  $('content').style.display='none';
  $('gate').style.display='';
}

async function signOut(){
  try{await fetch('/api/auth',{method:'DELETE'});}catch(e){}
  data=null;showGate();
}

function changeLocation(v){curLoc=v;load();}
function onSearch(v){query=v.trim().toLowerCase();renderTable();}

/* ── rendering ── */
function render(){
  $('content').style.display='';
  const locs=data.locations.length?data.locations:[curLoc];
  $('locSel').style.display=locs.length>1?'':'none';
  $('locSel').innerHTML=locs.map(l=>`<option ${l.toLowerCase()===curLoc.toLowerCase()?'selected':''}>${esc(l)}</option>`).join('');
  renderCards();renderOccupancy();renderChips();renderTable();
}

function renderCards(){
  const s=data.summary;
  const pct=s.cabins_total?Math.round(s.cabins_occupied/s.cabins_total*100):0;
  $('cards').innerHTML=[
    ['Active contracts',s.active_contracts,'',''],
    ['Cabins occupied',`${s.cabins_occupied} / ${s.cabins_total}`,`${pct}% occupancy`,''],
    ['Seats occupied',s.seats_occupied,'',''],
    ['Monthly revenue',inr(s.monthly_recurring_revenue),'from active contracts',''],
    ['Expiring ≤30 days',s.expiring_30,`${s.expiring_60} in 60 · ${s.expiring_90} in 90`,s.expiring_30?'warn':''],
    ['Renewals pending',s.renewals_pending,s.overdue?`${s.overdue} expired, no action taken`:'nothing overdue',s.overdue?'bad':(s.renewals_pending?'warn':'')]
  ].map(([k,v,sub,cls])=>`<div class="ct-card ${cls}"><div class="ct-k">${k}</div><div class="ct-v">${esc(v)}</div><div class="ct-s">${esc(sub)}</div></div>`).join('');
}

function renderOccupancy(){
  if(!data.cabins.length){
    const g=data.diagnostics;
    const seen=g?`<br/><span class="ct-sub">Read ${g.items_read} inventory items; ${g.with_cabin_number} have a Cabin Number. Workspace Types seen: ${g.workspace_types.length?esc(g.workspace_types.join(', ')):'none'}. Fields returned: ${g.fields_seen.length?esc(g.fields_seen.join(', ')):'none'}.</span>`:'';
    $('occ').innerHTML=`<div class="ct-empty" style="grid-column:1/-1">No leasable cabins found for this location. Cabins are picked up from Inventory Items that have a Cabin Number and a Workspace Type containing "cabin" (meeting rooms, the board room, training room and auditorium are always left out).${seen}</div>`;
    return;
  }
  $('occ').innerHTML=data.cabins.map(c=>{
    let cls='',line='Vacant';
    if(c.state==='occupied'){
      const d=c.contract.days_to_expiry;
      cls=d<=7?'ct-cab-bad':(d<=30?'ct-cab-warn':'ct-cab-ok');
      line=`${esc(c.contract.company_name)}<br>${d} day${d===1?'':'s'} left`;
    }else if(c.state==='overdue'){
      cls='ct-cab-bad';line=`${esc(c.contract.company_name)}<br>Expired ${fmtDate(c.contract.end_date)}`;
    }else if(c.next_contract){
      line=`Leased from ${fmtDate(c.next_contract.start_date)}`;
    }
    const act=c.contract?`CT.openForm('edit','${esc(c.contract.contract_id)}')`:`CT.openForm('create',null,'${esc(c.item_id)}')`;
    return `<button class="ct-cab ${cls}" onclick="${act}"><b>${esc(c.cabin_number)}</b><small>${c.seats} seat${c.seats===1?'':'s'}</small><small>${line}</small></button>`;
  }).join('');
}

function renderChips(){
  $('chips').innerHTML=FILTERS.map(([key,label,fn])=>{
    const n=data.contracts.filter(fn).length;
    return `<button class="ct-chip ${filter===key?'on':''}" onclick="CT.setFilter('${key}')">${label}<em>${n}</em></button>`;
  }).join('');
}

function setFilter(k){filter=k;renderChips();renderTable();}

// Contract number for a contract id, shown in the add-on links. The linked contract can be in
// another location (and so not in this list), in which case there is nothing better to show.
function contractNo(id){
  const c=data&&data.contracts.find(x=>x.id===id);
  return (c&&c.contract_no)||'another contract';
}

function phaseBadge(c){
  switch(c.phase){
    case 'active':return '<span class="ct-badge ct-b-active">Active</span>';
    case 'expiring':return '<span class="ct-badge ct-b-expiring">Expiring</span>';
    case 'expired':return '<span class="ct-badge ct-b-expired">Expired</span>';
    case 'upcoming':return '<span class="ct-badge ct-b-upcoming">Upcoming</span>';
    default:return '<span class="ct-badge ct-b-terminated">Terminated</span>';
  }
}

function daysLeft(c){
  if(c.phase==='terminated')return `<span class="ct-sub">${c.terminated_on?fmtDate(c.terminated_on):''}</span>`;
  if(c.phase==='upcoming')return `starts in ${diffDays(data.today,c.start_date)}d`;
  const d=c.days_to_expiry;
  if(d<0)return `<span class="ct-days-bad">${-d}d ago</span>`;
  return `<span class="${d<=7?'ct-days-bad':(d<=30?'ct-days-warn':'')}">${d}d left</span>`;
}

function renewalCell(c){
  if(c.phase==='terminated')return '<span class="ct-sub">—</span>';
  const opts=['Not Due','Notice Sent','Renewed','Declined'].map(o=>`<option ${o===c.renewal_status?'selected':''}>${o}</option>`).join('');
  return `<select class="ct-rsel" onchange="CT.setRenewal('${esc(c.id)}',this)">${opts}</select>`;
}

function renderTable(){
  const fn=FILTERS.find(f=>f[0]===filter)[2];
  const rows=data.contracts.filter(fn).filter(c=>{
    if(!query)return true;
    const hay=[c.contract_no,c.company_name,c.contact_person,c.contact_phone,c.contact_email,...c.cabins.map(l=>l.cabin_number)].join(' ').toLowerCase();
    return hay.includes(query);
  });
  if(!rows.length){
    $('tbody').innerHTML=`<tr><td colspan="9" class="ct-empty">${data.contracts.length?'No contracts match this view.':'No contracts yet. Add the first one with “+ New contract”.'}</td></tr>`;
    return;
  }
  const addOns={};
  data.contracts.forEach(c=>{if(c.add_on_to)(addOns[c.add_on_to]||(addOns[c.add_on_to]=[])).push(c.contract_no||'—');});
  $('tbody').innerHTML=rows.map(c=>{
    const canAdd=c.phase==='active'||c.phase==='expiring'||c.phase==='upcoming';
    const acts=c.phase==='terminated'?'':
      `<button class="ct-abtn" onclick="CT.openForm('edit','${esc(c.id)}')">Edit</button>
       <button class="ct-abtn" onclick="CT.openForm('renew','${esc(c.id)}')">Renew</button>
       ${canAdd?`<button class="ct-abtn" onclick="CT.openForm('addon','${esc(c.id)}')">Add cabin</button>`:''}
       <button class="ct-abtn danger" onclick="CT.confirmThenRun(this,()=>CT.terminate('${esc(c.id)}'))">Terminate</button>`;
    const links=[
      c.add_on_to?`Add-on to ${esc(contractNo(c.add_on_to))}`:'',
      addOns[c.id]?`Add-ons: ${esc(addOns[c.id].join(', '))}`:''
    ].filter(Boolean).map(t=>`<div class="ct-sub">${t}</div>`).join('');
    return `<tr>
      <td>${esc(c.contract_no||'—')}</td>
      <td><div class="ct-co">${esc(c.company_name)}</div><div class="ct-sub">${esc(c.contact_person)} · ${esc(c.contact_phone)}</div><div class="ct-sub">${esc(c.contact_email)}</div>${links}</td>
      <td>${c.cabins.map(l=>`<span class="ct-tag">${esc(l.cabin_number)}</span>`).join('')}</td>
      <td>${c.total_seats}</td>
      <td>${inr(c.monthly_rent)}</td>
      <td>${fmtDate(c.start_date)}<div class="ct-sub">→ ${fmtDate(c.end_date)}</div></td>
      <td>${phaseBadge(c)}<div class="ct-sub">${daysLeft(c)}</div></td>
      <td>${renewalCell(c)}</td>
      <td><div class="ct-actions">${acts}</div></td>
    </tr>`;
  }).join('');
}

/* ── two-click confirm (same pattern as the Bookings tab) ── */
function confirmThenRun(btn,runFn){
  if(btn.dataset.confirming==='1'){
    clearTimeout(btn._t);btn.dataset.confirming='0';runFn();return;
  }
  btn.dataset.confirming='1';btn._orig=btn.textContent;btn.textContent='Click again to confirm';
  btn._t=setTimeout(()=>{btn.dataset.confirming='0';btn.textContent=btn._orig;},4000);
}

/* ── row actions ── */
async function terminate(id){
  const r=await apiFetch('/api/contracts?id='+encodeURIComponent(id),{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'terminate'})});
  const d=await r.json().catch(()=>({}));
  if(r.ok&&d.status==='success'){notify('Contract terminated.','ok');load();}
  else notify(d.error||'Could not terminate the contract.','err');
}

async function setRenewal(id,sel){
  const r=await apiFetch('/api/contracts?id='+encodeURIComponent(id),{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'renewal_status',renewal_status:sel.value})});
  const d=await r.json().catch(()=>({}));
  if(r.ok&&d.status==='success')notify('Renewal status updated.','ok');
  else notify(d.error||'Could not update the renewal status.','err');
  load();
}

/* ── create / edit / renew form ── */
function openForm(mode,id,presetItemId){
  if(!data)return;
  const c=id?data.contracts.find(x=>x.id===id):null;
  // 'addon' = an extra cabin for an existing client, on its own contract and term, linked to the one clicked.
  form={mode,id:c?c.id:null,excludeId:(mode==='create'||mode==='addon')?null:(c?c.id:null),cabins:{}};
  const tags={create:'New contract',edit:'Edit contract',renew:'Renew contract',addon:'Add cabin'};
  $('mTag').textContent=tags[mode];
  $('mTitle').textContent=c?c.company_name:place();
  $('mSub').textContent=mode==='renew'?'Next term — dates and cabins are prefilled from the current contract.':
    (mode==='addon'?'Own start and end date. Set the term for the new cabin(s) below.':`${place()} · private cabins only`);
  $('mSubmit').textContent=mode==='edit'?'Save changes':(mode==='renew'?'Create renewal':(mode==='addon'?'Add cabin contract':'Create contract'));
  $('mErr').textContent='';
  $('mSubmit').disabled=false;

  const meta=$('mMeta');
  if(c&&mode==='edit'){
    meta.style.display='';
    meta.innerHTML=`${esc(c.contract_no||'')} · Renewal: <b>${esc(c.renewal_status)}</b>${c.renewal_notice_sent_on?` (notice sent ${esc(c.renewal_notice_sent_on)})`:''}${c.renewed_from?' · renewal of an earlier contract':''}${c.add_on_to?` · add-on to ${esc(contractNo(c.add_on_to))}`:''}`;
  }else if(c&&mode==='addon'){
    meta.style.display='';
    meta.innerHTML=`Linked to ${esc(c.contract_no||'the current contract')} (${fmtDate(c.start_date)} → ${fmtDate(c.end_date)}). That contract is not changed.`;
  }else meta.style.display='none';

  const today=data.today;
  if(c&&mode==='addon'){
    $('fCompany').value=c.company_name;$('fPerson').value=c.contact_person;$('fPhone').value=c.contact_phone;$('fEmail').value=c.contact_email;
    $('fDeposit').value='';$('fNotes').value='';
    $('fStart').value=today;$('fEnd').value=addDays(addDays(today,365),-1);
  }else if(c){
    $('fCompany').value=c.company_name;$('fPerson').value=c.contact_person;$('fPhone').value=c.contact_phone;$('fEmail').value=c.contact_email;
    $('fDeposit').value=c.security_deposit||'';$('fNotes').value=c.notes;
    c.cabins.forEach(l=>{form.cabins[l.item_id]={seats:l.seats,price:l.monthly_price};});
    if(mode==='renew'){
      const span=diffDays(c.start_date,c.end_date);
      const start=addDays(c.end_date,1);
      $('fStart').value=start;$('fEnd').value=addDays(start,span);
    }else{$('fStart').value=c.start_date;$('fEnd').value=c.end_date;}
  }else{
    ['fCompany','fPerson','fPhone','fEmail','fDeposit','fNotes'].forEach(k=>{$(k).value='';});
    $('fStart').value=today;$('fEnd').value=addDays(addDays(today,365),-1);
    const preset=presetItemId&&data.cabins.find(x=>x.item_id===presetItemId);
    if(preset)form.cabins[preset.item_id]={seats:preset.seats,price:''};
  }
  renderPicker();
  $('ovl').classList.add('open');
}

function closeForm(){$('ovl').classList.remove('open');form=null;}

function conflictFor(cabin){
  const s=$('fStart').value,e=$('fEnd').value;
  if(!s||!e)return null;
  return data.contracts.find(c=>c.id!==form.excludeId&&c.phase!=='terminated'&&
    c.cabins.some(l=>l.item_id===cabin.item_id)&&c.start_date<=e&&c.end_date>=s)||null;
}

function renderPicker(){
  if(!form)return;
  $('pickHint').textContent=data.cabins.length?'— greyed-out cabins are taken for these dates':'';
  $('picker').innerHTML=data.cabins.map(c=>{
    const sel=!!form.cabins[c.item_id];
    const clash=conflictFor(c);
    const cls=sel?'sel':(clash?'dis':'');
    const title=clash?`title="${esc('Under contract '+(clash.contract_no||clash.company_name))}"`:'';
    return `<button type="button" class="ct-pchip ${cls}" ${title} data-id="${esc(c.item_id)}" ${clash&&!sel?'disabled':''}>${esc(c.cabin_number)} · ${c.seats}</button>`;
  }).join('')||'<span class="ct-sub">No leasable cabins found.</span>';

  const selHead=Object.keys(form.cabins).length?'<div class="ct-sel-row ct-sel-hdr"><span>Cabin</span><span>Seats</span><span>Monthly price (₹)</span><span></span></div>':'';
  $('selRows').innerHTML=selHead+Object.entries(form.cabins).map(([id,v])=>{
    const cabin=data.cabins.find(c=>c.item_id===id);
    if(!cabin)return '';
    const clash=conflictFor(cabin);
    return `<div>
      <div class="ct-sel-row" data-id="${esc(id)}">
        <b>${esc(cabin.cabin_number)}</b>
        <input type="number" min="1" step="1" value="${esc(v.seats)}" data-f="seats" placeholder="Seats"/>
        <input type="number" min="0" step="1" value="${esc(v.price)}" data-f="price" placeholder="Monthly price ₹"/>
        <button type="button" class="rm" data-rm="${esc(id)}">✕</button>
      </div>
      ${clash?`<div class="ct-warn-note">Overlaps ${esc(clash.contract_no||clash.company_name)} for these dates.</div>`:''}
    </div>`;
  }).join('');
  updateTotals();
}

function updateTotals(){
  const list=Object.values(form.cabins);
  const seats=list.reduce((s,v)=>s+(Number(v.seats)||0),0);
  const rent=list.reduce((s,v)=>s+(Number(v.price)||0),0);
  $('totals').textContent=list.length?`${list.length} cabin${list.length===1?'':'s'} · ${seats} seats · ${inr(rent)} / month`:'No cabins selected';
}

async function submitForm(){
  const err=$('mErr');err.textContent='';
  const body={
    company_name:$('fCompany').value,contact_person:$('fPerson').value,contact_phone:$('fPhone').value,contact_email:$('fEmail').value,
    start_date:$('fStart').value,end_date:$('fEnd').value,security_deposit:$('fDeposit').value,notes:$('fNotes').value,
    cabins:Object.entries(form.cabins).map(([item_id,v])=>({item_id,seats:v.seats,monthly_price:v.price}))
  };
  const {mode,id}=form;
  if(mode==='addon')body.add_on_to=id;
  const url=mode==='edit'?'/api/contracts?id='+encodeURIComponent(id):(mode==='renew'?'/api/contracts?action=renew&id='+encodeURIComponent(id):'/api/contracts');
  const btn=$('mSubmit');btn.disabled=true;const label=btn.textContent;btn.textContent='Saving…';
  try{
    const r=await apiFetch(url,{method:mode==='edit'?'PATCH':'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    const d=await r.json().catch(()=>({}));
    if(r.ok&&d.status==='success'){
      closeForm();
      notify(d.warning||d.message||'Saved.',d.warning?'warn':'ok');
      load();
      return;
    }
    err.textContent=d.error||'Could not save the contract.';
  }catch(e){
    err.textContent='Could not reach the server.';
  }
  btn.disabled=false;btn.textContent=label;
}

/* ── wiring (runs once; the markup sits above this script in the page) ── */
$('picker').addEventListener('click',e=>{
  const b=e.target.closest('.ct-pchip');
  if(!b||b.disabled)return;
  const id=b.dataset.id;
  if(form.cabins[id])delete form.cabins[id];
  else{const cabin=data.cabins.find(c=>c.item_id===id);form.cabins[id]={seats:cabin.seats,price:''};}
  renderPicker();
});
$('selRows').addEventListener('input',e=>{
  const row=e.target.closest('.ct-sel-row');
  if(!row||!e.target.dataset.f)return;
  form.cabins[row.dataset.id][e.target.dataset.f]=e.target.value;
  updateTotals();
});
$('selRows').addEventListener('click',e=>{
  const rm=e.target.closest('[data-rm]');
  if(!rm)return;
  delete form.cabins[rm.dataset.rm];
  renderPicker();
});
$('ovl').addEventListener('click',e=>{if(e.target.id==='ctOvl')closeForm();});

window.CT={
  show:load,load,changeLocation,onSearch,setFilter,openForm,closeForm,submitForm,
  terminate,setRenewal,confirmThenRun,signOut,renderPicker
};
})();
