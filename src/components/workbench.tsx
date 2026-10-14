'use client';

import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import {
  ArrowDownLeft, Bell, Boxes, Check, ChevronDown, ChevronRight, CircleDollarSign, ClipboardList,
  CreditCard, Eye, FileText, Globe2, HandCoins, LayoutDashboard, Loader2, LogOut, Menu, Package,
  Landmark, Plus, Printer, RefreshCw, Search, Settings, Ship, ShoppingBag, Sparkles, Users, Wallet, X,
} from 'lucide-react';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './ui/dialog';
import { DocumentDetails } from './document-details';
import { DocumentEditor } from './document-editor';
import { DocumentsList } from './documents-list';
import { PaymentDialog } from './document-dialogs';
import { CashBankView, ChequeRow } from './cash-bank-view';
import { ReportsView } from './reports-view';
import { InventoryView } from './inventory-view';
import { StockTransferDialog } from './stock-transfer-dialog';
import { canReadLedger, filterBranch, scopeWorkspace } from '@/modules/erp/access';
import { moduleEnabled } from '@/modules/erp/modules';
import { SettingsView } from './settings-view';
import { MasterDataView } from './master-data-view';
import { entitySpecs } from '@/modules/erp/master-data';
import { SetupWizard } from './setup-wizard';
import { businessToday } from '@/modules/erp/dates';
import { accountBalance, canRun, commissionTotals, outstanding, stock, summary } from '@/modules/erp/engine';
import { D, formatMoney, money, sum } from '@/modules/erp/money';
import { accountNames, type Actor, type Module, type Role, type Workspace } from '@/modules/erp/types';

type WorkspaceMembership = {tenantId:string;role:Role;branchIds:string[];name:string;isDemo:boolean};
type Props = { initialWorkspace: Workspace; actor: Actor; memberships: WorkspaceMembership[] };
type Modal = 'sale'|'purchase'|'receipt'|'payment'|'followup'|null;
const nav:{key:Module;label:string;icon:typeof LayoutDashboard}[]=[
  {key:'dashboard',label:'Overview',icon:LayoutDashboard},{key:'sales',label:'Sales',icon:ShoppingBag},
  {key:'purchasing',label:'Purchasing',icon:ClipboardList},{key:'imports',label:'Imports & costing',icon:Ship},
  {key:'inventory',label:'Inventory',icon:Boxes},{key:'collections',label:'Collections',icon:Wallet},{key:'cashbank',label:'Cash & bank',icon:Landmark},
  {key:'commissions',label:'Commissions',icon:HandCoins},{key:'payroll',label:'Payroll',icon:Users},
  {key:'accounting',label:'Accounting',icon:CircleDollarSign},
  {key:'reports',label:'Reports',icon:FileText},{key:'settings',label:'Settings',icon:Settings},
];
const labels=Object.fromEntries(nav.map(item=>[item.key,item.label])) as Record<Module,string>;
const descriptions:Record<Module,string>={dashboard:'A live view of money, stock and today’s work.',sales:'Quotes, orders, deliveries, invoices and returns.',purchasing:'Supplier orders, receipts, bills and payments.',imports:'Shipments, declarations and landed-cost allocation.',inventory:'Availability, movement and weighted-average valuation.',collections:'Receivables, recovery actions and post-dated cheques.',cashbank:'Bank and cash balances, transfers, expenses and cheques in hand.',commissions:'Earned, released, paid and recoverable sales earnings.',payroll:'Salary, attendance, commission and approval runs.',accounting:'Posted journals, ledgers and control accounts.',reports:'Operational and financial results with source drill-down.',settings:'Company configuration, role preview and audit history.'};
// Each module's header action; modules without a matching transaction show none.
const headerActions:Partial<Record<Module,{modal:Exclude<Modal,null>;label:string}>>={sales:{modal:'sale',label:'New sales invoice'},purchasing:{modal:'purchase',label:'New purchase order'},collections:{modal:'receipt',label:'Record receipt'}};
const statusTone=(value:string)=>['paid','cleared','accepted','approved','submitted','costed','reconciled','available'].includes(value)?'success':['rejected','bounced'].includes(value)?'danger':['queued','received','pending','outcome_unknown','low stock','review'].includes(value)?'warning':value==='draft'?'draft':'info';
const roleModules:Record<Role,Module[]>={Owner:nav.map(item=>item.key),Accountant:nav.map(item=>item.key),Auditor:nav.map(item=>item.key),'Sales Manager':['dashboard','sales','collections','commissions','reports'],'Salesperson':['dashboard','sales','collections','commissions'],'Recovery Officer':['dashboard','collections','cashbank','reports'],'Warehouse Manager':['dashboard','purchasing','imports','inventory','reports'],'Payroll Administrator':['dashboard','commissions','payroll','reports']};
const canView=(role:Role,module:Module,w?:Pick<Workspace,'modules'>)=>roleModules[role].includes(module)&&(!w||moduleEnabled(w,module));
const canEdit=(role:Role,module:Module)=>role!=='Auditor'&&({Owner:nav.map(item=>item.key),Accountant:['sales','purchasing','imports','inventory','collections','cashbank','commissions','payroll','accounting','settings'],'Sales Manager':['sales','collections','commissions'],'Salesperson':['sales'],'Recovery Officer':['collections'],'Warehouse Manager':['purchasing','imports','inventory'],'Payroll Administrator':['payroll']} as Partial<Record<Role,Module[]>>)[role]?.includes(module)===true;
const today=()=>businessToday();
const addDays=(date:string,days:number)=>{const value=new Date(`${date}T00:00:00Z`);value.setUTCDate(value.getUTCDate()+days);return value.toISOString().slice(0,10)};
const receivable=(w:Workspace)=>w.documents.filter(d=>d.kind==='sales_invoice'&&d.status==='submitted');
const openBalance=(w:Workspace)=>money(sum(receivable(w).map(d=>D.max(0,outstanding(d)))));
const clearedCollections=(w:Workspace)=>w.receipts.filter(r=>r.status==='cleared'&&w.parties.find(p=>p.id===r.partyId)?.type==='customer');

