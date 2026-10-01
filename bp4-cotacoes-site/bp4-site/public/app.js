
let cotacoes = [];
let currentView = "fornecedores";
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
    const err = new Error(msg);
    err.status = r.status;
    throw err;
  }
  return data;
}

function showView(view){
  if(!authenticated) return;
  currentView = view;
  $$(".view").forEach(v=>v.classList.add("hidden"));
  $(`#${view}View`).classList.remove("hidden");
  $$(".nav").forEach(n=>n.classList.toggle("active", n.dataset.view===view));
  const titles={fornecedores:"Fornecedores",atas:"ATA de Registro de Preços",painel:"Painel"};
  $("#pageTitle").textContent=titles[view]||"ST Cotações 1.0";
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
      showView(currentView || "fornecedores");
      startHeartbeat();
      if(currentView === "painel") loadPainel();
    } else {
      currentView = "fornecedores";
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
  const passwordInput=$("#adminPassword");
  const token=String(input?.value || "").trim();
  const senha=String(passwordInput?.value || "");
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
      body:JSON.stringify({usuarioApiToken:token,senha})
    });
    input.value="";
    if(passwordInput) passwordInput.value="";
    toast("Conectado à BP4.");
    authenticated = true;
    document.body.classList.remove("locked");
    await status();
  }catch(e){ toast(e.message || "Não foi possível autenticar.",true); }
  finally{button.disabled=false;}
}

