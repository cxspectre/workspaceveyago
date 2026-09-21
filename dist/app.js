const icons={overview:'<rect x="3" y="3" width="7" height="7" rx="1.4"/><rect x="14" y="3" width="7" height="7" rx="1.4"/><rect x="3" y="14" width="7" height="7" rx="1.4"/><rect x="14" y="14" width="7" height="7" rx="1.4"/>',mail:'<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 6 9 7 9-7"/>',tickets:'<path d="M3 7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v3a2 2 0 0 0 0 4v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-3a2 2 0 0 0 0-4Z"/><path d="M15 5v3m0 3v2m0 3v3"/>',agenda:'<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 3v4m10-4v4M3 11h18m-13 4h2m4 0h2"/>',projects:'<path d="M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/><path d="M3 9h18"/>',crm:'<circle cx="9" cy="8" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3m1-16a3 3 0 0 1 0 6m2 3a5 5 0 0 1 3 4v3"/>',finance:'<path d="M4 20V10m6 10V4m6 16v-7m5 7H2"/>',company:'<path d="M4 21V5l8-2v18m0-13h8v13M2 21h20M8 7v2m0 3v2m0 3v2m8-8v2m0 3v2"/>',search:'<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',bell:'<path d="M18 8a6 6 0 0 0-12 0c0 8-3 8-3 10h18c0-2-3-2-3-10m-12 10a3 3 0 0 0 6 0"/>',plus:'<path d="M12 5v14M5 12h14"/>',arrow:'<path d="M5 12h14m-5-5 5 5-5 5"/>',chevron:'<path d="m9 5 7 7-7 7"/>',dollar:'<path d="M12 2v20m5-16H9a4 4 0 0 0 0 8h6a4 4 0 0 0 0-8M7 18h8"/>',check:'<path d="m5 12 4 4L19 6"/>',menu:'<path d="M4 6h16M4 12h16M4 18h16"/>',clock:'<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',reply:'<path d="m9 5-6 6 6 6m-6-6h11a7 7 0 0 1 7 7"/>',external:'<path d="M14 3h7v7m0-7L10 14M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5"/>'};
const icon=n=>`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[n]||icons.overview}</svg>`;
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
/* CAL — the working week and today's date — lives in calendar.js, which loads
   before this file and replaces its snapshot when the date changes.
   The context bar's date sits outside #main, so render() never rebuilds it;
   a new day has to repaint it explicitly. */
const paintToday=()=>{const el=document.querySelector('#today');if(el)el.textContent=CAL.todayLong;};
paintToday();
CAL.onChange(paintToday);
/* A repaint nobody asked for — a new day, a background reload — must not wipe
   what someone is typing: render() rebuilds #main with innerHTML. A field whose
   value differs from what was rendered is a draft; while one exists, wait for
   focus to leave #main and look again. The next render the person causes
   (navigating, saving) shows the fresh data either way. */
const hasDraft=()=>{const main=document.querySelector('#main');if(!main)return false;if(main.contains(document.activeElement)&&document.activeElement.isContentEditable)return true;return [...main.querySelectorAll('textarea,input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([data-query])')].some(f=>f.value!==f.defaultValue||Boolean(f===document.activeElement&&f.closest&&f.closest('[data-note-form]')&&String(f.value).trim()));};
let repaintPending=false;
/* What has focus, as a selector and its place among the controls that selector
   finds, so the same control is found again after #main is rebuilt. A
   background repaint used to drop focus — someone typing a search lost it
   mid-word — and a key made of one attribute put it on the first row of a
   table rather than the row it was on (shell-model.js focusSelector). */
const focusKey=el=>{if(el&&el.closest&&el.closest('#nav')&&el.getAttribute('href'))return {selector:'#nav '+shellModel.focusSelector('a',{href:el.getAttribute('href')}),index:0};const main=document.querySelector('#main');if(!el||!main||el===main||!main.contains(el))return null;if(el.matches('h1[tabindex="-1"]'))return {selector:'#main h1',index:0,heading:true};if(el.id)return {selector:'#main #'+CSS.escape(el.id),index:0};const found=shellModel.focusSelector(el.tagName,Object.fromEntries([...el.attributes].map(a=>[a.name,a.value])));if(!found)return null;const selector='#main '+found;const index=[...document.querySelectorAll(selector)].indexOf(el);return index<0?null:{selector,index};};
function repaintKeepingFocus(){const active=document.activeElement;const key=focusKey(active);const selection=key&&typeof active.selectionStart==='number'?[active.selectionStart,active.selectionEnd]:null;render();if(!key)return;const next=document.querySelectorAll(key.selector)[key.index];if(!next||next===document.activeElement)return;if(key.heading)next.setAttribute('tabindex','-1');next.focus({preventScroll:true});if(selection&&next.setSelectionRange){try{next.setSelectionRange(selection[0],selection[1]);}catch{}}}
function repaintWhenIdle(){if(!hasDraft()){repaintPending=false;repaintKeepingFocus();return;}if(repaintPending)return;repaintPending=true;document.querySelector('#main').addEventListener('focusout',()=>{repaintPending=false;setTimeout(repaintWhenIdle,0);},{once:true});}
/* Declared here, not in workspace.js: app.js renders before that file has
   run, and a binding it cannot see yet throws on the first paint. */
const recordNotes = {tickets:{}, projects:{}, crm:{}, agenda:{}, companies:{}};
const workspaceActivity = [];
const team = [];
const navs=[['overview','Overview'],['mail','Mail'],['tickets','Tickets'],['agenda','Agenda'],['projects','Projects'],['crm','CRM'],['finance','Finance'],['company','Company']];
let page='overview',filter='All tickets',mailFolder='Inbox',selectedMail=0,range='6 months',toastTimer;
/* These arrays start EMPTY. data/store.js fills them from Supabase once
   someone signs in. They used to hold sample rows, which meant a failed
   load looked like a working workspace belonging to somebody else — the
   worst way for a data layer to fail. Empty renders an empty state, which
   is at least true. */
const tickets=[];
const projects=[];
const contacts=[];
const mails=[];
const sent=[];const events=[];
const invoices=[];
/* Open, in progress or waiting — the three workspace_overview() counts. It used
   to be "anything not resolved", which counted closed tickets as open. */