function attentionItems(w:Workspace,role:Role){const now=today();return ([
  ['commissions','Commission awaiting approval',w.commissions.filter(c=>D(c.released).gt(c.paid)&&!c.approved).length],
  ['imports','Shipment costs unallocated',w.shipments.reduce((n,sh)=>n+sh.costs.filter(c=>!c.allocated).length,0)],
  ['collections','Open customer invoices',receivable(w).filter(d=>D(outstanding(d)).gt(0)).length],
  ['collections','Cheques due for deposit or clearing',w.receipts.filter(r=>r.method==='cheque'&&['received','deposited'].includes(r.status)&&r.dueDate<=now).length],
  ['collections','Recovery follow-ups due',w.followUps.filter(f=>f.nextDate<=now).length],
  ['sales','Draft sales documents to submit',w.documents.filter(d=>d.status==='draft'&&['quotation','sales_order','delivery','sales_invoice'].includes(d.kind)).length],
] as [Module,string,number][]).filter(([module,,count])=>count>0&&canView(role,module,w))}

function WorkspaceSwitcher({workspace,memberships}:{workspace:Workspace;memberships:WorkspaceMembership[]}){
  return <DropdownMenu.Root>
    <DropdownMenu.Trigger asChild>
      <button type="button" className="workspace-picker" aria-label={`Switch company, current company ${workspace.company.name}`}>
        <span className="company-icon">{workspace.company.logo}</span>
        <span><strong>{workspace.company.name}</strong>{workspace.demo&&<small>Demo workspace</small>}</span>
        <ChevronDown size={15}/>
      </button>
    </DropdownMenu.Trigger>
    <DropdownMenu.Portal>
      <DropdownMenu.Content className="workspace-menu" align="start" sideOffset={7}>
        <div className="workspace-menu-label">YOUR COMPANIES</div>
        {memberships.map(item=>{
          const selected=item.tenantId===workspace.tenantId;
          return <DropdownMenu.Item
            key={item.tenantId}
            className="workspace-menu-item"
            onSelect={()=>{if(!selected)window.location.assign(`/?tenant=${encodeURIComponent(item.tenantId)}`)}}
          >
            <span className="company-icon">{item.name.trim().charAt(0).toUpperCase()}</span>
            <span className="workspace-menu-name"><strong>{selected?workspace.company.name:item.name}</strong><small>{item.isDemo?'Demo workspace':'Private workspace'}</small></span>
            {selected&&<Check size={16} aria-label="Current company"/>}
          </DropdownMenu.Item>
        })}
      </DropdownMenu.Content>
    </DropdownMenu.Portal>
  </DropdownMenu.Root>
}

function BranchPicker({workspace,branch,setBranch,allowed}:{workspace:Workspace;branch:string;setBranch:(id:string)=>void;allowed:string[]}){
  const options=workspace.branches.filter(item=>!allowed.length||allowed.includes(item.id));
  const current=options.find(item=>item.id===branch);
  // One branch means nothing to filter: show nothing rather than a dead "Main branch" button.
  if(options.length<2)return null;
  return <DropdownMenu.Root><DropdownMenu.Trigger asChild><Button variant="outline" aria-label={`Branch filter, showing ${current?.name||'all branches'}`}><Globe2 size={16}/>{current?.name||'All branches'}<ChevronDown size={14}/></Button></DropdownMenu.Trigger>
    <DropdownMenu.Portal><DropdownMenu.Content className="workspace-menu light-menu" align="end" sideOffset={6}>
      {[{id:'',name:'All branches'},...options].map(item=><DropdownMenu.Item key={item.id||'all'} className="workspace-menu-item compact" onSelect={()=>setBranch(item.id)}><span className="workspace-menu-name"><strong>{item.name}</strong></span>{branch===item.id&&<Check size={15}/>}</DropdownMenu.Item>)}
    </DropdownMenu.Content></DropdownMenu.Portal></DropdownMenu.Root>;
}

function NotificationBell({items,go}:{items:[Module,string,number][];go:(module:Module)=>void}){
  const total=items.reduce((n,[, ,count])=>n+count,0);
  return <DropdownMenu.Root><DropdownMenu.Trigger asChild><button type="button" className="icon-button" aria-label={total?`Notifications, ${total} items need attention`:'Notifications, nothing needs attention'}><Bell size={19}/>{total>0&&<span className="bell-count">{total>99?'99+':total}</span>}</button></DropdownMenu.Trigger>
    <DropdownMenu.Portal><DropdownMenu.Content className="workspace-menu light-menu notification-menu" align="end" sideOffset={8}>
      <div className="workspace-menu-label">NEEDS ATTENTION</div>
      {items.length?items.map(([module,title,count])=><DropdownMenu.Item key={title} className="workspace-menu-item compact" onSelect={()=>go(module)}><span className="workspace-menu-name"><strong>{title}</strong><small>{count} · {labels[module]}</small></span><ChevronRight size={14}/></DropdownMenu.Item>):<div className="menu-empty">You’re all caught up.</div>}
    </DropdownMenu.Content></DropdownMenu.Portal></DropdownMenu.Root>;
}

