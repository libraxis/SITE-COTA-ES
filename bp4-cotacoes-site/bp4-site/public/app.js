
let cotacoes = [];
let currentView = "dashboard";
let authenticated = false;

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

function toast(msg, error=false){
  const el = $("#toast");
  el.textContent = msg;
  el.style.background = error ? "#8b1e1e" : "#18212f";
  el.classList.add("show");
  clearTimeout(window.__toast);
  window.__toast = setTimeout(()=>el.classList.remove("show"), 3200);
}

async function api(url, options={}){
  const r = await fetch(url, {credentials:"same-origin", ...options, headers:{
    "Content-Type":"application/json",
    ...(options.headers||{})
  }});
  let data = null;
  try { data = await r.json(); } catch(_) {}
  if(!r.ok){
    const msg = data?.error || data?.message || `Erro HTTP ${r.status}`;
    throw new Error(msg);
  }
  return data;
}

function showView(view){
  if(!authenticated) return;
  currentView = view;
  $$(".view").forEach(v=>v.classList.add("hidden"));
  $(`#${view}View`).classList.remove("hidden");
  $$(".nav").forEach(n=>n.classList.toggle("active", n.dataset.view===view));
  const titles={dashboard:"Visão geral",cotacoes:"Cotações",criar:"Criar cotação",catalogos:"Catálogos"};
  $("#pageTitle").textContent=titles[view]||"BP4";
}

function normalizeArray(data){
  if(Array.isArray(data)) return data;
  if(!data || typeof data!=="object") return [];
  for(const key of ["data","dados","result","resultado","cotacoes","itens","lotes","precos","items"]){
    if(Array.isArray(data[key])) return data[key];
  }
  const arrays=Object.values(data).filter(Array.isArray);
  return arrays[0] || [];
}

function fmtDate(v){
  if(!v) return "—";
  const d=new Date(v);
  return isNaN(d) ? String(v) : d.toLocaleString("pt-BR");
}
function esc(v){
  return String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[c]));
}

async function status(){
  try{
    const s=await api("/api/auth/status");
    authenticated = !!s.authenticated;
    document.body.classList.toggle("locked", !authenticated);
    if(authenticated){
      $("#authBadge").className="auth-badge online";
      $("#authBadge").textContent="Conectado";
      $("#loginView").classList.add("hidden");
      showView(currentView || "dashboard");
      loadDashboard();
    } else {
      currentView = "dashboard";
      $("#authBadge").className="auth-badge offline";
      $("#authBadge").textContent="Desconectado";
      $("#pageTitle").textContent="Acesso restrito";
      $("#loginView").classList.remove("hidden");
      $$(".view:not(#loginView)").forEach(v=>v.classList.add("hidden"));
    }
  }catch(e){
    authenticated = false;
    document.body.classList.add("locked");
    $("#authBadge").className="auth-badge offline";
    $("#authBadge").textContent="Desconectado";
    $("#loginView").classList.remove("hidden");
    $$(".view:not(#loginView)").forEach(v=>v.classList.add("hidden"));
    toast(e.message || "Sessão não autenticada.",true);
  }
}

async function login(event){
  if(event) event.preventDefault();
  const input=$("#apiToken");
  const token=String(input?.value || "").trim();
  if(!token){
    toast("Informe o token de acesso.",true);
    input?.focus();
    return;
  }
  const button=$("#loginBtn");
  button.disabled=true;
  try{
    await api("/api/auth/login",{
      method:"POST",
      body:JSON.stringify({usuarioApiToken:token})
    });
    input.value="";
    toast("Conectado à BP4.");
    authenticated = true;
    document.body.classList.remove("locked");
    await status();
  }catch(e){ toast(e.message || "Não foi possível autenticar.",true); }
  finally{button.disabled=false;}
}

async function logout(){
  await api("/api/auth/logout",{method:"POST"}).catch(()=>{});
  authenticated = false;
  document.body.classList.add("locked");
  toast("Sessão encerrada.");
  await status();
}

async function loadDashboard(){
  try{
    const data=await api("/api/cotacoes");
    cotacoes=normalizeArray(data);
    $("#statCotacoes").textContent=cotacoes.length;
    $("#statAtualizacao").textContent=new Date().toLocaleTimeString("pt-BR");
    $("#statItens").textContent=cotacoes.reduce((a,c)=>a+Number(c.quantidadeItens||0),0);
  }catch(e){ toast(e.message,true); }
}

async function loadCotacoes(){
  const body=$("#cotacoesTable tbody");
  body.innerHTML='<tr><td colspan="6" class="empty">Carregando...</td></tr>';
  try{
    const data=await api("/api/cotacoes");
    cotacoes=normalizeArray(data);
    renderCotacoes();
    $("#statCotacoes").textContent=cotacoes.length;
  }catch(e){body.innerHTML=`<tr><td colspan="6" class="empty">${esc(e.message)}</td></tr>`;toast(e.message,true);}
}

