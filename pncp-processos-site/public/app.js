let processos=[];
const $=s=>document.querySelector(s);
const esc=v=>String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
function toast(msg,error=false){const t=$("#toast");t.textContent=msg;t.style.background=error?"#8f1d1d":"#18212f";t.classList.add("show");clearTimeout(window.__toast);window.__toast=setTimeout(()=>t.classList.remove("show"),3200);}
async function api(url,options={}){const r=await fetch(url,{...options,headers:{"Content-Type":"application/json",...(options.headers||{})}});let d={};try{d=await r.json();}catch{}if(!r.ok)throw new Error(d.error||"Não foi possível consultar o servidor.");return d;}
function fmtDate(v){if(!v)return "—";const d=new Date(v);return Number.isNaN(d.getTime())?String(v):d.toLocaleString("pt-BR",{dateStyle:"short",timeStyle:"short"});}
function render(){
 const q=String($("#resultFilter").value||"").toLowerCase().trim();
 const rows=processos.filter(p=>`${p.numero||""} ${p.orgao||""} ${p.uf||""} ${p.modalidade||""} ${p.objeto||""} ${p.controlePncp||""}`.toLowerCase().includes(q));
 $("#processTable tbody").innerHTML=rows.length?rows.map(p=>`<tr>
 <td><strong>${esc(p.numero||"—")}</strong><br><small>${esc(p.controlePncp||"")}</small></td>
 <td style="white-space:normal;min-width:210px">${esc(p.orgao||"—")}</td>
 <td>${esc(p.uf||"—")}</td><td>${esc(p.modalidade||"—")}</td>
 <td style="white-space:normal;min-width:360px">${esc(p.objeto||"—")}</td>
 <td>${esc(fmtDate(p.encerramento))}</td>
 <td><a class="primary" style="display:inline-block;text-decoration:none" href="${esc(p.link||"#")}" target="_blank" rel="noopener">Abrir PNCP</a></td>
 </tr>`).join(""):'<tr><td colspan="7" class="empty">Nenhum processo corresponde aos filtros informados.</td></tr>';
}
async function search(e){
 e?.preventDefault();const uf=$("#uf").value,keyword=$("#keyword").value.trim();
 if(keyword.length<2)return toast("Informe pelo menos 2 caracteres do material ou serviço.",true);
 $("#searchBtn").disabled=true;$("#loading").classList.remove("hidden");$("#results").classList.add("hidden");$("#stats").classList.add("hidden");$("#notice").classList.add("hidden");
 $("#progress").textContent="Consultando a base oficial do PNCP. Isso pode levar alguns segundos...";
 try{
   const d=await api(`/api/processos?uf=${encodeURIComponent(uf)}&q=${encodeURIComponent(keyword)}`);
   processos=d.processos||[];$("#statTotal").textContent=processos.length;$("#statUf").textContent=uf||"Todas";$("#statAbertos").textContent=processos.length;
   $("#resultHint").textContent=`${processos.length} processo(s) encontrado(s) para “${keyword}”`;
   $("#stats").classList.remove("hidden");$("#results").classList.remove("hidden");render();
   if(d.warnings?.length){$("#notice").textContent="A pesquisa foi concluída, mas o PNCP informou alguma instabilidade: "+d.warnings.join(" | ");$("#notice").classList.remove("hidden");}
   if(!processos.length){$("#notice").textContent="Nenhum processo aberto foi localizado com esse material/serviço e UF. Tente um termo mais amplo.";$("#notice").classList.remove("hidden");}
 }catch(err){toast(err.message,true);$("#notice").textContent=err.message;$("#notice").classList.remove("hidden");}
 finally{$("#loading").classList.add("hidden");$("#searchBtn").disabled=false;}
}
$("#searchForm").addEventListener("submit",search);
$("#resultFilter").addEventListener("input",render);
$("#refreshBtn").addEventListener("click",()=>{if($("#keyword").value.trim())search({preventDefault(){}});});