function SearchDialog({open,close,workspace,role,go}:{open:boolean;close:()=>void;workspace:Workspace;role:Role;go:(module:Module)=>void}){
  const [query,setQuery]=useState('');
  const needle=query.trim().toLocaleLowerCase();
  const results=useMemo(()=>{if(!needle)return [];const salesKinds=['quotation','sales_order','delivery','sales_invoice','credit_note'];const rows:{key:string;title:string;detail:string;module:Module}[]=[
    ...workspace.documents.map(d=>({key:d.id,title:d.number,detail:`${d.kind.replaceAll('_',' ')} · ${workspace.parties.find(p=>p.id===d.partyId)?.name||''} · ${formatMoney(d.total)}`,module:(salesKinds.includes(d.kind)?'sales':'purchasing') as Module})),
    ...workspace.parties.map(p=>({key:p.id,title:p.name,detail:`${p.type} · ${p.city}`,module:(p.type==='customer'?'collections':'purchasing') as Module})),
    ...workspace.items.map(i=>({key:i.id,title:i.name,detail:`${i.sku} · ${i.category}`,module:'inventory' as Module})),
  ];return rows.filter(r=>canView(role,r.module,workspace)&&`${r.title} ${r.detail}`.toLocaleLowerCase().includes(needle)).slice(0,8)},[needle,workspace,role]);
  return <Dialog open={open} onOpenChange={value=>{if(!value){close();setQuery('')}}}><DialogContent className="search-dialog"><DialogTitle>Search</DialogTitle><DialogDescription>Documents, customers, suppliers and products in this workspace.</DialogDescription>
    <input className="search-input" autoFocus type="search" aria-label="Search the workspace" placeholder="Invoice number, customer, SKU…" value={query} onChange={event=>setQuery(event.target.value)}/>
    <div className="search-results" role="list">{needle&&!results.length&&<div className="empty-state">No matches for “{query}”.</div>}{results.map(r=><button key={`${r.module}:${r.key}`} role="listitem" className="search-result" onClick={()=>{go(r.module);close();setQuery('')}}><span><strong>{r.title}</strong><small>{r.detail}</small></span><span className="search-module">{labels[r.module]}</span></button>)}</div>
  </DialogContent></Dialog>;
}