const openTickets=()=>tickets.filter(overviewModel.isOpenTicket);
const isManagerNow=()=>Boolean(window.workspaceSession&&workspaceSession.isManager&&workspaceSession.isManager());
/* Today as a date on the viewer's own clock, "2026-09-14": an invoice is overdue from the day after its due date wherever the viewer is (finance-model.js). */
const financeDay=()=>CAL.dayKey(new Date());
/* Invoices as Finance shows them: overdue once late, amounts with their cents, in their own currency — all as of one today. */
const shapedInvoices=()=>{const today=financeDay();return invoices.map(v=>financeModel.shapeInvoice(v,today));};
/* Today's events as the agenda places them (agendaModel.eventsOn) — null until today's week is in, so the Overview says it is loading rather than that nothing is on, and the tile falls back to the database's count. The events loaded may be another week's: the agenda's own. */
const todayEvents=()=>{const s=window.workspaceStore;const now=new Date();const loaded=Boolean(s&&s.has('events')&&(typeof s.weekLoaded!=='function'||s.weekLoaded(agendaModel.weekOf(now).key)));return loaded?agendaModel.eventsOn(events,now):null;};
/* The Overview tiles and the focus card count from the same answer. A part
   that never loaded is passed as missing, so it shows as a dash, not a zero. */
function overviewCounts(){const s=window.workspaceStore;const has=key=>Boolean(s&&s.has&&s.has(key));return overviewModel.tileCounts({overview:(s&&s.state.overview)||null,tickets:has('tickets')?tickets:null,projects:has('projects')?projects:null,eventsToday:todayEvents(),isActive:projectsModel.isActive});}
/* One activity entry: who, when, and a link to its record when it has one. */
function activityRow(item){const inner=`<span class="avatar owner" aria-hidden="true">${esc(item.initial)}</span><div><p>${esc(item.text)}</p><small>${esc(item.who)}${item.when?' · '+esc(item.when):''}</small></div>`;return item.route?`<a class="activity activity-link" href="#${esc(item.route)}">${inner}</a>`:`<div class="activity">${inner}</div>`;}
const pill=(text,color)=>`<span class="pill ${color||({Open:'blue','In progress':'amber','In review':'purple',Resolved:'green',Closed:'green',Waiting:'amber',High:'red',Urgent:'red',Medium:'amber',Normal:'amber',Low:'green',Paid:'green',Due:'amber',Overdue:'red',Sent:'blue',Draft:'',Client:'green',Proposal:'purple',Qualified:'purple',Lead:'blue',Dormant:'',Lost:'red',Discovery:'blue',Completed:'green','On hold':'amber',Cancelled:''}[text]||'')}">${esc(text)}</span>`;
/* The true count once the database has answered (mail_unread_counts(),
   0062) — every unread inbox thread this person's mailboxes hold, not only
   the 200 mailThreads() loads per folder; the old loaded-list guess is the
   fallback for as long as that has not landed, or on a database from before it. */
const mailUnreadTotal=()=>{const s=window.workspaceStore;const trueCounts=s&&s.state.mailUnreadCounts;return trueCounts?mailModel.trueUnreadTotal(trueCounts):mailModel.unreadCount(mails,mailModel.ALL);};
/* Finance only for the people who can read it, and a badge only when there is
   something to count: Mail used to show an empty dot and Tickets a "0". */