async function logout(){
  stopHeartbeat();
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

let supplierData=[];
let supplierPurchases=[];
function fmtMoney(v){ return v==null || !Number.isFinite(Number(v)) ? "—" : Number(v).toLocaleString("pt-BR",{style:"currency",currency:"BRL"}); }
function fmtCnpj(v){ const d=String(v||"").replace(/\D/g,""); return d.length===14 ? d.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/,'$1.$2.$3/$4-$5') : (v||"—"); }
function fmtPhone(v){ return v && v!=="SEM TELEFONE PUBLICO" ? String(v) : "NÃO LOCALIZADO"; }
function fmtEmail(v){ return v && v!=="SEM EMAIL PUBLICO" ? String(v) : "NÃO LOCALIZADO"; }
function closeSupplierDetail(){ const box=$("#supplierDetail"); box.classList.add("hidden"); box.innerHTML=""; }
function renderSupplierRows(){
  const q=String($("#supplierFilter").value||"").toLowerCase();
  const rows=supplierData.filter(s=>`${s.nome||""} ${s.cnpj||""}`.toLowerCase().includes(q));
  $("#supplierTable tbody").innerHTML=rows.length?rows.map((s,i)=>`<tr>
    <td><span class="supplier-name">${esc(s.razaoSocial||s.nome)}</span></td>
    <td><span class="supplier-cnpj">${esc(fmtCnpj(s.cnpj))}</span></td>
    <td><strong>${esc(s.uf||"—")}</strong></td>
    <td class="supplier-phone">${esc(fmtPhone(s.telefone))}</td>
    <td class="supplier-email">${esc(fmtEmail(s.email))}</td>
    <td>${esc(s.registros)}</td>
    <td>${s.meEpp?'<span class="badge">ME/EPP</span>':'—'}</td>
    <td>${esc(fmtDate(s.ultimaData))}</td>
    <td>${esc(fmtMoney(s.precoMedio))}</td>
    <td><button class="link-btn" data-supplier-index="${i}">Detalhes</button></td>
  </tr>`).join(""):'<tr><td colspan="10" class="empty">Nenhum fornecedor encontrado.</td></tr>';
  $$("[data-supplier-index]").forEach(b=>b.addEventListener("click",()=>openSupplierDetail(Number(b.dataset.supplierIndex))));
}
function openSupplierDetail(index){
  const q=String($("#supplierFilter").value||"").toLowerCase();
  const rows=supplierData.filter(s=>`${s.nome||""} ${s.cnpj||""}`.toLowerCase().includes(q));
  const s=rows[index]; if(!s) return;
  const compras=(s.compras||[]).map(c=>`<tr><td>${esc(c.descricao)}</td><td>${esc(c.orgao)}</td><td>${esc(c.uf||"—")}</td><td>${esc(fmtDate(c.data))}</td><td>${esc(fmtMoney(c.preco))}</td><td>${c.link?`<a href="${esc(c.link)}" target="_blank" rel="noopener">Abrir</a>`:'—'}</td></tr>`).join("");
  const safeUrl=(u)=>/^https?:\/\//i.test(String(u||""))?String(u):null;
  const sourceUrl=safeUrl(s.fonteWeb)||((s.fontesContato||[]).map(safeUrl).find(Boolean))||null;
  const sourceLink=sourceUrl?`<a href="${esc(sourceUrl)}" target="_blank" rel="noopener" class="source-link">Abrir fonte</a>`:`<span class="muted">não localizada</span>`;
  const box=$("#supplierDetail"); box.classList.remove("hidden"); box.innerHTML=`<div class="card-head"><div><h3>${esc(s.razaoSocial||s.nome)}</h3><span class="muted">${esc(fmtCnpj(s.cnpj))}</span></div><button type="button" class="ghost" id="closeSupplierDetailBtn">Fechar</button></div>
    <div class="supplier-detail-grid"><div class="pill"><small>Estado do fornecedor</small><strong>${esc(s.uf||"Não localizado")}</strong></div><div class="pill"><small>Telefone</small><strong>${esc(fmtPhone(s.telefone))}</strong></div><div class="pill"><small>E-mail</small><strong>${esc(fmtEmail(s.email))}</strong></div><div class="pill"><small>Registros</small><strong>${esc(s.registros)}</strong></div><div class="pill"><small>ME / EPP</small><strong>${s.meEpp?'Sim':'Não'}</strong></div><div class="pill"><small>Preço médio</small><strong>${esc(fmtMoney(s.precoMedio))}</strong></div><div class="pill"><small>Fonte de contato</small><strong>${sourceLink}</strong></div><div class="pill"><small>Fontes consultadas</small><strong>${sourceLink}</strong></div></div>
    ${s.cnpjUrl?`<div style="margin:10px 0"><a class="link-btn" href="${esc(s.cnpjUrl)}" target="_blank" rel="noopener">Consultar CNPJ e contatos no CNPJ Biz</a></div>`:""}
    <h4>Ocorrências recentes encontradas</h4><div class="table-wrap"><table><thead><tr><th>Item</th><th>Órgão</th><th>UF</th><th>Data</th><th>Preço</th><th></th></tr></thead><tbody>${compras||'<tr><td colspan="6" class="empty">Sem detalhes.</td></tr>'}</tbody></table></div>`;
  $("#closeSupplierDetailBtn").addEventListener("click",closeSupplierDetail);
  box.scrollIntoView({behavior:"smooth",block:"start"});
}
function renderAnalyzedPurchases(){
  const box=$("#supplierPurchases");
  if(!supplierPurchases.length){ box.classList.add("hidden"); return; }
  const rows=supplierPurchases.map(c=>`<tr><td>${esc(c.descricao||"—")}</td><td>${esc(c.orgao||"—")}</td><td>${esc(c.uf||"—")}</td><td>${esc(fmtDate(c.data))}</td><td>${esc(c.itensCorrespondentes??0)}</td><td>${esc(c.fornecedoresEncontrados??0)}</td><td>${esc(c.status||"—")}</td><td>${c.link?`<a href="${esc(c.link)}" target="_blank" rel="noopener">Abrir PNCP</a>`:'—'}</td></tr>`).join("");
  box.innerHTML=`<div class="supplier-purchases-head"><div><h3>Compras analisadas</h3><span class="muted">${supplierPurchases.length} contratação(ões) efetivamente analisada(s).</span></div><div class="supplier-purchases-actions"><button type="button" class="ghost" id="supplierPurchasesCsv">Exportar CSV</button><button type="button" class="ghost" id="supplierPurchasesClose">Fechar</button></div></div><div class="table-wrap"><table><thead><tr><th>Descrição</th><th>Órgão</th><th>UF</th><th>Data</th><th>Itens</th><th>Fornecedores</th><th>Status</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`;
  box.classList.add("hidden");
  $("#supplierPurchasesClose").addEventListener("click",()=>box.classList.add("hidden"));
  $("#supplierPurchasesCsv").addEventListener("click",exportSupplierPurchasesCsv);
}
function exportSupplierPurchasesCsv(){
  const header=["Descrição","Órgão","UF","Data","Itens correspondentes","Fornecedores encontrados","Status","Link"];
  const escCsv=v=>`"${String(v??"").replace(/"/g,'""')}"`;
  const lines=[header,supplierPurchases.map(c=>[c.descricao,c.orgao,c.uf,c.data,c.itensCorrespondentes,c.fornecedoresEncontrados,c.status,c.link])].flatMap(r=>[r.map(escCsv).join(";")]);
  const blob=new Blob(["\uFEFF"+lines.join("\n")],{type:"text/csv;charset=utf-8"});
  const a=document.createElement("a"); a.href=URL.createObjectURL(blob); a.download=`compras-analisadas-${new Date().toISOString().slice(0,10)}.csv`; a.click(); URL.revokeObjectURL(a.href);
}
async function exportSuppliersCsv(){
  if(!supplierData.length){ return toast("Faça uma pesquisa de fornecedores antes de exportar.",true); }
  try{
    const response=await fetch("/api/export/fornecedores",{
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({fornecedores:supplierData.map(s=>({
        fornecedor:s.razaoSocial||s.nome||"",
        cnpj:s.cnpj||"",
        email:s.email&&s.email!=="SEM EMAIL PUBLICO"?s.email:""
      }))})
    });
    if(!response.ok){
      let msg="Não foi possível gerar o arquivo.";
      try{ const data=await response.json(); msg=data.error||msg; }catch(_){}
      throw new Error(msg);
    }
    const blob=await response.blob();
    const a=document.createElement("a");
    a.href=URL.createObjectURL(blob);
    a.download=`fornecedores-${new Date().toISOString().slice(0,10)}.xlsx`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(()=>URL.revokeObjectURL(a.href),1000);
  }catch(err){ toast(err.message||"Erro ao exportar fornecedores.",true); }
}
function clearSupplierResults(){
  supplierData=[]; supplierPurchases=[]; closeSupplierDetail();
  $("#supplierResults").classList.add("hidden"); $("#supplierStats").classList.add("hidden"); $("#supplierNotice").classList.add("hidden"); $("#supplierPurchases").classList.add("hidden");
  $("#supplierTable tbody").innerHTML='<tr><td colspan="9" class="empty">Faça uma pesquisa.</td></tr>';
  $("#supplierResultHint").textContent=""; $("#supplierStatTotal").textContent="—"; $("#supplierStatMe").textContent="—"; $("#supplierStatItens").textContent="—"; $("#supplierStatCompras").textContent="—";
}
function applySupplierContact(payload){
  const idx=supplierData.findIndex(s=>String(s.cnpj||'')===String(payload.cnpj||''));
  if(idx<0) return;
  supplierData[idx]={...supplierData[idx], ...payload};
  renderSupplierRows();
  const foundPhone=supplierData.filter(s=>s.telefone && s.telefone!=='SEM TELEFONE PUBLICO').length;
  const foundEmail=supplierData.filter(s=>s.email && s.email!=='SEM EMAIL PUBLICO').length;
  const total=supplierData.length;
  $('#supplierContactProgress').textContent=`Contatos: ${foundPhone} telefones e ${foundEmail} e-mails encontrados de ${total} fornecedores.`;
}