export function Workbench({initialWorkspace,actor,memberships}:Props){
  const [workspace,setWorkspace]=useState(initialWorkspace);const [active,setActive]=useState<Module>('dashboard');
  const [mobile,setMobile]=useState(false);
  // Finishing setup unblurs the workspace behind the card once; later loads render normally.
  const [revealed,setRevealed]=useState(false);const wasSettingUp=useRef(!initialWorkspace.setup.complete);const [modal,setModal]=useState<Modal>(null);const [stockTransferOpen,setStockTransferOpen]=useState(false);const [busy,setBusy]=useState('');const [notice,setNotice]=useState('');const [role,setRole]=useState<Role>(actor.role);
  const [branch,setBranch]=useState('');const [searchOpen,setSearchOpen]=useState(false);const [resetOpen,setResetOpen]=useState(false);
  // Navigation stays disabled until React has hydrated so a click on the server-rendered page is never lost.
  const [ready,setReady]=useState(false);useEffect(()=>setReady(true),[]);
  const previewing=role!==actor.role;
  // Role preview shows the data that role would actually receive, not just its screens.
  const view=useMemo(()=>{let w=workspace;if(previewing){const employeeId=role==='Salesperson'?w.documents.flatMap(d=>d.lines.map(l=>l.employeeId)).find(Boolean):actor.employeeId;w=scopeWorkspace(w,{...actor,role,employeeId})}if(branch)w=filterBranch(w,branch);return w},[workspace,previewing,role,branch,actor]);
  const viewActor:Actor={...actor,role};const ledgerView=canReadLedger(role)&&!branch;
  const attention=attentionItems(view,role);
  useEffect(()=>{const onKey=(event:KeyboardEvent)=>{if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==='k'){event.preventDefault();setSearchOpen(true)}};window.addEventListener('keydown',onKey);return ()=>window.removeEventListener('keydown',onKey)},[]);
  // Commands carry an idempotency key, so a response that never reached us as JSON (proxy error, dev-server
  // recompile, dropped connection) can be retried once without risking a double posting.
  async function postCommand(body:string){const send=()=>fetch('/api/workspace',{method:'POST',headers:{'content-type':'application/json','x-tenant-id':workspace.tenantId},body});let response=await send();let result:Record<string,unknown>|null=null;try{result=await response.json()}catch{result=null}if(result===null||(response.status>=500&&!result?.message)){await new Promise(r=>setTimeout(r,600));response=await send();try{result=await response.json()}catch{result={success:false,message:'The server did not respond properly. Please try again.'}}}return {response,result:result as {success?:boolean;message?:string;passwordRequired?:boolean;recordId?:string;workspace?:Workspace}};}
  async function command(type:string,payload:Record<string,unknown>,options?:{confirmPassword?:string}):Promise<{ok:boolean;message:string;passwordRequired?:boolean;recordId?:string;workspace?:Workspace}>{setBusy(type);setNotice('');setNoticeError(false);try{const {response,result}=await postCommand(JSON.stringify({type,payload,idempotencyKey:crypto.randomUUID(),...(options?.confirmPassword?{confirmPassword:options.confirmPassword}:{})}));if(!response.ok||!result.success){if(!result.passwordRequired){setNotice(result.message||'The change could not be saved.');setNoticeError(true);}return {ok:false,message:result.message||'The change could not be saved.',passwordRequired:!!result.passwordRequired}}if(result.workspace)setWorkspace(result.workspace);setNotice(result.message??'');if(type==='follow_up')setModal(null);if(type==='stock_transfer')setStockTransferOpen(false);return {ok:true,message:result.message??'',recordId:result.recordId,workspace:result.workspace}}catch(error){const message=error instanceof Error?error.message:'The change could not be saved.';setNotice(message);setNoticeError(true);return {ok:false,message}}finally{setBusy('')}}
  async function resetDemo(){setBusy('reset');setNotice('');try{const response=await fetch('/api/demo-reset',{method:'POST'});const result=await response.json();if(response.ok)setWorkspace(result.workspace);setNotice(response.ok?result.message:result.message||'The demo could not be reset.')}finally{setBusy('');setResetOpen(false)}}
  const go=(module:Module)=>{setActive(module);setMobile(false)};
  const changeRole=(next:Role)=>{setRole(next);if(!canView(next,active,workspace))setActive('dashboard')};
  useEffect(()=>{if(!canView(role,active,workspace))setActive('dashboard')},[workspace.modules,role,active,workspace]);
  const initials=actor.name.split(/\s+/).map(word=>word[0]).join('').slice(0,2).toUpperCase();
  const openStockTransfer=()=>{setNotice('');setStockTransferOpen(true)};
  const headerAction=headerActions[active];
  // The wizard keeps its provisioning screen up for a moment after setup completes, then the workspace is revealed.
  const [noticeError,setNoticeError]=useState(false);
  const [provisioning,setProvisioning]=useState(false);const settingUp=!workspace.setup.complete||provisioning;
  useEffect(()=>{if(wasSettingUp.current&&!settingUp){wasSettingUp.current=false;setRevealed(true);const t=setTimeout(()=>setRevealed(false),900);return()=>clearTimeout(t);}if(settingUp)wasSettingUp.current=true;},[settingUp]);
  if(settingUp&&actor.role==='Auditor')return <main className="loading-screen"><div><h1>{workspace.company.name} is being set up</h1><p>The company owner has not finished setup yet. Try again later.</p><form action="/auth/signout" method="post"><button className="button button-outline">Sign out</button></form></div></main>;
  return <>{settingUp&&<SetupWizard workspace={workspace} actor={actor} memberships={memberships} onWorkspace={setWorkspace} command={command} onProvisioning={setProvisioning}/>}<div className={`app-shell ${settingUp?'setup-backdrop':revealed?'setup-reveal':''}`} inert={settingUp||undefined} aria-hidden={settingUp||undefined}>{mobile&&<button type="button" className="sidebar-scrim" aria-label="Dismiss menu" onClick={()=>setMobile(false)}/>}<aside id="app-navigation" className={`sidebar ${mobile?'mobile-open':''}`}><button type="button" className="sidebar-close" aria-label="Close menu" onClick={()=>setMobile(false)}><X size={18}/></button><a className="brand" href="/"><span className="brand-mark">S</span><span>Sahulat<span className="brand-light">ERP</span></span></a><WorkspaceSwitcher workspace={workspace} memberships={memberships}/><div className="nav-label">WORKSPACE</div><nav>{nav.filter(item=>canView(role,item.key,view)).map(({key,label,icon:Icon})=><button key={key} data-module={key} className={active===key?'nav-item active':'nav-item'} disabled={!ready} onClick={()=>go(key)}><span className="nav-icon"><Icon size={16}/></span><span>{label}</span>{key==='commissions'&&<span className="new-label">LIVE</span>}</button>)}</nav><div className="sidebar-bottom"><div className="demo-note"><Sparkles size={17}/><div><strong>All changes saved</strong><small>Saved as you work</small></div></div><form action="/auth/signout" method="post"><button className="profile"><span className="avatar">{initials}</span><div><strong>{actor.name}</strong><small>{actor.role}</small></div><LogOut size={15}/></button></form></div></aside>
    <div className="main-shell"><header className="topbar"><div className="breadcrumb"><button type="button" className="mobile-menu" aria-label={mobile?'Close navigation':'Open navigation'} aria-expanded={mobile} aria-controls="app-navigation" onClick={()=>setMobile(value=>!value)}>{mobile?<X size={19}/>:<Menu size={19}/>}</button><span>Workspace</span><ChevronRight size={14}/><strong>{labels[active]}</strong></div><div className="topbar-right"><span className="topbar-date">{new Date().toLocaleDateString('en-PK',{weekday:'short',day:'numeric',month:'short',timeZone:'Asia/Karachi'})}</span>{previewing&&<span className="preview-chip"><Eye size={14}/>Previewing as {role}<button type="button" onClick={()=>changeRole(actor.role)}>Exit preview</button></span>}<button type="button" className="search-hint" onClick={()=>setSearchOpen(true)} aria-label="Search anything (Control or Command K)"><Search size={16}/> Search anything <kbd>⌘ K</kbd></button><span className="topbar-divider"/><NotificationBell items={attention} go={go}/><span className="mini-avatar" aria-hidden="true">{initials}</span></div></header>
      <main className="main-content"><div className="page-heading"><div><h1>{labels[active]}{workspace.demo&&<span className="live-tag">Demo workspace</span>}</h1><p>{descriptions[active]}</p></div><div className="heading-actions"><BranchPicker workspace={workspace} branch={branch} setBranch={setBranch} allowed={actor.branchIds}/>{headerAction&&canEdit(role,active)&&<Button onClick={()=>setModal(headerAction.modal)}><Plus size={17}/>{headerAction.label}</Button>}</div></div>
        {branch&&canReadLedger(role)&&['dashboard','accounting','reports'].includes(active)&&<div className="simulation-note">Showing {workspace.branches.find(b=>b.id===branch)?.name} operations. General-ledger balances are company-wide and are not split by branch.</div>}
        {notice&&<div className={noticeError?'error-note':'form-note'} role={noticeError?'alert':'status'}>{notice}</div>}
        <div key={active} className="view-enter"><View active={active} workspace={view} ledgerView={ledgerView} actor={viewActor} busy={busy} notice={notice} command={command} open={setModal} openStockTransfer={openStockTransfer} go={go} reset={()=>setResetOpen(true)} role={role} realRole={actor.role} setRole={changeRole} onWorkspace={setWorkspace} fullWorkspace={workspace}/></div>
        <footer className="page-footer"><span>SAHULAT ERP <span>Made for the way you do business.</span></span><span>PKR · Asia/Karachi</span></footer></main></div>
    <TransactionDialog modal={modal==='followup'?modal:null} close={()=>setModal(null)} workspace={view} busy={busy} command={command}/>
    {modal==='sale'&&<DocumentEditor open kind="sales_invoice" workspace={view} actor={viewActor} busy={busy} onClose={()=>setModal(null)} command={command}/>}
    {modal==='purchase'&&<DocumentEditor open kind="purchase_order" workspace={view} actor={viewActor} busy={busy} onClose={()=>setModal(null)} command={command}/>}
    {modal==='receipt'&&<PaymentDialog open partyType="customer" workspace={view} busy={busy} onClose={()=>setModal(null)} command={command}/>}
    {modal==='payment'&&<PaymentDialog open partyType="supplier" workspace={view} busy={busy} onClose={()=>setModal(null)} command={command}/>}
    <StockTransferDialog open={stockTransferOpen} onClose={()=>setStockTransferOpen(false)} workspace={view} actor={viewActor} busy={busy} notice={stockTransferOpen?notice:''} command={command}/>
    <SearchDialog open={searchOpen} close={()=>setSearchOpen(false)} workspace={view} role={role} go={go}/>
    <Dialog open={resetOpen} onOpenChange={setResetOpen}><DialogContent className="confirm-dialog"><DialogTitle>Reset the demo company?</DialogTitle><DialogDescription>Every change made in {workspace.company.name} since the last reset — documents, payments, stock, payroll and journals — will be replaced with the original synthetic data. Your other workspaces are not affected. This cannot be undone.</DialogDescription><div className="form-actions"><Button variant="outline" onClick={()=>setResetOpen(false)}>Cancel</Button><Button variant="destructive" disabled={busy==='reset'} onClick={resetDemo}>{busy==='reset'?<Loader2 className="spin" size={16}/>:<RefreshCw size={16}/>}Reset demo data</Button></div></DialogContent></Dialog>
  </div></>;
}