function renderCotacoes(){
  const q=$("#cotacaoSearch").value.toLowerCase();
  const rows=cotacoes.filter(c=>JSON.stringify(c).toLowerCase().includes(q));
  $("#cotacoesTable tbody").innerHTML=rows.length?rows.map(c=>{
    const id=c.idCotacao ?? c.IdCotacao ?? c.id ?? "";
    return `<tr>
      <td><b>${esc(id)}</b></td>
      <td>${esc(c.descricao)}</td>
      <td>${esc(c.finalidade)}</td>
      <td>${esc(c.quantidadeItens)}</td>
      <td>${c.cotacaoFinalizada?'<span class="badge">Finalizada</span>':'<span class="badge">Aberta</span>'}</td>
      <td><button class="link-btn" onclick="openCotacao(${Number(id)})">Abrir</button></td>
    </tr>`;
  }).join(""):'<tr><td colspan="6" class="empty">Nenhuma cotação encontrada.</td></tr>';
}

async function openCotacao(id){
  const box=$("#cotacaoDetail");
  box.classList.remove("hidden");
  box.innerHTML='<div class="notice">Carregando cotação completa...</div>';
  try{
    const data=await api(`/api/cotacoes/completa?IdCotacao=${encodeURIComponent(id)}`);
    const cot=data?.cotacao || data?.Cotacao || data;
    const itens=normalizeArray(data?.itens || data?.Itens || []);
    box.innerHTML=`
      <div class="card-head"><h3 class="result-title">Cotação #${esc(id)}</h3><button class="ghost" onclick="$('#cotacaoDetail').classList.add('hidden')">Fechar</button></div>
      <div class="detail-grid">
        <div class="pill"><small>Descrição</small><strong>${esc(cot?.descricao)}</strong></div>
        <div class="pill"><small>Finalidade</small><strong>${esc(cot?.finalidade)}</strong></div>
        <div class="pill"><small>Quantidade de itens</small><strong>${esc(cot?.quantidadeItens)}</strong></div>
        <div class="pill"><small>Data prevista</small><strong>${esc(fmtDate(cot?.dataPrevistaDivulgacaoEdital))}</strong></div>
      </div>
      <h4>Itens (${itens.length})</h4>
      <div class="table-wrap"><table><thead><tr><th>ID</th><th>Nome</th><th>Descrição</th><th>Qtd.</th><th>Unidade</th><th>Preços</th><th></th></tr></thead>
      <tbody>${itens.length?itens.map(i=>`<tr>
        <td>${esc(i.idCotacaoItem)}</td><td>${esc(i.nomeItem)}</td><td>${esc(i.descricao)}</td>
        <td>${esc(i.quantidadeItem)}</td><td>${esc(i.siglaUnidadeMedida||i.nomeUnidadeMedida)}</td>
        <td>${esc(i.countPrecos)}</td><td><button class="link-btn" onclick="openPrecos(${Number(i.idCotacaoItem)})">Ver preços</button></td>
      </tr>`).join(""):'<tr><td colspan="7" class="empty">Nenhum item.</td></tr>'}</tbody></table></div>
      <div id="precosDetail"></div>
      <details style="margin-top:16px"><summary>JSON bruto</summary><pre class="json">${esc(JSON.stringify(data,null,2))}</pre></details>`;
  }catch(e){box.innerHTML=`<div class="notice">${esc(e.message)}</div>`;toast(e.message,true);}
}

async function openPrecos(idItem){
  const box=$("#precosDetail");
  box.innerHTML='<div class="notice">Consultando preços...</div>';
  try{
    const data=await api(`/api/cotacoes/precos?IdItem=${encodeURIComponent(idItem)}`);
    const arr=normalizeArray(data);
    box.innerHTML=`<div class="card" style="margin-top:15px;padding:0;border:0;box-shadow:none">
      <h4>Preços do item #${esc(idItem)} (${arr.length})</h4>
      <div class="table-wrap"><table><thead><tr><th>Fonte</th><th>Produto</th><th>UF</th><th>Data</th><th>Preço</th><th>Fornecedor</th><th>Órgão</th></tr></thead>
      <tbody>${arr.length?arr.map(p=>`<tr>
        <td>${esc(p.fontePesquisa)}</td><td>${esc(p.produto)}</td><td>${esc(p.uf)}</td><td>${esc(fmtDate(p.data))}</td>
        <td><b>${p.preco!=null?Number(p.preco).toLocaleString("pt-BR",{style:"currency",currency:"BRL"}):"—"}</b></td>
        <td>${esc(p.cnpjFornecedor)}</td><td>${esc(p.orgao)}</td>
      </tr>`).join(""):'<tr><td colspan="7" class="empty">Nenhum preço retornado.</td></tr>'}</tbody></table></div>
      <details style="margin:12px 0"><summary>JSON bruto dos preços</summary><pre class="json">${esc(JSON.stringify(data,null,2))}</pre></details>
    </div>`;
  }catch(e){box.innerHTML=`<div class="notice">${esc(e.message)}</div>`;toast(e.message,true);}
}