function startSupplierStream(query, uf, ano){
  return new Promise((resolve,reject)=>{
    const url=`/api/fornecedores/mapa?q=${encodeURIComponent(query)}&uf=${encodeURIComponent(uf)}&ano=${encodeURIComponent(ano||"")}&maxCompras=80&stream=1`;
    const es=new EventSource(url);
    let completed=false;
    const close=()=>{ try{es.close();}catch(_){} };
    es.addEventListener('status',ev=>{
      try{
        const d=JSON.parse(ev.data);
        $('#supplierLoading .notice').textContent=d.mensagem||'Pesquisa em andamento...';
      }catch(_){}
    });
    es.addEventListener('initial',ev=>{
      try{
        const d=JSON.parse(ev.data);
        supplierData=d.fornecedores||[];
        supplierPurchases=d.comprasDetalhadas||[];
        $('#supplierStatTotal').textContent=d.totalFornecedores??supplierData.length;
        $('#supplierStatMe').textContent=d.totalMeEpp??0;
        $('#supplierStatItens').textContent=d.itensCorrespondentes??0;
        $('#supplierStatCompras').textContent=d.comprasAnalisadas??supplierPurchases.length;
        $('#supplierStats').classList.remove('hidden');
        $('#supplierResults').classList.remove('hidden');
        $('#supplierResultHint').textContent=`${supplierData.length} fornecedor(es) encontrados para “${query}” — contatos sendo pesquisados...`;
        $('#supplierContactProgress').textContent=`Contatos: 0 telefones e 0 e-mails encontrados de ${supplierData.length} fornecedores.`;
        renderSupplierRows(); renderAnalyzedPurchases();
        $('#exportSuppliersCsv')?.classList.remove('hidden');
      }catch(err){ reject(err); }
    });
    es.addEventListener('contact',ev=>{ try{ applySupplierContact(JSON.parse(ev.data)); }catch(_){} });
    es.addEventListener('complete',ev=>{
      completed=true;
      try{
        const d=JSON.parse(ev.data);
        supplierData=d.fornecedores||supplierData;
        supplierPurchases=d.comprasDetalhadas||supplierPurchases;
        $('#supplierStatTotal').textContent=d.totalFornecedores??supplierData.length;
        $('#supplierStatMe').textContent=d.totalMeEpp??0;
        $('#supplierStatItens').textContent=d.itensCorrespondentes??0;
        $('#supplierStatCompras').textContent=d.comprasAnalisadas??supplierPurchases.length;
        $('#supplierResultHint').textContent=`${supplierData.length} fornecedor(es) encontrados para “${query}” — pesquisa de contatos concluída.`;
        renderSupplierRows(); renderAnalyzedPurchases();
        resolve(d);
      }catch(err){ reject(err); }
      close();
    });
    es.onerror=()=>{
      if(completed) return;
      close();
      reject(new Error('A conexão da pesquisa foi interrompida. Os resultados já encontrados permanecem na tela; tente novamente para continuar.'));
    };
  });
}