type CommandFn=(type:string,payload:Record<string,unknown>,options?:{confirmPassword?:string})=>Promise<{ok:boolean;message:string;passwordRequired?:boolean}>;
type ViewProps={active:Module;workspace:Workspace;fullWorkspace:Workspace;ledgerView:boolean;actor:Actor;busy:string;notice:string;command:CommandFn;open:(modal:Modal)=>void;openStockTransfer:()=>void;go:(module:Module)=>void;reset:()=>void;role:Role;realRole:Role;setRole:(role:Role)=>void;onWorkspace:(next:Workspace)=>void};
function Tabbed({tabs}:{tabs:{key:string;label:string;content:ReactNode}[]}){const [tab,setTab]=useState(tabs[0].key);const current=tabs.find(t=>t.key===tab)??tabs[0];return <div className="stack"><div className="tabs" role="tablist">{tabs.map(t=><button key={t.key} role="tab" aria-selected={current.key===t.key} className={`tab ${current.key===t.key?'active':''}`} onClick={()=>setTab(t.key)}>{t.label}</button>)}</div>{current.content}</div>}
function View(props:ViewProps){const {active,workspace,busy,command,open,ledgerView}=props;const editable=canEdit(props.actor.role,active);const data=(key:keyof typeof entitySpecs)=><MasterDataView spec={entitySpecs[key] as never} workspace={workspace} editable={editable} busy={busy} command={command}/>;if(active==='dashboard')return <Dashboard {...props}/>;
  if(active==='sales')return <Tabbed key="sales" tabs={[{key:'documents',label:'Documents',content:<DocumentsList side="sales" workspace={workspace} actor={props.actor} editable={editable} busy={busy} command={command}/>},{key:'customers',label:'Customers',content:data('customers')}]}/>;
  if(active==='purchasing'){const payments=workspace.receipts.filter(r=>workspace.parties.find(p=>p.id===r.partyId)?.type==='supplier');return <Tabbed key="purchasing" tabs={[{key:'documents',label:'Documents',content:<DocumentsList side="purchasing" workspace={workspace} actor={props.actor} editable={editable} busy={busy} command={command}/>},{key:'payments',label:'Supplier payments',content:<TableCard title="Supplier payments" action={editable&&canRun(props.actor.role,'create_receipt')?<Button onClick={()=>open('payment')}><Plus size={16}/>Record payment</Button>:undefined} heads={['Payment','Supplier','Date','Method / cheque','Status','Amount (PKR)','Action']} rows={payments.slice().reverse().map(r=>[r.number,nameOf(workspace,r.partyId),r.date,r.method==='cheque'?r.chequeNo:r.method,<Status key="s" value={r.status}/>,formatMoney(r.amount),<a key="p" className="button button-outline button-sm" href={`/print/receipt/${r.id}?tenant=${workspace.tenantId}`} target="_blank" rel="noopener" aria-label={`Print ${r.number}`}><Printer size={14}/>Print</a>])}/>},{key:'suppliers',label:'Suppliers',content:data('suppliers')}]}/>}
  if(active==='imports')return <section className="stack"><TableCard title="Import shipments" heads={['Shipment','Supplier','Container / GD','ETA','Status','Unallocated','Action']} rows={workspace.shipments.map(sh=>{const pending=sh.costs.filter(cost=>!cost.allocated);return[sh.number,nameOf(workspace,sh.supplierId),`${sh.container} · ${sh.gdNumber}`,sh.eta,<Status key="s" value={sh.status}/>,formatMoney(money(sum(pending.map(c=>c.amount)))),editable&&pending.length?<Button key="a" size="sm" disabled={!!busy} onClick={()=>command('allocate_shipment',{id:sh.id,date:today()})}>Allocate</Button>:<span key="a">{pending.length?'Read only':'Complete'}</span>]})}/></section>;
  if(active==='inventory')return <Tabbed key="inventory" tabs={[{key:'stock',label:'Stock',content:<InventoryView workspace={workspace} actor={props.actor} busy={busy} notice={props.notice} command={command} openStockTransfer={props.openStockTransfer}/>},{key:'products',label:'Products',content:data('items')},{key:'warehouses',label:'Warehouses',content:<BranchesAndWarehouses workspace={workspace} editable={editable} busy={busy} command={command}/>}]}/>;
  if(active==='collections'){const followUpAllowed=canRun(props.actor.role,'follow_up');return <div className="stack"><Metrics values={[['Outstanding',formatMoney(openBalance(workspace))],['Cleared',formatMoney(money(sum(clearedCollections(workspace).map(r=>r.amount))))],['PDCs due',String(workspace.receipts.filter(r=>r.method==='cheque'&&['received','deposited'].includes(r.status)).length)],['Bounced',String(workspace.receipts.filter(r=>r.status==='bounced').length)]]}/><section className="card"><div className="card-heading"><div><h2>Cheques in hand</h2><p>Deposit into an account, then mark cleared or bounced</p></div></div><div className="table-scroll"><table><thead><tr><th>Cheque</th><th>Customer / supplier</th><th>Cheque date</th><th>Amount</th><th>Status</th><th>Account</th><th>Actions</th></tr></thead><tbody>{workspace.receipts.filter(r=>r.method==='cheque'&&['received','deposited'].includes(r.status)).length?workspace.receipts.filter(r=>r.method==='cheque'&&['received','deposited'].includes(r.status)).map(r=><ChequeRow key={r.id} receipt={r} workspace={workspace} editable={editable} busy={busy} command={command}/>):<tr><td colSpan={7}><div className="empty-state">No cheques waiting.</div></td></tr>}</tbody></table></div></section><TableCard title="Customer receipts" action={editable?<Button onClick={()=>open('receipt')}><Plus size={16}/>Record receipt</Button>:undefined} heads={['Receipt','Customer','Date','Method / cheque','Account','Status','Amount','Action']} rows={workspace.receipts.filter(r=>workspace.parties.find(p=>p.id===r.partyId)?.type!=='supplier').slice().reverse().map(r=>[r.number,nameOf(workspace,r.partyId),r.date,r.method==='cheque'?r.chequeNo:r.method,workspace.bankAccounts.find(a=>a.id===r.accountId)?.name??(r.accountId?'—':'Legacy'),<Status key="s" value={r.status}/>,formatMoney(r.amount),<a key="p" className="button button-outline button-sm" href={`/print/receipt/${r.id}?tenant=${workspace.tenantId}`} target="_blank" rel="noopener" aria-label={`Print ${r.number}`}><Printer size={14}/>Print</a>])}/><TableCard title="Recovery follow-ups" action={followUpAllowed?<Button variant="outline" onClick={()=>open('followup')}><Plus size={16}/>Log follow-up</Button>:undefined} heads={['Logged','Customer','Note','Next action','By']} rows={[...workspace.followUps].reverse().map(f=>[f.date,nameOf(workspace,f.partyId),f.note,<Status key="n" value={f.nextDate<=today()?`due ${f.nextDate}`:f.nextDate}/>,f.actor])}/></div>}
  if(active==='cashbank')return <CashBankView workspace={workspace} actor={props.actor} editable={editable} busy={busy} command={command}/>;
  if(active==='commissions'){const totals=commissionTotals(workspace);return <Tabbed key="commissions" tabs={[{key:'entitlements',label:'Entitlements',content:<div className="stack"><Metrics values={[['Earned',formatMoney(totals.earned)],['Unreleased',formatMoney(totals.unreleased)],['Released unpaid',formatMoney(totals.unpaid)],['Recoverable',formatMoney(totals.recoverable)]]}/><TableCard title="Commission entitlements" heads={['Employee','Invoice','Earned','Released','Paid','State','Action']} rows={workspace.commissions.map(c=>[workspace.employees.find(e=>e.id===c.employeeId)?.name||'—',workspace.documents.find(d=>d.id===c.invoiceId)?.number||'—',formatMoney(c.earned),formatMoney(c.released),formatMoney(c.paid),<Status key="s" value={D(c.paid).gt(c.released)?'recoverable':c.approved?'approved':D(c.released).gt(c.paid)?'pending':'unreleased'}/>,editable&&D(c.released).gt(c.paid)&&!c.approved?<Button key="a" size="sm" disabled={!!busy} onClick={()=>command('approve_commission',{ids:[c.id]})}>Approve</Button>:<span key="a">—</span>])}/></div>},{key:'plans',label:'Plans',content:data('plans')},{key:'salespeople',label:'Salespeople',content:data('employees')}]}/>}
  if(active==='payroll')return <Tabbed key="payroll" tabs={[{key:'runs',label:'Payroll runs',content:<div className="stack"><TableCard title="Payroll runs" action={editable?<Button disabled={!!busy} onClick={()=>command('create_payroll',{month:today().slice(0,7),date:today()})}><Plus size={16}/>Create payroll</Button>:undefined} heads={['Run','Month','Employees','Commission recovered','Status','Net payroll','Next action']} rows={workspace.payrolls.map(run=>{const next=run.status==='draft'?'reviewed':run.status==='reviewed'?'approved':run.status==='approved'?'paid':null;return[run.number,run.month,run.lines.length,formatMoney(money(sum(run.lines.map(l=>l.recovery??'0')))),<Status key="s" value={run.status}/>,formatMoney(run.total),editable&&next?<Button key="a" size="sm" disabled={!!busy} onClick={()=>command('update_payroll',{id:run.id,status:next})}>{next}</Button>:<span key="a">{next?'Read only':'Complete'}</span>]})}/></div>},{key:'employees',label:'Employees',content:data('employees')}]}/>;
  if(active==='accounting')return <div className="stack"><Metrics values={[['Bank & cash',formatMoney(accountBalance(workspace,'1000'))],['Receivables',formatMoney(accountBalance(workspace,'1100'))],['Inventory',formatMoney(accountBalance(workspace,'1200'))],['Payables',formatMoney(D(accountBalance(workspace,'2000')).negated().toString())]]}/><TableCard title="Trial balance" heads={['Code','Account','Net balance']} rows={Object.entries(accountNames).map(([code,name])=>[code,name,formatMoney(accountBalance(workspace,code))])}/><TableCard title="Recent posted journals" heads={['Journal','Date','Source','Memo','Debits']} rows={workspace.journals.slice(-8).reverse().map(j=>[j.number,j.date,j.sourceId,j.memo,formatMoney(money(sum(j.lines.map(l=>l.debit))))])}/></div>;
  if(active==='reports')return <ReportsView workspace={workspace} ledgerView={ledgerView} stockVisible={canView(props.role,'inventory',workspace)}/>;
  return <SettingsView workspace={props.fullWorkspace} realRole={props.realRole} role={props.role} setRole={props.setRole} busy={busy} command={command} onWorkspace={props.onWorkspace} onReset={props.reset} audit={<TableCard title="Audit history" heads={['Time','Actor','Role','Action','Detail']} rows={workspace.audit.slice(-15).reverse().map(e=>[new Date(e.date).toLocaleString('en-PK',{timeZone:'Asia/Karachi'}),e.actor,e.role,e.action.replaceAll('_',' '),e.detail])}/>}/>;
}