async function createCotacao(e){
  e.preventDefault();
  const fd=new FormData(e.target);
  const body=Object.fromEntries(fd.entries());
  body.legislacao=Number(body.legislacao);
  body.idFinalidadeConviteFornecedor=Number(body.idFinalidadeConviteFornecedor);
  if(!body.dataPrevistaDivulgacaoEdital) delete body.dataPrevistaDivulgacaoEdital;
  try{
    const data=await api("/api/cotacoes",{method:"POST",body:JSON.stringify(body)});
    $("#createResult").classList.remove("hidden");
    $("#createResult").innerHTML=`<h3>Cotação criada</h3><pre class="json">${esc(JSON.stringify(data,null,2))}</pre>`;
    toast("Cotação criada com sucesso.");
    e.target.reset();
  }catch(err){toast(err.message,true);}
}

async function createItem(e){
  e.preventDefault();
  const fd=new FormData(e.target), body=Object.fromEntries(fd.entries());
  ["idCotacao","codigo","idCidadeEntrega","ajusteFreteTipo","idUnidadeMedida","quantidadeItem"].forEach(k=>body[k]=Number(body[k]||0));
  ["ajusteFreteValor","percentualPrecoMaximo"].forEach(k=>body[k]=Number(body[k]||0));
  try{
    const data=await api("/api/cotacoes/itens",{method:"POST",body:JSON.stringify(body)});
    $("#createResult").classList.remove("hidden");
    $("#createResult").innerHTML=`<h3>Item criado</h3><pre class="json">${esc(JSON.stringify(data,null,2))}</pre>`;
    toast("Item criado com sucesso.");
  }catch(err){toast(err.message,true);}
}

async function loadUnits(){
  const data=await api("/api/catalogos/unidades");
  const arr=normalizeArray(data);
  $("#unitsTable tbody").innerHTML=arr.map(x=>`<tr><td>${esc(x.idUnidadeMedida??x.id??x.Id)}</td><td>${esc(x.nome??x.nomeUnidadeMedida??x.Nome)}</td><td>${esc(x.sigla??x.siglaUnidadeMedida??"")}</td></tr>`).join("") || '<tr><td colspan="3" class="empty">Nenhum registro.</td></tr>';
}
async function loadCities(){
  const data=await api("/api/catalogos/cidades");
  const arr=normalizeArray(data);
  $("#citiesTable tbody").innerHTML=arr.map(x=>`<tr><td>${esc(x.idCidade??x.id??x.Id)}</td><td>${esc(x.nomeCidade??x.nome??x.Nome)}</td><td>${esc(x.uf??x.siglaUf??x.estado??"")}</td></tr>`).join("") || '<tr><td colspan="3" class="empty">Nenhum registro.</td></tr>';
}

$$(".nav").forEach(n=>n.addEventListener("click",async()=>{
  if(!authenticated) return;
  showView(n.dataset.view);
  if(n.dataset.view==="cotacoes" && !cotacoes.length) await loadCotacoes();
}));
$$("[data-go]").forEach(b=>b.addEventListener("click",()=>{ if(authenticated) showView(b.dataset.go); }));
$("#loginForm").addEventListener("submit",login);
$("#logoutBtn").addEventListener("click",logout);
$("#refreshBtn").addEventListener("click",()=>currentView==="cotacoes"?loadCotacoes():loadDashboard());
$("#loadCotacoes").addEventListener("click",loadCotacoes);
$("#cotacaoSearch").addEventListener("input",renderCotacoes);
$("#createCotacaoForm").addEventListener("submit",createCotacao);
$("#createItemForm").addEventListener("submit",createItem);
$("#loadUnits").addEventListener("click",()=>loadUnits().catch(e=>toast(e.message,true)));
$("#loadCities").addEventListener("click",()=>loadCities().catch(e=>toast(e.message,true)));
$("#quickUnits").addEventListener("click",()=>{showView("catalogos");loadUnits().catch(e=>toast(e.message,true));});
$("#quickCities").addEventListener("click",()=>{showView("catalogos");loadCities().catch(e=>toast(e.message,true));});

status();