async function searchSuppliers(e){
  e.preventDefault();
  const query=$('#supplierQuery').value.trim(); const uf=$('#supplierUf').value; const ano=$('#supplierAno').value;
  if(query.length<3) return toast('Informe pelo menos 3 caracteres.',true);
  clearSupplierResults();
  $('#supplierLoading').classList.remove('hidden');
  const btn=$('#supplierSearchBtn'); btn.disabled=true;
  try{
    const data=await startSupplierStream(query,uf,ano);
    if(!supplierData.length){ $('#supplierNotice').textContent='Nenhum fornecedor com resultado homologado foi encontrado nos registros analisados. Tente um termo mais específico ou outra UF.'; $('#supplierNotice').classList.remove('hidden'); }
  }catch(err){
    const msg=err?.message||'Falha ao pesquisar fornecedores.';
    toast(msg,true); $('#supplierNotice').textContent=msg; $('#supplierNotice').classList.remove('hidden');
  }finally{
    $('#supplierLoading').classList.add('hidden'); btn.disabled=false;
  }
}




async function searchAtas(event){
  event?.preventDefault(); resetAtas();
  const q=$("#ataQuery").value.trim(), uf=$("#ataUf").value, ano=$("#ataAno").value; if(q.length<3)return;
  const btn=$("#ataSearchBtn"); btn.disabled=true; $("#ataLoading").classList.remove("hidden");
  try{
    const data=await api(`/api/atas/mapa?q=${encodeURIComponent(q)}&uf=${encodeURIComponent(uf)}&ano=${encodeURIComponent(ano)}&adesao=true&paginas=10`);
    ataData=data.atas||[]; $("#ataStatTotal").textContent=ataData.length; $("#ataStatAdesao").textContent=ataData.filter(a=>a.permiteAdesao).length; $("#ataStatFontes").textContent=[...new Set(ataData.map(a=>a.fonte))].join(" + ")||"—";
    $("#ataStats").classList.remove("hidden"); $("#ataResults").classList.remove("hidden"); $("#ataResultHint").textContent=`${ataData.length} ata(s) para “${q}”`; renderAtaRows();
    if(data.warnings?.length){ $("#ataNotice").textContent="Algumas fontes apresentaram instabilidade, mas a pesquisa foi concluída com as demais. "+data.warnings.join(" | "); $("#ataNotice").classList.remove("hidden"); }
    if(!ataData.length){ $("#ataNotice").textContent="Nenhuma ata vigente com possibilidade de adesão explicitamente informada foi localizada. Consulte também os documentos da ata para confirmar saldo, limites e autorização do órgão gerenciador."; $("#ataNotice").classList.remove("hidden"); }
  }catch(e){ $("#ataNotice").textContent=e?.message||"Falha ao pesquisar atas."; $("#ataNotice").classList.remove("hidden"); toast($("#ataNotice").textContent,true); }
  finally{ $("#ataLoading").classList.add("hidden"); btn.disabled=false; }
}