// Weekly sales invoiced and customer collections cleared, ending at the latest activity date.
function activitySeries(w:Workspace){
  const sales=receivable(w).map(d=>({date:d.date,amount:D(d.total)}));
  const cleared=clearedCollections(w).map(r=>({date:w.journals.find(j=>j.sourceId===`${r.id}:cleared`)?.date??r.date,amount:D(r.amount)}));
  const dates=[...sales,...cleared].map(x=>x.date).sort();if(!dates.length)return [];
  const end=dates.at(-1)!;const span=Math.floor((Date.parse(end)-Date.parse(dates[0]))/604800000)+1;const weeks=Math.min(12,Math.max(1,span));
  return Array.from({length:weeks},(_,index)=>{const to=addDays(end,-(weeks-1-index)*7);const from=addDays(to,-6);const inRange=(x:{date:string})=>x.date>=from&&x.date<=to;
    return {label:new Date(`${from}T00:00:00Z`).toLocaleDateString('en-PK',{day:'numeric',month:'short',timeZone:'UTC'}),from,to,sales:sum(sales.filter(inRange).map(x=>x.amount)),collections:sum(cleared.filter(inRange).map(x=>x.amount))}});
}

function Dashboard(props:ViewProps){const {workspace,go,ledgerView,role}=props;const [selectedInvoiceId,setSelectedInvoiceId]=useState<string|null>(null);
  const series=activitySeries(workspace);const peak=series.reduce((max,x)=>D.max(max,x.sales,x.collections),D(0));const scale=peak.gt(0)?peak:D(1);
  const metrics:[string,string][]=ledgerView?(()=>{const s=summary(workspace);return [['Total sales',formatMoney(s.sales)],['Collections',formatMoney(s.collections)],['Outstanding receivables',formatMoney(s.receivables)],['Inventory value',formatMoney(s.inventory)]] as [string,string][]})():[['Invoiced sales (net)',formatMoney(money(sum(receivable(workspace).map(d=>d.net))))],['Cleared collections',formatMoney(money(sum(clearedCollections(workspace).map(r=>r.amount))))],['Open receivables',formatMoney(openBalance(workspace))],['Open documents',String(workspace.documents.filter(d=>d.status==='draft').length)]];
  const attention=attentionItems(workspace,role);
  return <><div className="welcome-strip"><div className="welcome-icon"><Sparkles size={20}/></div><div><strong>A clear view of your day.</strong><span> {ledgerView?'Every figure comes from your posted records.':'Figures cover the records your role and branch can see.'}</span></div></div><Metrics values={metrics}/>
    <div className="dashboard-main"><section className="card"><div className="card-heading"><div><h2>Sales & collections</h2><p>{series.length?`Weekly totals, ${series[0].from} to ${series.at(-1)!.to}`:'No posted sales or cleared collections yet'}</p></div><div className="chart-legend"><span><i className="legend-sales"/>Invoiced</span><span><i className="legend-collections"/>Cleared</span></div></div>
      {series.length?<div className="preview-chart" role="img" aria-label={`Weekly sales and collections. ${series.map(x=>`${x.label}: sales ${formatMoney(x.sales.toString())}, collections ${formatMoney(x.collections.toString())}`).join('; ')}`}><div className="chart-y">{[1,.66,.33,0].map(f=><span key={f}>{formatMoney(scale.mul(f).toString(),true).replace('Rs ','')}</span>)}</div><div className="bars">{series.map(x=><div className="bar-group" key={x.from} title={`${x.from} – ${x.to}\nSales ${formatMoney(x.sales.toString())}\nCollections ${formatMoney(x.collections.toString())}`}><div className="bar sales" style={{height:`${x.sales.div(scale).mul(100).toNumber()}%`}}/><div className="bar collections" style={{height:`${x.collections.div(scale).mul(100).toNumber()}%`}}/><span>{x.label}</span></div>)}</div></div>:<div className="empty-state">Submit an invoice or clear a receipt to see activity here.</div>}</section>
      <section className="card"><div className="card-heading"><div><h2>Needs your attention</h2><p>Open a queue to take action</p></div></div>{attention.length?attention.map(([module,title,count])=><button className="attention-row" key={title} onClick={()=>go(module)}><span className="attention-icon green"><HandCoins size={19}/></span><div><strong>{title}</strong><small>{count} records</small></div><ChevronRight size={16}/></button>):<div className="empty-state">Nothing needs attention.</div>}</section></div>
    <TableCard title="Recent sales" heads={['Invoice','Customer','Date','Collection','Amount','Action']} rows={workspace.documents.filter(d=>d.kind==='sales_invoice').slice(-5).reverse().map(d=>{const balance=D(outstanding(d));return [<button key="invoice" className="text-button" onClick={()=>setSelectedInvoiceId(d.id)}>{d.number}</button>,nameOf(workspace,d.partyId),d.date,<Status key="s" value={d.status==='draft'?'draft':balance.lt(0)?'customer credit':balance.eq(0)?'paid':D(d.paid).gt(0)?'partially paid':'unpaid'}/>,formatMoney(d.total),<Button key="view" variant="outline" size="sm" aria-label={`View invoice ${d.number}`} onClick={()=>setSelectedInvoiceId(d.id)}>View</Button>]})}/><DocumentDetails workspace={workspace} actor={props.actor} documentId={selectedInvoiceId} editable={canEdit(role,'sales')} busy={props.busy} command={props.command} onClose={()=>setSelectedInvoiceId(null)}/></>}
