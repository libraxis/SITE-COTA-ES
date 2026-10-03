const express=require("express");
const path=require("path");
const app=express();
const PORT=process.env.PORT||3000;
const PNCP="https://pncp.gov.br/api/consulta/v1/contratacoes/proposta";
app.use(express.json({limit:"1mb"}));
app.use(express.static(path.join(__dirname,"public")));

const cache=new Map();
const CACHE_MS=5*60*1000;
const MODALIDADES={1:"Leilão - Eletrônico",2:"Diálogo Competitivo",3:"Concurso",4:"Concorrência - Eletrônica",5:"Concorrência - Presencial",6:"Pregão - Eletrônico",7:"Pregão - Presencial",8:"Dispensa",9:"Inexigibilidade",10:"Manifestação de Interesse",11:"Pré-qualificação",12:"Credenciamento",13:"Leilão - Presencial",14:"Procedimento de Manifestação de Interesse"};

function cacheKey(uf,q){return (uf||"ALL")+"|"+q.toLowerCase().normalize("NFD").replace(/[\\u0300-\\u036f]/g,"");}
function sleep(ms){return new Promise(r=>setTimeout(r,ms));}
async function fetchJson(url,timeout=12000){
 const c=new AbortController();const timer=setTimeout(()=>c.abort(),timeout);
 try{const r=await fetch(url,{headers:{accept:"application/json"}});if(!r.ok)throw new Error("PNCP HTTP "+r.status);return await r.json();}
 finally{clearTimeout(timer);}
}
function pick(obj,...keys){for(const k of keys){if(obj?.[k]!=null)return obj[k];}return null;}
function normalize(item){
 const org=item.orgaoEntidade||item.orgao||item.entidade||{};
 const unidade=item.unidadeOrgao||item.unidadeAdministrativa||{};
 const uf=pick(unidade,"ufSigla")||pick(org,"ufSigla")||item.uf||"";
 const cnpj=pick(org,"cnpj","cnpjOrgao")||item.cnpj||"";
 const ano=item.anoCompra||item.ano||"";
 const seq=item.sequencialCompra||item.sequencial||"";
 const controle=item.numeroControlePNCP||item.numeroControlePncp||item.controlePncp||"";
 return {
  controlePncp:controle,
  numero:pick(item,"numeroCompra","numeroEdital","numeroProcesso")||controle||"Processo PNCP",
  orgao:pick(org,"razaoSocial","razaoSocialOrgao","nome")||pick(item,"razaoSocial")||"Órgão não informado",
  uf:String(uf||"").toUpperCase(),
  modalidade:MODALIDADES[item.codigoModalidadeContratacao]||item.modalidadeNome||item.modalidade||"Não informada",
  objeto:pick(item,"objetoCompra","objeto","descricao")||"Objeto não informado",
  encerramento:pick(item,"dataEncerramentoProposta","dataEncerramento","dataFimRecebimentoPropostas"),
  abertura:pick(item,"dataAberturaProposta","dataAbertura"),
  valor:item.valorTotalEstimado??item.valorEstimado??null,
  link:controle?(`https://pncp.gov.br/app/editais/${cnpj}/${ano}/${seq}`):"https://pncp.gov.br/app/editais"
 };
}
function matches(p,q){const norm=s=>String(s||"").toLowerCase().normalize("NFD").replace(/[\\u0300-\\u036f]/g,"");return norm(p.objeto).includes(norm(q));}

app.get("/api/processos",async(req,res)=>{
 const uf=String(req.query.uf||"").trim().toUpperCase();
 const q=String(req.query.q||"").trim();
 if(q.length<2)return res.status(400).json({error:"Informe o material ou serviço que deseja pesquisar."});
 const key=cacheKey(uf,q),hit=cache.get(key);
 if(hit&&Date.now()-hit.at<CACHE_MS)return res.json({...hit.data,cache:true});
 const hoje=new Date();const dataFinal=hoje.toISOString().slice(0,10).replace(/-/g,"");
 const params=new URLSearchParams({dataFinal,pagina:"1",tamanhoPagina:"50"});if(uf)params.set("uf",uf);
 const encontrados=[];const warnings=[];let paginas=1;
 try{
   let page=1;
   while(page<=Math.min(paginas,20)){
     params.set("pagina",String(page));
     const data=await fetchJson(PNCP+"?"+params.toString());
     const content=data.data||data.content||data.resultados||[];
     const totalPages=Number(data.totalPaginas||data.totalPages||data.numeroPaginas||0);
     if(totalPages)paginas=totalPages;
     for(const raw of content){const p=normalize(raw);if((!uf||p.uf===uf)&&matches(p,q))encontrados.push(p);}
     if(!content.length||page>=paginas)break;
     page++;
     if(page<=20)await sleep(120);
   }
 }catch(err){
   warnings.push(err.name==="AbortError"?"O PNCP demorou além do limite de resposta.":"Falha temporária ao consultar o PNCP: "+err.message);
 }
 encontrados.sort((a,b)=>new Date(a.encerramento||0)-new Date(b.encerramento||0));
 const data={processos:encontrados,warnings};
 cache.set(key,{at:Date.now(),data});
 res.json(data);
});
app.get("/{*splat}",(req,res)=>res.sendFile(path.join(__dirname,"public","index.html")));
app.listen(PORT,()=>console.log("ST Processos ativo na porta "+PORT));
