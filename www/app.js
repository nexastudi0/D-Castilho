const COMMISSION_RATE = 0.30;

const defaultData = {
  employees: [
    {id: 1, name: "Funcionário Exemplo", active: true}
  ],
  clients: [],
  combos: [],
  subscriptions: [],
  services: [],
  payments: []
};

let state = JSON.parse(JSON.stringify(defaultData));
let session = null;
let authSession = null;

// Supabase: banco central compartilhado entre celular e computador.
const SUPABASE_URL = "https://mftdqzzrelgkqslbcdri.supabase.co";
const SUPABASE_KEY = "sb_publishable_JvLrbf0KOqLGcsKuvhPe4Q_ONrB5Ukw";
let syncQueue = Promise.resolve();

function supabaseHeaders(useUserToken=true){
  return {
    "apikey": SUPABASE_KEY,
    "Authorization": `Bearer ${useUserToken && authSession?.access_token ? authSession.access_token : SUPABASE_KEY}`,
    "Content-Type": "application/json"
  };
}

function todayISO(){ const d=new Date(); return d.toISOString().slice(0,10); }
function endOfMonthISO(){ const d=new Date(); return new Date(d.getFullYear(),d.getMonth()+1,0).toISOString().slice(0,10); }
function money(v){ return Number(v||0).toLocaleString("pt-BR",{style:"currency",currency:"BRL"}); }
function uid(arr){ return arr.length?Math.max(...arr.map(x=>Number(x.id)))+1:1; }

const tableConfig = {
  employees: { table:"employees", toDb:x=>({id:x.id,name:x.name,active:x.active}), fromDb:x=>x },
  clients: { table:"clients", toDb:x=>({id:x.id,name:x.name,phone:x.phone||null,active:x.active}), fromDb:x=>x },
  combos: { table:"combos", toDb:x=>({id:x.id,name:x.name,price:x.price,type:x.type,limit:x.limit??null,unlimited_base:x.unlimitedBase||0,active:x.active}), fromDb:x=>({id:x.id,name:x.name,price:Number(x.price),type:x.type,limit:x.limit,unlimitedBase:Number(x.unlimited_base||0),active:x.active}) },
  subscriptions: { table:"subscriptions", toDb:x=>({id:x.id,client_id:x.clientId,combo_id:x.comboId,start_date:x.startDate,end_date:x.endDate,used:x.used,active:x.active}), fromDb:x=>({id:x.id,clientId:x.client_id,comboId:x.combo_id,startDate:x.start_date,endDate:x.end_date,used:x.used,active:x.active}) },
  services: { table:"services", toDb:x=>({id:x.id,subscription_id:x.subscriptionId,client_id:x.clientId,combo_id:x.comboId,employee_id:x.employeeId,date:x.date,commission:x.commission,cancelled:x.cancelled}), fromDb:x=>({id:x.id,subscriptionId:x.subscription_id,clientId:x.client_id,comboId:x.combo_id,employeeId:x.employee_id,date:x.date,commission:Number(x.commission),cancelled:x.cancelled}) },
  payments: { table:"payments", toDb:x=>({id:x.id,employee_id:x.employeeId,amount:x.amount,date:x.date}), fromDb:x=>({id:x.id,employeeId:x.employee_id,amount:Number(x.amount),date:x.date}) }
};

async function api(path, options={}, allowAnonFallback=true){
  const request = async(useUserToken)=>fetch(`${SUPABASE_URL}/rest/v1/${path}`,{
    ...options,
    headers:{...supabaseHeaders(useUserToken),...(options.headers||{})}
  });
  let response=await request(true);
  // Durante a migração, mantém compatibilidade até as policies finais serem aplicadas.
  if(allowAnonFallback && authSession?.access_token && (response.status===401 || response.status===403)) response=await request(false);
  if(!response.ok){ throw new Error(`${response.status}: ${await response.text()}`); }
  if(response.status===204)return null;
  const text=await response.text(); return text?JSON.parse(text):null;
}