function BranchesAndWarehouses({workspace,editable,busy,command}:{workspace:Workspace;editable:boolean;busy:string;command:CommandFn}){const [branchName,setBranchName]=useState('');const [renaming,setRenaming]=useState<{id:string;name:string}|null>(null);
  return <div className="stack"><section className="card"><div className="card-heading"><div><h2>Branches</h2><p>Branches group warehouses and limit what branch-scoped users can see.</p></div></div><div className="card-body">
    <ul className="branch-list">{workspace.branches.map(b=><li key={b.id}>{renaming?.id===b.id?<form className="branch-inline" onSubmit={async e=>{e.preventDefault();const r=await command('save_branch',{id:b.id,name:renaming.name});if(r.ok)setRenaming(null)}}><input aria-label={`Rename ${b.name}`} value={renaming.name} onChange={e=>setRenaming({id:b.id,name:e.target.value})} autoFocus/><Button size="sm" type="submit" disabled={!!busy}>Save</Button><Button size="sm" type="button" variant="ghost" onClick={()=>setRenaming(null)}>Cancel</Button></form>:<><strong>{b.name}</strong><small>{workspace.warehouses.filter(w=>w.branchId===b.id).length} warehouse(s)</small>{editable&&<Button size="sm" variant="ghost" aria-label={`Rename ${b.name}`} onClick={()=>setRenaming({id:b.id,name:b.name})}>Rename</Button>}</>}</li>)}</ul>
    {editable&&<form className="branch-inline" onSubmit={async e=>{e.preventDefault();const r=await command('save_branch',{name:branchName});if(r.ok)setBranchName('')}}><input aria-label="New branch name" placeholder="New branch name" value={branchName} onChange={e=>setBranchName(e.target.value)} required minLength={2}/><Button size="sm" type="submit" disabled={!!busy||branchName.trim().length<2}><Plus size={14}/>Add branch</Button></form>}
  </div></section><MasterDataView spec={entitySpecs.warehouses as never} workspace={workspace} editable={editable} busy={busy} command={command}/></div>}