function nav(){document.querySelector('#nav').innerHTML=overviewModel.visibleNavs(navs,isManagerNow()).map(([key,title])=>{const count=overviewModel.badge(key==='mail'?mailUnreadTotal():key==='tickets'?openTickets().length:0);return `${key==='company'?'<div class="nav-divider"></div>':''}<a href="#${key}" title="${title}" class="${key===page?'active':''}" ${key===page?'aria-current="page"':''}><span class="nav-icon">${icon(key)}${count?`<span class="nav-badge">${count}</span>`:''}</span><span class="nav-title">${title}</span></a>`;}).join('');paintBell();}
function heading(title,subtitle,action='new'){return `<div class="page-heading"><div><h1>${title}</h1><p>${subtitle}</p></div><div class="heading-actions">${page==='overview'?`<button class="btn date-btn" data-nav="agenda/today">${icon('agenda')} ${CAL.full(CAL.today)}</button>`:''}${action?`<button class="btn btn-primary" data-action="${action}">${icon('plus')} ${action==='compose'?'Compose':page==='overview'?'Create new':({tickets:'New ticket',projects:'New project',crm:'Add contact',agenda:'New event'}[page]||'Create new')}</button>`:''}</div></div>`}
function metrics(){
/* The tiles come from workspace_overview() — one round trip, so the four
   numbers cannot disagree with each other. Which four you get depends on your
   role: finance is managers only, and showing a non-manager a dash where the
   money was tells them nothing except that there is something they cannot see.
   They get their own work instead. When the RPC has not answered, the tiles
   count what did load (overview-model.js tileCounts) and show a dash for what
   cannot be counted — "your open tasks" used to count everyone's, and "Today"
   the whole week. Counts read as numbers: "7", not "07". "All calm" and
   "On track" were written into the page; now they say what the tickets and
   the due dates say. */
const o=(window.workspaceStore&&workspaceStore.state.overview)||null;
const fmt=window.workspaceData?workspaceData.money:(v=>'$'+v);
const M=overviewModel;
const counts=overviewCounts();
const has=key=>Boolean(window.workspaceStore&&workspaceStore.has&&workspaceStore.has(key));
const ticketsTile=['Open tickets',M.formatCount(counts.ticketsOpen),'tickets',(counts.ticketsHigh?pill(counts.ticketsHigh+' high priority','red'):counts.ticketsOpen==null?'<span>Not loaded</span>':'<span class="trend">Nothing urgent</span>')+' <span>across all products</span>'];
const overdue=has('projects')?M.overdueProjects(projects,projectsModel.isActive,CAL.dayKey(new Date())):null;
const projectsTile=['Active projects',M.formatCount(counts.projectsActive),'projects',(overdue==null?'<span>Not loaded</span>':`<span class="trend"${overdue?' style="color:#b94438"':''}>${esc(M.projectsFoot(overdue))}</span>`)+' <span>across the studio</span>'];
let cards;
if(o&&o.revenue_month!==null&&o.revenue_month!==undefined){
  /* Money in its own currency (0041). No previous month means no comparison
     to draw: "up 100%" from nothing reads as a fact. Last month is counted up
     to the same day, and the tile says to which. Currencies that were not added
     in are named beside the figure rather than summed into it. */
  const money=M.revenueFigures(o);
  const day=value=>value?new Date(value+'T00:00:00').toLocaleDateString('en-US',{month:'short',day:'numeric'}):null;
  const through=day(money.previousThrough);
  const foot=money.trend===null
    ?'<span>vs. last month</span>'
    :`<span class="trend" style="${money.trend<0?'color:#b94438':''}">${money.trend<0?'↘':'↗'} ${Math.abs(money.trend).toFixed(1)}%</span> vs. ${through?'last month to '+esc(through):'last month'}`;
  const also=list=>list.length?` <span>· also ${esc(list.join(', '))}</span>`:'';
  /* The code after the figure — unless it could not be formatted, when the
     figure already ends with it. */
  const code=c=>workspaceData.currencyCode(c)?` <span>${esc(c)}</span>`:'';
  const inv=money.invoices;
  /* With the invoices loaded the tile says what Finance says of them; without, the database's soonest due date, late once it has passed. */
  const owed=window.workspaceStore&&workspaceStore.has('invoices')?financeModel.awaitingPayment(invoices,financeDay(),inv.currency).find(e=>e.currency===inv.currency)||null:null;
  const due=M.invoiceDueNote(inv.dueNext,owed,financeDay());
  cards=[
    ['Revenue this month',fmt(money.month,money.currency)+code(money.currency),'finance',foot+also(money.otherCurrencies)],
    ticketsTile,
    projectsTile,
    ['Outstanding invoices',fmt(inv.amount,inv.currency)+code(inv.currency),'dollar',
     `<span>${inv.count} invoice${inv.count===1?'':'s'}</span>${due?' <span>· '+esc(due)+'</span>':''}${also(inv.otherCurrencies)}`]
  ];
}else{
  cards=[
    ticketsTile,
    projectsTile,
    ['Your open tasks',M.formatCount(counts.tasksMine),'check',counts.tasksMine==null?'<span>Not loaded</span>':'<span>assigned to you</span>'],
    ['Today',M.formatCount(counts.eventsToday),'agenda',counts.eventsToday==null?'<span>Not loaded</span>':`<span>${counts.eventsToday===1?'event':'events'} on the agenda</span>`]
  ];
}
return `<div class="metrics">${cards.map(([label,value,i,foot])=>`<section class="metric"><div class="metric-top">${label}<span class="metric-icon">${icon(i)}</span></div><div class="metric-value">${value}</div><div class="metric-foot">${foot}</div></section>`).join('')}</div>`}
function revenueChart(){
/* Drawn from revenue_series() — one row per month, zeros included, summed in
   the database so this agrees with the Revenue tile rather than with whatever
   window the browser happened to fetch. The sample curve it replaces was a
   hand-drawn bezier with "$62,480 ↗ 21.4%" written beside it; next to real
   figures that is not a placeholder, it is a wrong number in a trusted place.

   Falls back to a quiet empty state rather than a fake line: a chart with no
   data should say so. */
const year=range==='12 months';
const series=(window.workspaceStore&&workspaceStore.state.revenue)||null;
const head=`<div class="panel-head"><div><h2>Revenue overview</h2><p>Income across your products and client work.</p></div><div class="chart-tabs"><button data-range="6 months" class="${!year?'selected':''}">6 months</button><button data-range="12 months" class="${year?'selected':''}">12 months</button></div></div>`;

if(window.workspaceStore&&!workspaceStore.has('revenue')){
  return `<section class="panel revenue-panel">${head}<div class="workspace-empty" style="padding:44px 24px"><h3>Revenue did not load</h3><p>It is tried again by itself.</p></div></section>`;
}
if(!series||!series.length){
  return `<section class="panel revenue-panel">${head}<div class="workspace-empty" style="padding:44px 24px"><h3>No income recorded yet</h3><p>Revenue appears here once transactions are synced from Mercury or Stripe.</p></div></section>`;
}

const rows=series.slice(year?-12:-6);
const values=rows.map(r=>Number(r.revenue)||0);
/* revenue_series() already works these out (0041) — expenses is what the
   audit found this chart never drew, so the line beside income was always
   half the story it could tell from one round trip it was already making. */
const expenseValues=rows.map(r=>Number(r.expenses)||0);
const total=values.reduce((a,b)=>a+b,0);
const expenseTotal=expenseValues.reduce((a,b)=>a+b,0);
const last=values[values.length-1], prev=values[values.length-2];
/* No previous month, or a previous month of nothing, means there is no
   percentage to state. Silence beats inventing one. */
const trend=(prev>0)?((last-prev)/prev)*100:null;
/* Both lines share one axis, scaled to whichever of the two months went
   higher: an expense line taller than the axis meant for revenue alone would
   run off the top of the chart. */
const peak=Math.max(...values,...expenseValues,1);
/* Round the axis up to something a person would choose. */
const step=Math.pow(10,Math.floor(Math.log10(peak)));
const top=Math.max(Math.ceil(peak/step)*step,step);
const W=600,H=140;
const x=i=>rows.length===1?W/2:(i/(rows.length-1))*W;
const y=v=>H-2-((v/top)*(H-12));
const line=values.map((v,i)=>`${i?'L':'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join('');
const area=`${line}L${W} ${H}L0 ${H}Z`;
const expenseLine=expenseValues.map((v,i)=>`${i?'L':'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join('');
/* Nothing spent this window is not worth a second line lying flat on the
   axis, or a legend entry and a foot figure for a line nobody drew. */
const hasExpenses=expenseValues.some(v=>v>0);
/* One currency, and the series says which (0041); before that it was USD. A
   code Intl cannot format is written beside the number rather than thrown. */
const currency=(rows[0]&&rows[0].currency)||'USD';
const fmt=v=>workspaceData.money(v,currency,{compact:true});
const MON=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const labelFor=r=>MON[new Date(r.month+'T00:00:00').getMonth()];
const usdFull=v=>workspaceData.money(v,currency);

const expenseLast=expenseValues[expenseValues.length-1];
const legend=`<span class="chart-legend"><i class="legend-line"></i> Revenue${hasExpenses?'<i class="legend-line" style="border-top-color:#eb6834;border-top-style:dashed"></i> Expenses':''}</span>`;
const expensePath=hasExpenses?`<path d="${expenseLine}" stroke="#eb6834" stroke-width="2" stroke-dasharray="5 3" fill="none" vector-effect="non-scaling-stroke"/><circle cx="${x(expenseValues.length-1).toFixed(1)}" cy="${y(expenseLast).toFixed(1)}" r="3.5" fill="#eb6834"/>`:'';
const ariaLabel=`Revenue, ${labelFor(rows[0])} to ${labelFor(rows[rows.length-1])}, ${usdFull(last)} in the latest month`+(hasExpenses?`, against ${usdFull(expenseLast)} spent`:'');
const footExpenses=hasExpenses?`<span>Expenses<b>${usdFull(expenseTotal)}</b></span>`:'';
return `<section class="panel revenue-panel">${head}<div class="revenue-total"><strong>${usdFull(total)}</strong>${trend===null?'':`<span class="trend" style="${trend<0?'color:#b94438':''}">${trend<0?'↘':'↗'} ${Math.abs(trend).toFixed(1)}%</span>`}${legend}</div><div class="chart" role="img" aria-label="${ariaLabel}"><div class="y-axis"><span>${fmt(top)}</span><span>${fmt(top*2/3)}</span><span>${fmt(top/3)}</span><span>${fmt(0)}</span></div><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"><defs><linearGradient id="chart-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#0071e3" stop-opacity=".15"/><stop offset="100%" stop-color="#0071e3" stop-opacity="0"/></linearGradient></defs><path d="M0 1H${W}M0 46H${W}M0 92H${W}M0 138H${W}" stroke="#edf1f3" stroke-width="1" stroke-dasharray="3 4" fill="none"/><path d="${area}" fill="url(#chart-fill)"/><path d="${line}" stroke="#0071e3" stroke-width="2.8" fill="none" vector-effect="non-scaling-stroke"/><circle cx="${x(values.length-1).toFixed(1)}" cy="${y(last).toFixed(1)}" r="4" fill="#0071e3"/>${expensePath}</svg><div class="chart-labels">${rows.map(r=>`<span>${labelFor(r)}</span>`).join('')}</div></div><div class="chart-foot"><span>Income<b>${usdFull(total)}</b></span><span>Latest month<b>${usdFull(last)}</b></span>${footExpenses}<span>${esc(currency)}</span></div></section>`}
function ticketTable(items,full=false){return `<div class="table-wrap"><table class="${full?'module-table':''}"><thead><tr><th>Ticket</th>${full?'<th>Product / client</th>':''}<th>Priority</th><th>Status</th><th>Owner</th></tr></thead><tbody>${items.map(t=>`<tr data-action="ticket" data-id="${esc(t.id)}"><td><div class="cell-main"><span class="ticket-symbol">${icon('tickets')}</span><div><a class="ticket-link" href="#tickets/${esc(t.id)}"><strong>${esc(t.title)}</strong></a><small><span class="ticket-id">#VYG-${t.id}</span> &nbsp;·&nbsp; ${esc(t.client)}</small></div></div></td>${full?`<td class="muted">${esc(t.product)}</td>`:''}<td>${pill(t.priority)}</td><td>${pill(t.status)}</td><td><div class="avatar sm">${esc(t.owner)}</div></td></tr>`).join('')}</tbody></table>${!items.length?'<div class="empty-state">No tickets in this view.</div>':''}</div>`}
function projectRows(){if(!projects.length)return '<p class="quiet-text" style="padding:4px 19px 20px">No projects yet. Create one and it will show here with its progress.</p>';
return `<div class="project-list">${projects.slice(0,3).map(p=>`<div class="project-row" role="button" tabindex="0" data-action="project" data-id="${p.id}"><div class="project-logo ${p.style}">${p.initial}</div><div><div class="project-name">${esc(p.name)}</div><div class="project-meta">${esc(p.client)} &nbsp;·&nbsp; Due ${esc(p.due)}</div></div><div><div class="progress-caption">${p.progress}%</div><div class="progress"><i style="width:${p.progress}%"></i></div></div><div class="avatar sm">${esc((team.filter(m=>m.row&&m.row.id===(p.row&&p.row.owner_id))[0]||{}).initial||'')}</div></div>`).join('')}</div>`}
function agendaPanel(){const now=new Date();const today=todayEvents();const s=window.workspaceStore;const todayKey=agendaModel.weekOf(now).key;const failed=Boolean(s&&(typeof s.weekFailed==='function'?s.weekFailed(todayKey):(s.state.failed||[]).includes('the agenda')));const names=agendaModel.dayNames(agendaModel.dayKey(now))||{weekday:'',label:''};const quiet=words=>`<p class="quiet-text" style="padding:2px 0 12px">${words}</p>`;return `<section class="panel"><div class="panel-head"><h2>Today's agenda</h2><button class="text-btn" data-nav="agenda/today" aria-label="Open today in the agenda">${icon('external')}</button></div><div class="agenda-date"><span class="dot"></span><strong>${esc(names.weekday)}</strong> ${esc(names.label)}</div><div class="agenda-items">${!today?quiet(failed?'The agenda did not load. It is tried again by itself.':'Today’s agenda is loading…'):!today.length?quiet('Nothing in the diary today.'):''}${(today||[]).map(p=>`<a class="agenda-item" href="#agenda/${esc(p.id)}"><div class="agenda-time">${esc(p.time)}</div><div class="agenda-description type-${esc(p.kind.value)}"><strong>${esc(p.title)}</strong>${p.event&&p.event.detail?`<small>${esc(p.event.detail)}</small>`:''}${pill(p.kind.label,p.kind.tone)}</div></a>`).join('')}</div><button class="agenda-bottom" data-nav="agenda/today">View full calendar &nbsp; →</button></section>`}
function overview(){return `${heading('Your studio, at a glance.',esc(overviewModel.greeting(window.workspaceSession&&workspaceSession.employee)))}${metrics()}<div class="dashboard-columns"><div class="left-column">${isManagerNow()?revenueChart():''}<section class="panel"><div class="panel-head spaced"><h2>Tickets needing attention <span class="small-count">${openTickets().length}</span></h2><button class="text-btn" data-nav="tickets">View all ${icon('arrow')}</button></div>${ticketTable(openTickets().slice(0,3))}<div class="table-bottom"><span>Across your products and client projects</span><span>${esc(overviewModel.updatedLabel(window.workspaceStore&&workspaceStore.state.loadedAt))}</span></div></section><section class="panel"><div class="panel-head"><h2>Active projects</h2><button class="text-btn" data-nav="projects">All projects ${icon('arrow')}</button></div>${projectRows()}</section></div><div class="right-column">${agendaPanel()}<section class="panel"><div class="panel-head"><h2>Recent activity</h2>${workspaceActivity.length?`<button class="text-btn" data-nav="overview/activity">View all ${icon('arrow')}</button>`:''}</div><div class="activity-list">${workspaceActivity.length?workspaceActivity.slice(0,5).map(a=>activityRow(overviewModel.activityItem(a,{tickets,projects,contacts,invoices}))).join(''):`<p class="quiet-text" style="padding:6px 0 14px">Nothing yet. Activity appears here as tickets, projects and contacts change.</p>`}</div></section><section class="quick-note">${(()=>{
/* Whatever is closest to its due date and still moving — the card used to be
   one project written out by hand, stuck at 72% forever. */
const live=projects.filter(projectsModel.isActive);
const next=live.slice().sort((a,b)=>{const A=a.dueOn||'9999',B=b.dueOn||'9999';return A.localeCompare(B);})[0];
if(!next)return '<div class="eyebrow">UP NEXT</div><h3>Nothing scheduled</h3><p>New projects appear here with the date they are working toward.</p>';
return `<div class="eyebrow">UP NEXT${next.client&&next.client!=='Internal product'?' · '+esc(next.client.toUpperCase()):''}</div><h3>${esc(next.name)}</h3><p>${esc(next.description||'No description yet.')}</p><div class="launch-meta"><span>${esc(next.due||'No date set')}</span><strong>${next.progress}%</strong></div><div class="progress"><i style="width:${next.progress}%"></i></div><button class="text-btn" data-action="project" data-id="${next.id}">Open project ${icon('arrow')}</button>`;})()}</section></div></div>`}
function ticketsView(){let items=tickets.filter(t=>filter==='All tickets'||t.status===filter||filter==='High priority'&&t.priority==='High');return `${heading('Tickets','Customer conversations, with a clear next step.')}<div class="view-toolbar"><div class="tabs">${['All tickets','Open','In progress','Resolved','High priority'].map(t=>`<button class="${filter===t?'active':''}" data-filter="${t}">${t}</button>`).join('')}</div></div><section class="panel">${ticketTable(items,true)}</section>`}
/* Render an email body: sanitised HTML when the message has any, plain text
   otherwise. Remote images are blocked until the reader asks for them — a
   remote image is how a sender learns you opened the message. */
function mailBody(m){
  /* Bodies are not in the list query — they are fetched per thread. Asking the
     store both reads the cache and starts the fetch, which re-renders. */
  if (m.bodyHtml === undefined && m.body === undefined) {
    const loaded = window.workspaceStore && workspaceStore.threadBody(m.id);
    if (!loaded) return '<p class="quiet-text">Loading the message…</p>';
    const newest = loaded[loaded.length - 1];
    m.thread = loaded;
    m.body = newest ? newest.body : '';
    m.bodyHtml = newest ? newest.bodyHtml : '';
  }
  const showing = (window.__mailShowImages || []).includes(m.id);
  if (m.bodyHtml && window.mailHtml) {
    const out = window.mailHtml.render(m.bodyHtml, { showImages: showing });
    if (out.html) {
      const banner = out.blockedImages
        ? `<div class="mail-images-blocked"><span>${out.blockedImages} image${out.blockedImages===1?'':'s'} not shown</span><button class="text-btn" data-show-images="${esc(String(m.id))}">Show images</button></div>`
        : '';
      return banner + `<div class="mail-html">${out.html}</div>`;
    }
  }
  return `<div class="mail-plain">${esc(m.body||'')}</div>`;
}
/* Mail is drawn by mail.js, which replaces this; mailBody stays — mail.js
   itself calls it to render a message's body. */
function mailView(){return '';}
function projectsView(){return `${heading('Projects','The work behind your products and your clients.')}<div class="project-grid">${projects.map(p=>`<button class="project-card" data-action="project" data-id="${p.id}"><div class="project-logo ${p.style}">${esc(p.initial)}</div><h2>${esc(p.name)}</h2><p>${esc(p.description)}</p>${pill(p.status)}<div class="progress-caption">${p.progress}% complete</div><div class="progress"><i style="width:${p.progress}%"></i></div><div class="project-card-bottom"><span>${esc(p.client)}</span><span>Due ${esc(p.due)}</span></div></button>`).join('')}</div>`}
/* The CRM is drawn by crm-ui.js, and the agenda by agenda-ui.js, which replace these. */
function crmView(){return '';}
function agendaView(){return '';}
/* Finance is drawn by finance-ui.js, which replaces this. */
function financeView(){return '';}
function companyView(){
/* The two people cards were written out by hand — one of them labelled
   "Team". The team comes from the employees table now, so this
   shows whoever is actually on it. */
return `${heading('Company','The people and details behind Veyago.',null)}<div class="team-grid"><section class="panel company-card"><div class="project-logo travel">V</div><h2 style="margin-top:20px">Veyago Inc.</h2><p>Independent software studio.<br>New York, United States<br>hello@veyago.cloud</p><a class="btn" style="margin-top:20px" href="https://www.veyago.cloud" target="_blank" rel="noopener">Company website ${icon('external')}</a></section>${team.map(m=>`<section class="panel company-card"><div class="avatar${m.tag==='Owner'?' owner':''}">${esc(m.initial)}</div><h2>${esc(m.name)}</h2><p>${esc(m.role)}</p>${pill(m.tag,m.tag==='Owner'?'green':'purple')}</section>`).join('')}</div>`}
function render(){nav();document.querySelector('#breadcrumb').textContent=navs.find(n=>n[0]===page)[1];document.querySelector('#main').innerHTML=({overview,tickets:ticketsView,mail:mailView,projects:projectsView,crm:crmView,agenda:agendaView,finance:financeView,company:companyView}[page])()}
function navigate(target){if(!navs.some(n=>n[0]===target))return;page=target;history.replaceState(null,'','#'+page);document.querySelector('#sidebar').classList.remove('open');document.querySelector('#menu-toggle').setAttribute('aria-expanded','false');render();window.scrollTo(0,0)}
function toast(message){clearTimeout(toastTimer);const el=document.querySelector('#toast');el.textContent=message;el.classList.add('show');toastTimer=setTimeout(()=>el.classList.remove('show'),4000)}
const modal=document.querySelector('#modal');function showModal(eyebrow,body){document.querySelector('#modal-eyebrow').textContent=eyebrow;const holder=document.querySelector('#modal-body');holder.innerHTML=body;/* The dialog is named by its heading; a field marked autofocus has the keyboard, whether the dialog opens now or was open already, when the browser's own autofocus does not run. */const heading=holder.querySelector('h2');if(heading){heading.id='modal-title';modal.setAttribute('aria-labelledby','modal-title');}else modal.removeAttribute('aria-labelledby');if(!modal.open)modal.showModal();else{const first=holder.querySelector('[autofocus]');if(first)first.focus();}}
function showTicket(id){let t=tickets.find(t=>t.id===Number(id));if(!t)return;showModal('TICKET · VYG-'+t.id,`<h2>${esc(t.title)}</h2><div class="detail-meta">${pill(t.status)}${pill(t.priority)}${pill(t.product,'green')}</div><p>${esc(t.body)}</p><div class="detail-section"><div class="compact-kpi"><span>From</span><strong>${esc(t.client)}</strong></div><div class="compact-kpi"><span>Assigned to</span><strong>${esc((team.find(m=>m.initial===t.owner)||{}).name||'Unassigned')}</strong></div></div><div class="dialog-actions"><button class="btn" data-action="ticket-reply" data-id="${t.id}">${icon('reply')} Reply</button><button class="btn btn-primary" data-action="resolve" data-id="${t.id}">${icon('check')} ${t.status==='Resolved'?'Reopen ticket':'Resolve ticket'}</button></div>`)}
function showProject(id){let p=projects.find(p=>p.id===Number(id));if(!p)return;showModal('PROJECT · '+p.client,`<h2>${esc(p.name)}</h2><div class="detail-meta">${pill(p.status)}${pill('Due '+p.due,'blue')}</div><p>${esc(p.description)}</p><div class="detail-section"><h3>Next steps</h3>${p.tasks.map((t,i)=>`<label class="check-task"><input type="checkbox" data-project-task="${p.id}" data-task="${i}" ${p.checked?.includes(i)?'checked':''}>${esc(t)}</label>`).join('')}</div>${(()=>{const ci=contacts.findIndex(c=>c.company===p.client);return ci<0?'':`<div class="dialog-actions"><button class="btn" data-action="contact" data-id="${esc(contacts[ci].id)}">View client relationship →</button></div>`;})()}`)}
function showContact(id){let c=contacts.find(x=>String(x.id)===String(id));if(!c)return;let ps=projects.filter(p=>p.client===c.company),ts=tickets.filter(t=>t.client===c.name||t.product===c.company);showModal('CRM · '+c.company,`<h2>${esc(c.name)}</h2><div class="detail-meta">${pill(c.stage)}${pill(c.value+' opportunity','blue')}</div><p>${esc(c.email)}<br>${esc(c.notes)}</p><div class="detail-section"><h3>Connected work</h3>${ps.map(p=>`<button class="btn" style="margin:0 6px 8px 0" data-action="project" data-id="${p.id}">${icon('projects')}${esc(p.name)}</button>`).join('')}${ts.map(t=>`<div class="detail-row"><span>${esc(t.title)}</span><button class="text-btn" data-action="ticket" data-id="${t.id}">Open →</button></div>`).join('')}${!ps.length&&!ts.length?'<p>No linked projects or tickets yet.</p>':''}</div><div class="dialog-actions"><button class="btn btn-primary" data-action="contact-email" data-id="${id}">${icon('mail')} Write email</button></div>`)}
/* The composer is drawn by mail-compose.js, which replaces this. */
function compose(to='',subject='',body=''){}
function createForm(kind){let cfg={tickets:['Create a ticket','Subject','Customer / requester'],projects:['Create a project','Project name','Client or internal product'],crm:['Add a contact','Full name','Company']}[kind];if(!cfg){showModal('QUICK CREATE','<h2>What would you like to create?</h2><div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">'+[['tickets','Ticket'],['projects','Project'],['crm','Contact'],['agenda','Event']].map(([k,n])=>`<button class="btn" style="padding:20px" data-create="${k}">${icon(k)}${n}</button>`).join('')+'<button class="btn" style="padding:20px" data-action="compose">'+icon('mail')+'Email</button></div>');return}showModal('WORKSPACE · '+kind.toUpperCase(),`<h2>${cfg[0]}</h2><p class="form-note">Changes are saved to the studio workspace.</p><form id="create-form" data-kind="${kind}"><label class="form-field">${cfg[1]}<input name="name" required placeholder="${cfg[1]}"></label><label class="form-field">${cfg[2]}<input name="context" required placeholder="${cfg[2]}"></label>${kind==='crm'?'<label class="form-field">Email<input type="email" name="email" required placeholder="name@company.com"></label>':''}${kind==='tickets'?'<label class="form-field">Priority<select name="priority"><option>Low</option><option selected>Normal</option><option>High</option><option>Urgent</option></select></label>':''}<label class="form-field">Description<textarea name="description" placeholder="A little more context…"></textarea></label><div class="dialog-actions"><button class="btn" type="button" data-action="close">Cancel</button><button class="btn btn-primary">${cfg[0]}</button></div></form>`)}
function action(name,id){switch(name){case'new':createForm(page);break;case'compose':compose();break;case'close':modal.close();break;case'ticket':showTicket(id);break;case'project':showProject(id);break;case'contact':showContact(id);break;case'resolve':{let t=tickets.find(t=>t.id===Number(id));t.status=t.status==='Resolved'?'Open':'Resolved';render();showTicket(id);toast(t.status==='Resolved'?'Ticket resolved':'Ticket reopened');break}case'reply':{let m=mails[selectedMail];compose(m.email,'Re: '+m.subject);break}case'ticket-reply':{let t=tickets.find(t=>t.id===Number(id));let m=mails.find(m=>m.sender===t.client),c=contacts.find(c=>c.name===t.client);compose(m?.email||c?.email||'','Re: '+t.title);break}case'email-ticket':{if(window.workspaceStore&&workspaceStore.state.loaded)break;let m=mails[selectedMail];let existing=tickets.find(t=>t.client===m.sender&&t.product===m.client);if(existing){showTicket(existing.id);toast('This conversation already has a linked ticket')}else{let t={id:Math.max(...tickets.map(t=>t.id))+1,title:m.subject,client:m.sender,product:m.client,priority:'Medium',status:'Open',owner:'C',date:'Today',body:m.body};tickets.unshift(t);render();showTicket(t.id);toast('Ticket created from this conversation')}break}case'email-contact':{let i=contacts.findIndex(c=>c.name===mails[selectedMail].sender);if(i>=0)showContact(contacts[i].id);else showModal('RELATIONSHIP',`<h2>${esc(mails[selectedMail].sender)}</h2><p>${esc(mails[selectedMail].email)}<br>Product customer · ${esc(mails[selectedMail].client)}</p><div class="dialog-actions"><button class="btn" data-action="email-ticket">View linked support ticket →</button></div>`);break}case'contact-email':{const c=contacts.find(x=>x.id===id);if(c)compose(c.email);break}}}
/* A record's title in a list is a real link, in a row that opens the record from anywhere in it (data-action). A click on that link asking for a new tab or window is the browser's to follow, and the row steps aside (shellModel.opensHere): the rest of the page still hears the click, so an open search list still closes. */
document.addEventListener('click',e=>{let n=e.target.closest('[data-nav]');if(n){navigate(n.dataset.nav);return}let a=e.target.closest('[data-action]');if(a){if(shellModel.opensHere(e))action(a.dataset.action,a.dataset.id);return}let c=e.target.closest('[data-create]');if(c){createForm(c.dataset.create);return}let f=e.target.closest('[data-filter]');if(f){filter=f.dataset.filter;render();return}let m=e.target.closest('[data-mail]');if(m){selectedMail=Number(m.dataset.mail);render();return}let folder=e.target.closest('[data-folder]');if(folder){mailFolder=folder.dataset.folder;selectedMail=0;render();return}let r=e.target.closest('[data-range]');if(r){range=r.dataset.range;render()}});
document.addEventListener('submit',e=>{if(e.target.id==='create-form'){e.preventDefault();let d=new FormData(e.target),k=e.target.dataset.kind,n=String(d.get('name')).trim(),c=String(d.get('context')).trim(),desc=String(d.get('description'));if(!n||!c)return;let id=Math.max(...tickets.map(t=>t.id))+1;if(k==='tickets')tickets.unshift({id,title:n,client:c,product:'General',priority:d.get('priority'),status:'Open',owner:'C',date:'Today',body:desc});if(k==='projects')projects.push({id:projects.length,name:n,client:c,initial:n[0].toUpperCase(),style:'client',progress:0,due:'To be planned',status:'In progress',description:desc,tasks:['Define project scope','Set the first milestone']});if(k==='crm')contacts.push({name:n,initial:n.split(' ').map(s=>s[0]).slice(0,2).join(''),company:c,email:d.get('email'),stage:'Lead',value:'$0',notes:desc});modal.close();filter='All tickets';navigate(k);toast('Created in your demo workspace')}});
document.addEventListener('keydown',e=>{if(e.key==='/'&&!(document.activeElement&&document.activeElement.closest('input, textarea, select, [contenteditable]'))&&!modal.open){e.preventDefault();document.querySelector('#search').focus()}if((e.key==='Enter'||e.key===' ')&&e.target.matches('[role="button"][data-action]')){e.preventDefault();action(e.target.dataset.action,e.target.dataset.id)}if(e.key==='Escape'){document.querySelector('#search-results').hidden=true;if(document.querySelector('#sidebar').classList.contains('open'))setMenu(false,{returnFocus:true});}});
document.querySelector('#close-modal').onclick=()=>modal.close();modal.addEventListener('click',e=>{if(e.target===modal){let r=modal.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)modal.close()}});
/* The phone menu: opens with focus on its first link, closes with Escape, a tap
   outside it, Tab leaving it or a navigation, and cannot be reached with Tab
   while it is closed (workspace.css). */
function setMenu(open,options){const sidebar=document.querySelector('#sidebar'),toggle=document.querySelector('#menu-toggle');sidebar.classList.toggle('open',open);toggle.setAttribute('aria-expanded',String(open));if(open){const first=sidebar.querySelector('#nav a');if(first)setTimeout(()=>first.focus(),60);}else if(options&&options.returnFocus)toggle.focus();}
document.querySelector('#menu-toggle').innerHTML=icon('menu');document.querySelector('#menu-toggle').onclick=()=>setMenu(!document.querySelector('#sidebar').classList.contains('open'));
const outsideMenu=e=>document.querySelector('#sidebar').classList.contains('open')&&!e.target.closest('#sidebar')&&!e.target.closest('#menu-toggle');
/* A tap on the page that is already open changes no hash, so nothing
   navigates: the menu is closed here instead. */
document.addEventListener('click',e=>{if(outsideMenu(e)){setMenu(false);return;}const link=e.target.closest('#nav a');if(link&&document.querySelector('#sidebar').classList.contains('open')&&link.getAttribute('href')===location.hash)setMenu(false,{returnFocus:true});});
/* Tabbing out of the open menu closes it, rather than walking on through the
   page behind its backdrop. */
document.addEventListener('focusin',e=>{if(outsideMenu(e))setMenu(false);});
/* "Skip to content": past the menu and the header, straight into the page. */
document.addEventListener('click',e=>{if(!e.target.closest('[data-skip-to-main]'))return;const main=document.querySelector('#main');main.setAttribute('tabindex','-1');main.focus();});
document.querySelector('#search-icon').innerHTML=icon('search');document.querySelector('#notifications').innerHTML=icon('bell');
/* What needs someone, each entry leading to where it can be dealt with
   (shell-model.js attention), never one this person has already dismissed
   (data/store.js state.dismissedNotifications, from notification_dismissals,
   0061 — [] on a database from before it, so the bell shows everything, as it
   always has). The count on the bell is how many are left. */
function attentionItems(){return shellModel.attention({tickets,invoices:shapedInvoices(),unreadMail:mailUnreadTotal(),eventsToday:(todayEvents()||[]).map(p=>p.event),isManager:isManagerNow(),dismissed:(window.workspaceStore&&workspaceStore.state.dismissedNotifications)||[]});}
function paintBell(){const bell=document.querySelector('#notifications');if(!bell)return;const n=attentionItems().length;let count=bell.querySelector('.bell-count');if(!n){if(count)count.remove();bell.setAttribute('aria-label','Notifications');return;}if(!count){count=document.createElement('span');count.className='bell-count';count.setAttribute('aria-hidden','true');bell.appendChild(count);}count.textContent=overviewModel.badge(n);bell.setAttribute('aria-label',`Notifications: ${overviewModel.plural(n,'thing')} to look at`);}
/* Rebuilt on every open and after a dismissal — the dialog is not part of
   #main, so render() never touches it. focusHeading moves the keyboard to the
   dialog's own heading, the way a page change does to #main's (app.js
   focusNewPage): a dismissal from the keyboard would otherwise leave it on a
   button that just left the page. */
function notificationsModal(focusHeading){const items=attentionItems();showModal('WORKSPACE · NOTIFICATIONS',items.length?`<h2>${overviewModel.plural(items.length,'thing')} to look at.</h2><div class="notification-list">${items.map(i=>`<div class="notification-row"><a class="notification-item" href="#${esc(i.route)}"><strong>${esc(i.title)}</strong><span>${esc(i.detail)}</span></a><button type="button" class="text-btn" data-dismiss-notification="${esc(i.key)}" aria-label="${esc('Dismiss: '+i.title)}">Dismiss</button></div>`).join('')}</div>`:'<h2>You’re up to date.</h2><p class="quiet-text">Nothing needs attention right now.</p>');if(focusHeading){const heading=document.querySelector('#modal-body h2');if(heading){heading.setAttribute('tabindex','-1');heading.focus();}}}
document.querySelector('#notifications').onclick=()=>notificationsModal(false);
/* Dismissing does not need the rest of the workspace reloaded — only this
   person's own read state changed — so it asks for that one part rather than
   going through store.after(), which (deliberately, for a write that changes
   what a page shows) reloads everything. */
document.addEventListener('click',e=>{const dismiss=e.target.closest('[data-dismiss-notification]');if(!dismiss)return;e.preventDefault();if(dismiss.disabled)return;dismiss.disabled=true;const key=dismiss.dataset.dismissNotification;workspaceActions.dismissNotification(key).then(()=>window.workspaceStore.load({quiet:true,only:['dismissedNotifications']})).then(()=>{if(modal.open)notificationsModal(true);},err=>{dismiss.disabled=false;toast(err.message);});});
window.addEventListener('hashchange',()=>navigate(location.hash.slice(1)));
/* The search box: everything loaded — people, companies, tasks and notes as
   well as records — best matches first, twelve at a time, and usable with the
   arrow keys (shell-model.js). */
const search=document.querySelector('#search'),results=document.querySelector('#search-results');
function searchSources(){return {navs:overviewModel.visibleNavs(navs,isManagerNow()),tickets,projects,contacts,companies:(window.workspaceStore&&workspaceStore.state.companies)||[],team,events,projectEvents:(window.workspaceStore&&workspaceStore.state.projectEvents)||[],invoices:shapedInvoices(),invoiceMatches:financeModel.matchesQuery,mails,notes:recordNotes,mailRoute:m=>mailModel.mailRoute({mailbox:mailModel.ALL,folder:mailModel.folderForThread(m,'inbox'),threadId:m.id}),searchedEvents,searchedMails};}
function showResults(){const q=search.value.trim();results.hidden=!q;if(!q)return;const found=shellModel.search(shellModel.searchItems(searchSources()),q);results.innerHTML=found.results.map(x=>`<button type="button" data-nav="${esc(x.route)}">${esc(x.label)}<small>${esc(x.type)}${x.detail?' · '+esc(x.detail):''}</small></button>`).join('')+(found.more?`<p class="search-more">${overviewModel.plural(found.more,'more match','more matches')} — keep typing to narrow it down.</p>`:'')||'<div class="empty-state">No matching records.</div>';}
function moveInResults(e){const buttons=[...results.querySelectorAll('button[data-nav]')];if(!buttons.length||results.hidden)return;e.preventDefault();const next=shellModel.nextFocus(buttons.indexOf(document.activeElement),e.key,buttons.length);if(next===-1)search.focus();else buttons[next].focus();}
/* A past meeting, or an event weeks away with no project, is not in any array
   already loaded — search_events (0064) asks the database instead, once
   typing settles. globalSearchSeq answers a slow request arriving after a
   newer query already has: dropped, since the box must show what it is
   currently asked, never an older answer landing late. Cleared, not left as
   it was, the moment the query changes at all — the loaded-only results are
   still correct on their own; a previous query's events are not. */
let searchedEvents=[],searchedMails=[],globalSearchDebounce=null,globalSearchSeq=0;
const GLOBAL_SEARCH_DEBOUNCE_MS=200;
/* Both database searches ride one debounce and one sequence number: they are
   asked for the same query at the same moment, so a single late answer must
   drop for the same reason either would. Mail hits come back as search rows
   and are turned into thread-shaped objects (mailModel.threadFromSearchHit),
   which is what gives them an id to dedupe on and a route to open. */
function searchDatabaseForBox(q){clearTimeout(globalSearchDebounce);const seq=++globalSearchSeq;if(searchedEvents.length||searchedMails.length){searchedEvents=[];searchedMails=[];showResults();}if(!q||typeof window.workspaceData==='undefined')return;globalSearchDebounce=setTimeout(()=>{if(typeof workspaceData.searchEvents==='function')workspaceData.searchEvents(q).then(rows=>{if(seq!==globalSearchSeq)return;searchedEvents=rows||[];showResults();}).catch(()=>{});if(typeof workspaceData.searchMail==='function')workspaceData.searchMail(q).then(hits=>{if(seq!==globalSearchSeq)return;searchedMails=(hits||[]).map(h=>mailModel.threadFromSearchHit(h));showResults();}).catch(()=>{});},GLOBAL_SEARCH_DEBOUNCE_MS);}
search.addEventListener('input',()=>{showResults();searchDatabaseForBox(search.value.trim());});
search.addEventListener('keydown',e=>{if(e.key==='ArrowDown'||e.key==='ArrowUp')moveInResults(e);});
results.addEventListener('keydown',e=>{if(['ArrowDown','ArrowUp','Home','End'].includes(e.key))moveInResults(e);if(e.key==='Escape'){e.preventDefault();e.stopPropagation();results.hidden=true;search.focus();}});
/* Picking a result puts focus back in the box before the page changes: a new
   page then takes it to its heading, and a result on this page leaves it here
   rather than on a button that has just been hidden. */
results.addEventListener('click',e=>{if(!e.target.closest('button[data-nav]'))return;results.hidden=true;search.value='';search.focus();});
document.addEventListener('click',e=>{if(!e.target.closest('.global-search'))results.hidden=true});
if(!location.hash.includes('/'))navigate(navs.some(n=>n[0]===location.hash.slice(1))?location.hash.slice(1):'overview');
if(document.modelContext?.registerTool){const lifecycle=new AbortController();window.addEventListener('pagehide',()=>lifecycle.abort(),{once:true});for(const tool of [{name:'navigate_workspace',title:'Open workspace app',description:'Navigate to one of the Veyago workspace apps the signed-in person can open.',inputSchema:{type:'object',properties:{app:{type:'string',enum:navs.map(n=>n[0])}},required:['app'],additionalProperties:false},execute:({app})=>{if(!navs.some(n=>n[0]===app))throw Error('Unknown workspace app');if(!overviewModel.canOpen(app,isManagerNow()))throw Error('This account cannot open that app');navigate(app);return{app:page}}}]){try{Promise.resolve(document.modelContext.registerTool({...tool,annotations:{readOnlyHint:false,untrustedContentHint:false}},{signal:lifecycle.signal})).catch(()=>{})}catch{}}}