async function authRequest(path, options={}){
  const response=await fetch(`${SUPABASE_URL}/auth/v1/${path}`,{
    ...options,
    headers:{"apikey":SUPABASE_KEY,"Content-Type":"application/json",...(authSession?.access_token?{"Authorization":`Bearer ${authSession.access_token}`}:{}) ,...(options.headers||{})}
  });
  const text=await response.text();
  const data=text?JSON.parse(text):null;
  if(!response.ok) throw new Error(data?.msg||data?.message||data?.error_description||"Falha na autenticação.");
  return data;
}

async function signInWithEmail(email,password){
  const data=await authRequest('token?grant_type=password',{method:'POST',body:JSON.stringify({email,password})});
  authSession=data;
  localStorage.setItem('dc_castilho_auth_session',JSON.stringify(authSession));
  return data;
}

async function refreshAuthSession(){
  const saved=localStorage.getItem('dc_castilho_auth_session');
  if(!saved)return false;
  try{
    const old=JSON.parse(saved);
    if(!old?.refresh_token)return false;
    const data=await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`,{
      method:'POST',headers:{"apikey":SUPABASE_KEY,"Content-Type":"application/json"},body:JSON.stringify({refresh_token:old.refresh_token})
    });
    if(!data.ok)throw new Error('Sessão expirada');
    authSession=await data.json();
    localStorage.setItem('dc_castilho_auth_session',JSON.stringify(authSession));
    return true;
  }catch(err){
    localStorage.removeItem('dc_castilho_auth_session'); authSession=null; return false;
  }
}

async function loadProfile(){
  if(!authSession?.user?.id)throw new Error('Usuário não autenticado.');
  const rows=await api(`profiles?id=eq.${encodeURIComponent(authSession.user.id)}&select=id,name,role,active`,{},false);
  const profile=rows?.[0];
  if(!profile || !profile.active)throw new Error('Este acesso não está autorizado.');
  session={id:profile.id,name:profile.name,role:profile.role,active:profile.active,email:authSession.user.email};
  return session;
}

async function loadData(){
  const fresh={employees:[],clients:[],combos:[],subscriptions:[],services:[],payments:[]};
  for(const [key,cfg] of Object.entries(tableConfig)){
    const rows=await api(`${cfg.table}?select=*&order=id.asc`);
    fresh[key]=(rows||[]).map(cfg.fromDb);
  }
  state=fresh;
  localStorage.setItem("dc_castilho_data_v12_cache",JSON.stringify(state));
  return state;
}

async function syncTable(key){
  const cfg=tableConfig[key], items=state[key]||[];
  if(items.length){
    await api(`${cfg.table}?on_conflict=id`,{method:"POST",headers:{"Prefer":"resolution=merge-duplicates,return=minimal"},body:JSON.stringify(items.map(cfg.toDb))});
    const ids=items.map(x=>Number(x.id)).join(',');
    await api(`${cfg.table}?id=not.in.(${ids})`,{method:"DELETE",headers:{"Prefer":"return=minimal"}});
  }else{
    await api(`${cfg.table}?id=gt.0`,{method:"DELETE",headers:{"Prefer":"return=minimal"}});
  }
}

async function syncAll(){
  for(const key of ["employees","clients","combos","subscriptions","services","payments"]) await syncTable(key);
  localStorage.setItem("dc_castilho_data_v12_cache",JSON.stringify(state));
}

function saveData(){
  syncQueue=syncQueue.then(syncAll).catch(err=>{ console.error("Erro Supabase:",err); toast("Erro ao sincronizar com o servidor."); });
  return syncQueue;
}

async function initializeOnlineData(){
  const submit=document.querySelector('#loginForm button[type="submit"]');
  if(submit){submit.disabled=true;submit.textContent="Conectando...";}
  try{
    const restored=await refreshAuthSession();
    if(restored){ await loadProfile(); await loadData(); openApp(); }
  }catch(err){ console.error(err); session=null; authSession=null; localStorage.removeItem('dc_castilho_auth_session'); }
  finally{ if(submit){submit.disabled=false;submit.textContent="Entrar";} }
}
function toast(msg){ const el=document.getElementById("toast"); el.textContent=msg; el.classList.add("show"); setTimeout(()=>el.classList.remove("show"),2200); }
function fmtDate(v){ if(!v)return "-"; return new Date(v+"T12:00:00").toLocaleDateString("pt-BR"); }
function fmtDateTime(v){ return new Date(v).toLocaleString("pt-BR"); }
function clientName(id){ return state.clients.find(x=>x.id===id)?.name||"Cliente"; }
function comboById(id){ return state.combos.find(x=>x.id===id); }
function employeeName(id){ return state.employees.find(x=>x.id===id)?.name||"Funcionário"; }
function subscriptionById(id){ return state.subscriptions.find(x=>x.id===id); }
function currentSubscription(clientId){ return state.subscriptions.filter(s=>s.clientId===clientId&&s.active).sort((a,b)=>b.id-a.id)[0]; }
function activeSubscriptions(){ return state.subscriptions.filter(s=>s.active&&s.endDate>=todayISO()); }
function calcCommission(combo){ return 50 * COMMISSION_RATE; }
function serviceCanBeRegistered(sub){ const combo=comboById(sub.comboId); if(!combo||!sub.active||sub.endDate<todayISO())return false; return combo.type==="unlimited"?true:sub.used<combo.limit; }
function pruneOldHistory(){ const limit=new Date(Date.now()-(30*24*60*60*1000)); const before=state.services.length; state.services=state.services.filter(s=>new Date(s.date)>=limit); if(before!==state.services.length)saveData(); }
function isDeveloper(){ return session?.role==="developer"; }

document.getElementById("loginForm").addEventListener("submit",async e=>{
  e.preventDefault();
  const email=document.getElementById("loginUser").value.trim().toLowerCase();
  const password=document.getElementById("loginPass").value;
  const btn=e.currentTarget.querySelector('button[type="submit"]');
  try{
    btn.disabled=true; btn.textContent="Entrando...";
    await signInWithEmail(email,password);
    await loadProfile();
    await loadData();
    openApp();
  }catch(err){
    console.error(err); session=null; authSession=null; localStorage.removeItem('dc_castilho_auth_session');
    toast(err.message.includes('Invalid login')?"E-mail ou senha inválidos.":err.message);
  }finally{btn.disabled=false;btn.textContent="Entrar";}
});
document.getElementById("logoutBtn").onclick=async()=>{
  try{ if(authSession?.access_token) await authRequest('logout',{method:'POST'}); }catch(e){}
  session=null; authSession=null; localStorage.removeItem('dc_castilho_auth_session');
  document.getElementById("appView").classList.add("hidden"); document.getElementById("loginView").classList.remove("hidden");
};

function openApp(){
  pruneOldHistory(); document.getElementById("loginView").classList.add("hidden"); document.getElementById("appView").classList.remove("hidden");
  document.getElementById("currentUserName").textContent=session.name;
  document.getElementById("currentUserRole").textContent=session.role==="developer"?"Desenvolvedor":"Administrador";
  document.getElementById("roleLabel").textContent=session.role==="developer"?"Acesso do desenvolvedor":"Administração";
  document.getElementById("navAdmin").classList.toggle("hidden",session.role!=="admin");
  document.getElementById("navDeveloper").classList.toggle("hidden",session.role!=="developer");
  bindNav(); showPage("dashboard");
}
function bindNav(){ document.querySelectorAll(".nav-btn").forEach(btn=>btn.onclick=()=>showPage(btn.dataset.page)); }
const titles={dashboard:"Dashboard",clients:"Clientes",combos:"Combos",barbers:"Funcionários",attendance:"Lançar Corte",sales:"Lançar Combo",commissions:"Comissões",history:"Históricos",access:"Acessos"};
function showPage(page){
  if(page==="access"&&!isDeveloper())return showPage("dashboard");
  document.querySelectorAll(".page").forEach(p=>p.classList.add("hidden")); const target=document.getElementById("page-"+page); if(!target)return;
  target.classList.remove("hidden"); document.getElementById("pageTitle").textContent=titles[page]||page;
  document.querySelectorAll(".nav-btn").forEach(b=>b.classList.toggle("active",b.dataset.page===page));
  const fn={dashboard:renderDashboard,clients:renderClients,combos:renderCombos,barbers:renderEmployees,attendance:renderAttendance,sales:renderSales,commissions:renderCommissions,history:renderHistory,access:renderAccess}[page];
  if(fn)fn();
}

function renderDashboard(){
  pruneOldHistory(); const month=todayISO().slice(0,7); const services=state.services.filter(s=>s.date.slice(0,7)===month&&!s.cancelled);
  const commissions=services.reduce((a,s)=>a+s.commission,0); const activeSubs=activeSubscriptions(); const salesValue=activeSubs.reduce((a,s)=>a+(comboById(s.comboId)?.price||0),0);
  const el=document.getElementById("page-dashboard"); el.innerHTML=`
    <div class="grid stats">
      <div class="card stat"><small>Combos ativos</small><strong>${activeSubs.length}</strong><em>clientes com plano ativo</em></div>
      <div class="card stat"><small>Cortes no mês</small><strong>${services.length}</strong><em>lançados pelo administrador</em></div>
      <div class="card stat"><small>Comissões geradas</small><strong>${money(commissions)}</strong><em>30% sobre R$ 50 por corte</em></div>
      <div class="card stat"><small>Valor dos combos ativos</small><strong>${money(salesValue)}</strong><em>visão administrativa</em></div>
    </div>
    <div class="grid two" style="margin-top:16px">
      <div class="card"><div class="section-title"><h3>Clientes com combo ativo</h3></div>${activeSubs.length?activeSubs.map(s=>subCard(s)).join(""):`<div class="empty">Nenhum combo ativo.</div>`}</div>
      <div class="card"><div class="section-title"><h3>Últimos cortes</h3></div>${serviceList(state.services.filter(s=>!s.cancelled).slice(-6).reverse())}</div>
    </div>`;
}
function subCard(sub){ const combo=comboById(sub.comboId); const pct=combo?.type==="fixed"?Math.min(100,(sub.used/combo.limit)*100):Math.min(100,sub.used*10); const usage=combo?.type==="fixed"?`${sub.used} de ${combo.limit}`:`${sub.used} atendimentos`; return `<div class="card" style="margin-bottom:10px;background:#121215"><div class="client-card"><div><h4>${clientName(sub.clientId)}</h4><p>${combo?.name||"-"} • válido até ${fmtDate(sub.endDate)}</p></div><span class="badge ${serviceCanBeRegistered(sub)?"ok":"off"}">${serviceCanBeRegistered(sub)?"Ativo":"Indisponível"}</span></div><div class="progress"><span style="width:${pct}%"></span></div><p class="muted" style="margin-bottom:0">Uso: <b>${usage}</b> • Comissão por corte: <b>${money(calcCommission(combo||{}))}</b></p></div>`; }
function serviceList(arr){ if(!arr.length)return `<div class="empty">Nenhum atendimento registrado.</div>`; return `<div class="table-wrap"><table><thead><tr><th>Data</th><th>Cliente</th><th>Funcionário</th><th>Comissão</th></tr></thead><tbody>${arr.map(s=>`<tr><td>${fmtDateTime(s.date)}</td><td>${clientName(s.clientId)}</td><td>${employeeName(s.employeeId)}</td><td>${money(s.commission)}</td></tr>`).join("")}</tbody></table></div>`; }

function renderClients(){
  const el=document.getElementById("page-clients"); const activeCombos=state.combos.filter(c=>c.active);
  const rows=state.clients.map(c=>{ const sub=currentSubscription(c.id); const combo=sub?comboById(sub.comboId):null; let usage="-",remaining="-"; if(sub&&combo){ if(combo.type==="fixed"){usage=`${sub.used} de ${combo.limit}`;remaining=Math.max(0,combo.limit-sub.used);}else{usage=`${sub.used} atendimentos`;remaining="Ilimitado";} } return `<tr><td>${c.name}</td><td>${c.phone||"-"}</td><td>${combo?.name||"Sem combo"}</td><td>${usage}</td><td>${remaining}</td><td><span class="badge ${c.active?"ok":"off"}">${c.active?"Ativo":"Inativo"}</span></td><td><div class="actions"><button class="btn secondary" onclick="editClientCombo(${c.id})">Alterar combo</button><button class="btn secondary" onclick="toggleClient(${c.id})">${c.active?"Desativar":"Ativar"}</button></div></td></tr>`; }).join("");
  el.innerHTML=`<div class="card"><div class="section-title"><h3>Cadastrar cliente</h3></div><form id="clientForm" class="form-grid"><label>Nome<input id="clientName" required></label><label>Telefone<input id="clientPhone"></label><label>Combo<select id="clientCombo" required><option value="">Selecione</option>${activeCombos.map(c=>`<option value="${c.id}">${c.name} — ${money(c.price)}</option>`).join("")}</select></label><label>Início<input id="clientComboStart" type="date" value="${todayISO()}" required></label><label>Vencimento<input id="clientComboEnd" type="date" value="${endOfMonthISO()}" required></label><div class="full"><button class="btn primary">Cadastrar cliente</button></div></form></div><div class="card" style="margin-top:16px"><div class="section-title"><h3>Clientes</h3><span class="badge">${state.clients.length}</span></div><div class="table-wrap"><table><thead><tr><th>Nome</th><th>Telefone</th><th>Combo</th><th>Usados</th><th>Restantes</th><th>Status</th><th>Ação</th></tr></thead><tbody>${rows}</tbody></table></div></div>`;
  document.getElementById("clientForm").onsubmit=e=>{ e.preventDefault(); const comboId=+document.getElementById("clientCombo").value; const combo=state.combos.find(c=>c.id===comboId&&c.active); if(!combo)return toast("Selecione um combo."); const client={id:uid(state.clients),name:document.getElementById("clientName").value.trim(),phone:document.getElementById("clientPhone").value.trim(),active:true}; state.clients.push(client); state.subscriptions.push({id:uid(state.subscriptions),clientId:client.id,comboId,startDate:document.getElementById("clientComboStart").value,endDate:document.getElementById("clientComboEnd").value,used:0,active:true}); saveData();toast("Cliente cadastrado.");renderClients(); };
}
window.toggleClient=id=>{const c=state.clients.find(x=>x.id===id);if(c){c.active=!c.active;saveData();renderClients();}};
window.editClientCombo=id=>{ const client=state.clients.find(c=>c.id===id);if(!client)return; const combos=state.combos.filter(c=>c.active);if(!combos.length)return toast("Nenhum combo ativo."); const opts=combos.map(c=>`${c.id} - ${c.name}`).join("\n"); const chosen=prompt(`Novo combo para ${client.name}:\n${opts}`,""); if(chosen===null)return; const combo=combos.find(c=>c.id===+chosen);if(!combo)return toast("Combo inválido."); state.subscriptions.filter(s=>s.clientId===id&&s.active).forEach(s=>s.active=false); state.subscriptions.push({id:uid(state.subscriptions),clientId:id,comboId:combo.id,startDate:todayISO(),endDate:endOfMonthISO(),used:0,active:true}); saveData();toast("Combo alterado.");renderClients(); };

function renderCombos(){
  const el=document.getElementById("page-combos"); el.innerHTML=`<div class="card"><div class="section-title"><h3>Criar combo da barbearia</h3></div><form id="comboForm" class="form-grid"><label>Nome<input id="comboName" required></label><label>Valor<input id="comboPrice" type="number" step="0.01" min="0" required></label><label>Tipo<select id="comboType"><option value="fixed">Quantidade fixa</option><option value="unlimited">Ilimitado</option></select></label><label id="limitWrap">Quantidade de cortes<input id="comboLimit" type="number" min="1" value="4"></label><label id="baseWrap" class="hidden">Valor-base por corte<input id="comboBase" type="number" step="0.01" min="0" value="50"></label><div class="full"><button class="btn primary">Criar combo</button></div></form></div><div class="card" style="margin-top:16px"><div class="section-title"><h3>Combos cadastrados</h3></div><div class="table-wrap"><table><thead><tr><th>Combo</th><th>Valor</th><th>Regra</th><th>Comissão/corte</th><th>Status</th><th>Ação</th></tr></thead><tbody>${state.combos.map(c=>`<tr><td>${c.name}</td><td>${money(c.price)}</td><td>${c.type==="fixed"?c.limit+" cortes":"Ilimitado"}</td><td>${money(calcCommission(c))}</td><td><span class="badge ${c.active?"ok":"off"}">${c.active?"Ativo":"Inativo"}</span></td><td><button class="btn danger" onclick="deleteCombo(${c.id})">Excluir</button></td></tr>`).join("")}</tbody></table></div></div>`;
  const type=document.getElementById("comboType"); type.onchange=()=>{document.getElementById("limitWrap").classList.toggle("hidden",type.value!=="fixed");document.getElementById("baseWrap").classList.toggle("hidden",type.value!=="unlimited");};
  document.getElementById("comboForm").onsubmit=e=>{ e.preventDefault();const t=type.value; state.combos.push({id:uid(state.combos),name:document.getElementById("comboName").value.trim(),price:+document.getElementById("comboPrice").value,type:t,limit:t==="fixed"?+document.getElementById("comboLimit").value:null,unlimitedBase:t==="unlimited"?+document.getElementById("comboBase").value:0,active:true}); saveData();toast("Combo criado.");renderCombos(); };
}
window.deleteCombo=id=>{ const combo=state.combos.find(c=>c.id===id);if(!combo)return; if(state.services.some(s=>s.comboId===id)||state.subscriptions.some(s=>s.comboId===id&&s.used>0)){combo.active=false;saveData();toast("Combo desativado para preservar o histórico.");renderCombos();return;} if(!confirm(`Excluir o combo "${combo.name}"?`))return; state.subscriptions=state.subscriptions.filter(s=>s.comboId!==id); state.combos=state.combos.filter(c=>c.id!==id); saveData();toast("Combo excluído.");renderCombos(); };

function renderEmployees(){
  const el=document.getElementById("page-barbers"); el.innerHTML=`<div class="card"><div class="section-title"><h3>Cadastrar funcionário</h3></div><form id="employeeForm" class="inline-form"><label>Nome<input id="employeeNameInput" required></label><button class="btn primary">Cadastrar</button></form></div><div class="card" style="margin-top:16px"><div class="section-title"><h3>Funcionários</h3></div><div class="table-wrap"><table><thead><tr><th>Nome</th><th>Atendimentos</th><th>Comissão</th><th>Status</th><th>Ação</th></tr></thead><tbody>${state.employees.map(emp=>{ const sv=state.services.filter(s=>s.employeeId===emp.id&&!s.cancelled); return `<tr><td>${emp.name}</td><td>${sv.length}</td><td>${money(sv.reduce((a,s)=>a+s.commission,0))}</td><td><span class="badge ${emp.active?"ok":"off"}">${emp.active?"Ativo":"Inativo"}</span></td><td><div class="actions"><button class="btn secondary" onclick="editEmployee(${emp.id})">Editar</button><button class="btn secondary" onclick="toggleEmployee(${emp.id})">${emp.active?"Desativar":"Ativar"}</button></div></td></tr>`; }).join("")}</tbody></table></div></div>`;
  document.getElementById("employeeForm").onsubmit=e=>{e.preventDefault();state.employees.push({id:uid(state.employees),name:document.getElementById("employeeNameInput").value.trim(),active:true});saveData();toast("Funcionário cadastrado.");renderEmployees();};
}
window.editEmployee=id=>{const e=state.employees.find(x=>x.id===id);if(!e)return;const n=prompt("Nome do funcionário:",e.name);if(n===null||!n.trim())return;e.name=n.trim();saveData();renderEmployees();};
window.toggleEmployee=id=>{const e=state.employees.find(x=>x.id===id);if(e){e.active=!e.active;saveData();renderEmployees();}};

function renderAttendance(){
  const el=document.getElementById("page-attendance"); const clients=state.clients.filter(c=>c.active&&currentSubscription(c.id)&&serviceCanBeRegistered(currentSubscription(c.id))); const employees=state.employees.filter(e=>e.active);
  el.innerHTML=`<div class="card"><div class="section-title"><h3>Lançar corte realizado</h3></div><form id="attendanceForm" class="form-grid"><label>Cliente<select id="attendanceClient" required><option value="">Selecione</option>${clients.map(c=>`<option value="${c.id}">${c.name}</option>`).join("")}</select></label><label>Funcionário que realizou o corte<select id="attendanceEmployee" required><option value="">Selecione</option>${employees.map(e=>`<option value="${e.id}">${e.name}</option>`).join("")}</select></label><div class="full"><button class="btn primary">Registrar corte</button></div></form></div><div class="card" style="margin-top:16px"><div class="section-title"><h3>Últimos lançamentos</h3></div>${serviceList(state.services.filter(s=>!s.cancelled).slice(-10).reverse())}</div>`;
  document.getElementById("attendanceForm").onsubmit=e=>{ e.preventDefault(); const clientId=+document.getElementById("attendanceClient").value; const employeeId=+document.getElementById("attendanceEmployee").value; const sub=currentSubscription(clientId); if(!sub||!serviceCanBeRegistered(sub))return toast("Combo indisponível."); const combo=comboById(sub.comboId); if(combo.type==="unlimited"){ const today=todayISO(); const existing=state.services.find(s=>!s.cancelled&&s.clientId===clientId&&s.comboId===combo.id&&new Date(s.date).toISOString().slice(0,10)===today); if(existing)return toast(`Este combo ilimitado já foi lançado hoje para ${employeeName(existing.employeeId)}.`); } const commission=calcCommission(combo); state.services.push({id:uid(state.services),subscriptionId:sub.id,clientId,comboId:combo.id,employeeId,date:new Date().toISOString(),commission,cancelled:false}); sub.used+=1;saveData();toast(`Corte registrado. Comissão: ${money(commission)}`);renderAttendance(); };
}

function renderSales(){
  const el=document.getElementById("page-sales"); const clients=state.clients.filter(c=>c.active); const combos=state.combos.filter(c=>c.active);
  el.innerHTML=`<div class="card"><div class="section-title"><h3>Lançar combo para cliente existente</h3></div><form id="saleForm" class="form-grid"><label>Cliente<select id="saleClient" required><option value="">Selecione</option>${clients.map(c=>`<option value="${c.id}">${c.name}</option>`).join("")}</select></label><label>Combo<select id="saleCombo" required><option value="">Selecione</option>${combos.map(c=>`<option value="${c.id}">${c.name} — ${money(c.price)}</option>`).join("")}</select></label><label>Início<input id="saleStart" type="date" value="${todayISO()}" required></label><label>Vencimento<input id="saleEnd" type="date" value="${endOfMonthISO()}" required></label><div class="full"><button class="btn primary">Lançar combo</button></div></form></div>`;
  document.getElementById("saleForm").onsubmit=e=>{e.preventDefault();const clientId=+document.getElementById("saleClient").value;const comboId=+document.getElementById("saleCombo").value;if(!clientId||!comboId)return toast("Selecione cliente e combo.");state.subscriptions.filter(s=>s.clientId===clientId&&s.active).forEach(s=>s.active=false);state.subscriptions.push({id:uid(state.subscriptions),clientId,comboId,startDate:document.getElementById("saleStart").value,endDate:document.getElementById("saleEnd").value,used:0,active:true});saveData();toast("Combo lançado.");renderSales();};
}

function renderCommissions(){
  pruneOldHistory(); const el=document.getElementById("page-commissions"); el.innerHTML=`<div class="card"><div class="section-title"><h3>Comissões por funcionário</h3></div><div class="table-wrap"><table><thead><tr><th>Funcionário</th><th>Atendimentos</th><th>Gerado</th><th>Pago</th><th>Pendente</th><th>Ação</th></tr></thead><tbody>${state.employees.map(emp=>{const sv=state.services.filter(s=>s.employeeId===emp.id&&!s.cancelled);const total=sv.reduce((a,s)=>a+s.commission,0);const paid=state.payments.filter(p=>p.employeeId===emp.id).reduce((a,p)=>a+p.amount,0);const pending=Math.max(0,total-paid);return `<tr><td>${emp.name}</td><td>${sv.length}</td><td>${money(total)}</td><td>${money(paid)}</td><td><b>${money(pending)}</b></td><td><button class="btn success" onclick="payEmployee(${emp.id})" ${pending<=0?"disabled":""}>Marcar pago</button></td></tr>`;}).join("")}</tbody></table></div></div>`;
}
window.payEmployee=id=>{const total=state.services.filter(s=>s.employeeId===id&&!s.cancelled).reduce((a,s)=>a+s.commission,0);const paid=state.payments.filter(p=>p.employeeId===id).reduce((a,p)=>a+p.amount,0);const pending=Math.max(0,total-paid);if(!pending)return toast("Nada pendente.");state.payments.push({id:uid(state.payments),employeeId:id,amount:pending,date:new Date().toISOString()});saveData();toast("Comissão marcada como paga.");renderCommissions();};

function renderHistory(){
  pruneOldHistory(); const el=document.getElementById("page-history"); const selected=el.dataset.employee||"all"; let arr=selected==="all"?state.services.slice():state.services.filter(s=>String(s.employeeId)===String(selected)); arr.reverse();
  el.innerHTML=`<div class="card"><div class="section-title"><h3>Históricos</h3><span class="badge">${arr.filter(s=>!s.cancelled).length} válidos</span></div><div class="actions" style="margin-bottom:18px"><button class="btn ${selected==="all"?"primary":"secondary"}" onclick="setHistoryEmployee('all')">Todas</button>${state.employees.map(emp=>`<button class="btn ${String(selected)===String(emp.id)?"primary":"secondary"}" onclick="setHistoryEmployee('${emp.id}')">${emp.name}</button>`).join("")}</div>${arr.length?`<div class="table-wrap"><table><thead><tr><th>Data</th><th>Cliente</th><th>Combo</th><th>Funcionário</th><th>Comissão</th><th>Status</th><th>Ação</th></tr></thead><tbody>${arr.map(s=>`<tr><td>${fmtDateTime(s.date)}</td><td>${clientName(s.clientId)}</td><td>${comboById(s.comboId)?.name||"-"}</td><td>${employeeName(s.employeeId)}</td><td>${money(s.commission)}</td><td><span class="badge ${s.cancelled?"off":"ok"}">${s.cancelled?"Cancelado":"Válido"}</span></td><td>${s.cancelled?"-":`<button class="btn danger" onclick="cancelService(${s.id})">Cancelar</button>`}</td></tr>`).join("")}</tbody></table></div>`:`<div class="empty">Nenhum atendimento.</div>`}</div>`;
}
window.setHistoryEmployee=id=>{const el=document.getElementById("page-history");el.dataset.employee=id;renderHistory();};
window.cancelService=id=>{const s=state.services.find(x=>x.id===id);if(!s||s.cancelled)return;s.cancelled=true;const sub=subscriptionById(s.subscriptionId);if(sub)sub.used=Math.max(0,sub.used-1);saveData();toast("Atendimento cancelado.");renderHistory();};

function renderAccess(){
  if(!isDeveloper())return;
  const el=document.getElementById("page-access");
  el.innerHTML=`
    <div class="grid two">
      <div class="card">
        <div class="section-title"><h3>Meu acesso de desenvolvedor</h3></div>
        <form id="devAccessForm" class="form-grid">
          <label>Nome<input id="devName" value="${session?.name||""}" required></label>
          <label>E-mail<input value="${session?.email||""}" disabled></label>
          <label>Nova senha<input id="devPass" type="password" minlength="6" placeholder="Deixe em branco para manter"></label>
          <div class="full"><button class="btn primary">Salvar meu acesso</button></div>
        </form>
      </div>
      <div class="card">
        <div class="section-title"><h3>Acesso do administrador</h3></div>
        <p><b>Conta:</b> halison@gmail.com</p>
        <p class="muted">O administrador usa Supabase Auth. Por segurança, a senha de outra conta não fica disponível no código do site. Alterações de e-mail/senha do administrador devem ser feitas no painel Authentication → Users do Supabase.</p>
      </div>
    </div>`;
  document.getElementById("devAccessForm").onsubmit=async e=>{
    e.preventDefault();
    const name=document.getElementById("devName").value.trim();
    const password=document.getElementById("devPass").value;
    try{
      await api(`profiles?id=eq.${encodeURIComponent(session.id)}`,{method:'PATCH',headers:{'Prefer':'return=minimal'},body:JSON.stringify({name})},false);
      if(password){
        await authRequest('user',{method:'PUT',body:JSON.stringify({password})});
      }
      session.name=name;
      document.getElementById("currentUserName").textContent=name;
      toast(password?"Nome e senha atualizados.":"Nome atualizado.");
      renderAccess();
    }catch(err){ console.error(err); toast("Não foi possível atualizar o acesso."); }
  };
}

initializeOnlineData();

if("serviceWorker" in navigator){window.addEventListener("load",()=>navigator.serviceWorker.register("service-worker.js").catch(()=>{}));}