function Metrics({values}:{values:[string,string][]}){const icons=[ShoppingBag,ArrowDownLeft,CreditCard,Package];return <div className="metric-grid">{values.map(([name,value],index)=>{const Icon=icons[index];return <section className="metric-card" key={name}><div className="metric-label">{name}<span className="metric-icon"><Icon size={18}/></span></div><strong>{value}</strong><small>From posted records</small></section>})}</div>}
function Status({value}:{value:string}){return <span className={`badge ${statusTone(value)}`}>{value.replaceAll('_',' ')}</span>}
function TableCard({title,action,heads,rows}:{title:string;action?:ReactNode;heads:string[];rows:ReactNode[][]}){return <section className="card"><div className="card-heading"><div><h2>{title}</h2><p>{rows.length} records</p></div>{action}</div><div className="table-scroll" tabIndex={0} role="region" aria-label={`${title} table`}><table><thead><tr>{heads.map(head=><th key={head}>{head}</th>)}</tr></thead><tbody>{rows.length?rows.map((row,index)=><tr key={index}>{row.map((cell,column)=><td key={column}>{cell}</td>)}</tr>):<tr><td colSpan={heads.length}><div className="empty-state">No records yet.</div></td></tr>}</tbody></table></div><p className="table-scroll-hint">Swipe sideways to see every column.</p></section>}

function TransactionDialog({modal,close,workspace,busy,command}:{modal:Modal;close:()=>void;workspace:Workspace;busy:string;command:(type:string,payload:Record<string,unknown>)=>Promise<unknown>}){const now=today();
  async function submit(event:FormEvent<HTMLFormElement>){event.preventDefault();const form=new FormData(event.currentTarget);const v=(key:string)=>String(form.get(key)||'');await command('follow_up',{partyId:v('partyId'),note:v('note'),nextDate:v('nextDate')});}
  return <Dialog open={modal==='followup'} onOpenChange={value=>{if(!value)close()}}><DialogContent><DialogTitle>Log recovery follow-up</DialogTitle><DialogDescription>Saved against the customer and shown in Collections.</DialogDescription><form className="field-grid" onSubmit={submit}>
    <label className="full-width">Customer<select name="partyId" required defaultValue=""><option value="" disabled>Select…</option>{workspace.parties.filter(p=>!p.archived&&p.type==='customer').map(p=><option value={p.id} key={p.id}>{p.name}</option>)}</select></label><label className="full-width">Note<textarea name="note" required maxLength={2000} rows={3}/></label><label>Logged<input name="date" type="date" defaultValue={now} required/></label><label>Next action date<input name="nextDate" type="date" defaultValue={addDays(now,7)} min={now} required/></label>
    <div className="form-actions full-width"><Button type="button" variant="outline" onClick={close}>Cancel</Button><Button type="submit" disabled={!!busy}>{busy?<Loader2 className="spin" size={16}/>:<Plus size={16}/>}Save follow-up</Button></div></form></DialogContent></Dialog>}
function nameOf(workspace:Workspace,id:string){return workspace.parties.find(p=>p.id===id)?.name||'—'}