function formatCnpjInput(value){
  const d=String(value||"").replace(/\D/g,"").slice(0,14);
  if(d.length<=2)return d;
  if(d.length<=5)return `${d.slice(0,2)}.${d.slice(2)}`;
  if(d.length<=8)return `${d.slice(0,2)}.${d.slice(2,5)}.${d.slice(5)}`;
  if(d.length<=12)return `${d.slice(0,2)}.${d.slice(2,5)}.${d.slice(5,8)}/${d.slice(8)}`;
  return `${d.slice(0,2)}.${d.slice(2,5)}.${d.slice(5,8)}/${d.slice(8,12)}-${d.slice(12)}`;
}
$$('.nav').forEach(n=>n.addEventListener("click",async()=>{
  if(!authenticated) return;
  showView(n.dataset.view);
  if(n.dataset.view==="painel") await loadPainel();
}));
$$("[data-go]").forEach(b=>b.addEventListener("click",()=>{ if(authenticated) showView(b.dataset.go); }));
$("#loginForm").addEventListener("submit",login);
$("#logoutBtn").addEventListener("click",logout);
$("#refreshBtn").addEventListener("click",async()=>{
  const statusEl=$("#refreshStatus"); const btn=$("#refreshBtn");
  statusEl.classList.remove("hidden"); btn.disabled=true;
  try{
    if(currentView==="fornecedores" && $("#supplierQuery").value.trim().length>=3) await searchSuppliers({preventDefault(){}});
    else if(currentView==="atas" && $("#ataQuery").value.trim().length>=3) await searchAtas({preventDefault(){}});
    else if(currentView==="painel") await loadPainel();
  } finally { statusEl.classList.add("hidden"); btn.disabled=false; }
});
$("#supplierSearchForm").addEventListener("submit",searchSuppliers);
$("#supplierPurchasesStat").addEventListener("click",()=>{ if(supplierPurchases.length){ $("#supplierPurchases").classList.remove("hidden"); $("#supplierPurchases").scrollIntoView({behavior:"smooth",block:"start"}); } });
$("#supplierFilter").addEventListener("input",renderSupplierRows);
$("#exportSuppliersCsv").addEventListener("click",exportSuppliersCsv);
$("#ataSearchForm").addEventListener("submit",searchAtas);
$("#ataFilter").addEventListener("input",renderAtaRows);
$("#ataTable").addEventListener("click",e=>{ const b=e.target.closest(".ata-detail-btn"); if(b) openAtaDetail(b.dataset.ataControl); });
$("#loadPainel").addEventListener("click",loadPainel);
$("#painelTable").addEventListener("click", async (e)=>{
  const btn=e.target.closest(".painel-kick-btn");
  if(!btn) return;
  const ip=btn.dataset.ip||"";
  if(!ip) return;
  if(!confirm(`Deslogar todos os acessos do IP ${ip}? Esse acesso voltará para a tela de inserir token.`)) return;
  btn.disabled=true;
  try{
    const data=await api("/api/painel/deslogar-ip",{method:"POST",body:JSON.stringify({ip})});
    toast(`${data.sessoesDeslogadas||0} sessão(ões) deslogada(s).`);
    await loadPainel();
  }catch(err){
    toast(err?.message||"Não foi possível deslogar esse IP.",true);
    btn.disabled=false;
  }
});



status();
