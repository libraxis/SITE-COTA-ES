const express = require("express");
const session = require("express-session");
const cookieParser = require("cookie-parser");
const path = require("path");

const app = express();
app.set("trust proxy", 1);
const PORT = process.env.PORT || 3000;
const BP4_BASE = process.env.BP4_BASE_URL || "https://api.bancodeprecos.com.br";
const PNCP_SEARCH_BASE = process.env.PNCP_SEARCH_URL || "https://pncp.gov.br/api/search";
const PNCP_API_BASE = process.env.PNCP_API_URL || "https://pncp.gov.br/api/pncp/v1";
const BRASIL_API_BASE = process.env.BRASIL_API_URL || "https://brasilapi.com.br/cnpj/v1";
const COMPRAS_BASE = process.env.COMPRAS_API_URL || "https://dadosabertos.compras.gov.br";

// Cache em memória + deduplicação de requisições em andamento.
// Isso reduz bastante o tempo em pesquisas repetidas e evita consultar a mesma URL
// várias vezes quando PNCP/Compras.gov.br retornam registros duplicados.
const httpCache = new Map();
const httpInflight = new Map();
const DEFAULT_CACHE_TTL = 5 * 60 * 1000;
function cacheGet(key) {
  const hit = httpCache.get(key);
  if (!hit) return undefined;
  if (hit.expiresAt <= Date.now()) { httpCache.delete(key); return undefined; }
  return hit.data;
}
function cacheSet(key, data, ttl = DEFAULT_CACHE_TTL) {
  if (httpCache.size > 2500) {
    const first = httpCache.keys().next().value;
    if (first) httpCache.delete(first);
  }
  httpCache.set(key, { data, expiresAt: Date.now() + ttl });
  return data;
}

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

app.use(session({
  secret: process.env.SESSION_SECRET || "troque-esta-chave-em-producao",
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 8 * 60 * 60 * 1000
  }
}));

app.use(express.static(path.join(__dirname, "public")));

// Registro de acessos do painel. Fica em memória neste processo do Render.
// Login explícito gera um registro; heartbeat mantém a atividade atualizada;
// logout marca a saída. Se o navegador for fechado sem logout, o painel marca
// a sessão como inativa após o prazo de heartbeat.
const accessLog = new Map();
const ACCESS_INACTIVE_MS = 90 * 1000;
function clientIp(req) {
  return String(req.ip || req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "—").split(",")[0].trim();
}
function recordLogin(req) {
  const now = Date.now();
  accessLog.set(req.sessionID, {
    sessionId: req.sessionID,
    ip: clientIp(req),
    loginAt: now,
    lastSeenAt: now,
    logoutAt: null,
    status: "CONECTADO",
    userAgent: String(req.headers["user-agent"] || "")
  });
}
function touchAccess(req) {
  const id = req.sessionID;
  if (!id || !req.session?.apiToken) return;
  const row = accessLog.get(id);
  if (row) { row.lastSeenAt = Date.now(); if (!row.logoutAt) row.status = "CONECTADO"; }
}
function accessRows() {
  const now = Date.now();
  return [...accessLog.values()].sort((a,b) => b.loginAt - a.loginAt).map(row => {
    const copy = { ...row };
    if (!copy.logoutAt && now - copy.lastSeenAt > ACCESS_INACTIVE_MS) copy.status = "INATIVA / SEM ATIVIDADE";
    delete copy.sessionId;
    delete copy.userAgent;
    return copy;
  });
}

function cleanBase(url) { return url.replace(/\/+$/, ""); }
function reqToken(req) { return req.session && req.session.jwt; }

async function fetchJson(url, options = {}) {
  const timeoutMs = Number(options.timeoutMs || 12000);
  const retries = Number(options.retries ?? 2);
  const method = options.method || "GET";
  const useCache = method === "GET" && options.cache !== false;
  const cacheTtl = Number(options.cacheTtl ?? DEFAULT_CACHE_TTL);
  const cacheKey = `${method}:${url}`;
  if (useCache) {
    const cached = cacheGet(cacheKey);
    if (cached !== undefined) return cached;
    if (httpInflight.has(cacheKey)) return httpInflight.get(cacheKey);
  }

  const run = (async () => {
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(url, {
          method,
          headers: { "Accept": "application/json, text/plain, */*", ...(options.headers || {}) },
          body: options.body,
          signal: controller.signal
        });
        const text = await response.text();
        let data = text;
        try { data = text ? JSON.parse(text) : null; } catch (_) {}
        if (!response.ok) {
          const err = new Error((data && (data.message || data.mensagem || data.title)) || `HTTP ${response.status}`);
          err.status = response.status; err.data = data;
          if (![408,429,500,502,503,504].includes(response.status) || attempt >= retries) throw err;
          lastErr = err;
        } else {
          return useCache ? cacheSet(cacheKey, data, cacheTtl) : data;
        }
      } catch (err) {
        lastErr = err.name === "AbortError" ? new Error(`Tempo limite ao consultar fonte externa (${timeoutMs/1000}s).`) : err;
        if (attempt >= retries) break;
      } finally { clearTimeout(timer); }
      const wait = Math.min(700 * (attempt + 1), 1800);
      await new Promise(r => setTimeout(r, wait));
    }
    throw lastErr || new Error("Falha de comunicação com a fonte externa.");
  })();
  if (useCache) {
    httpInflight.set(cacheKey, run);
    try { return await run; } finally { httpInflight.delete(cacheKey); }
  }
  return run;
}

async function bp4Fetch(endpoint, options = {}) {
  if (!options.skipAuth && !reqToken(options.req)) {
    const err = new Error("Não autenticado"); err.status = 401; throw err;
  }
  const headers = { "Accept": "application/json, text/plain, */*" };
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  if (!options.skipAuth) headers["Authorization"] = `Bearer ${reqToken(options.req)}`;
  return fetchJson(cleanBase(BP4_BASE) + endpoint, {
    method: options.method || "GET",
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined
  });
}

async function ensureJwt(req) {
  if (!req.session.apiToken) {
    const err = new Error("Informe o Token de Acesso API-Banco de Preços."); err.status = 401; throw err;
  }
  if (req.session.jwt && req.session.jwtExpiresAt && Date.now() < req.session.jwtExpiresAt - 60000) return req.session.jwt;

  const response = await fetch(cleanBase(BP4_BASE) + "/api/bp4/Auth/CreateUserToken", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json, text/plain, */*" },
    body: JSON.stringify({ usuarioApiToken: req.session.apiToken })
  });
  const text = await response.text();
  let data = text;
  try { data = text ? JSON.parse(text) : null; } catch (_) {}
  if (!response.ok || !data || !data.token) {
    let message = (data && (data.message || data.mensagem || data.title)) || `Falha na autenticação BP4 (HTTP ${response.status})`;
    if (response.status === 401) message = "O Token de Acesso API-Banco de Preços foi rejeitado pela BP4. Confira o token em Configurações > Preferências > Token de Acesso API-Banco de Preços.";
    const err = new Error(message); err.status = response.status || 401; err.data = data; throw err;
  }
  req.session.jwt = data.token;
  req.session.jwtExpiresAt = Date.now() + 8 * 60 * 60 * 1000;
  return data.token;
}

async function authenticatedCall(req, endpoint, options = {}) {
  await ensureJwt(req);
  return bp4Fetch(endpoint, { ...options, req });
}

function asyncRoute(handler) {
  return (req, res) => Promise.resolve(handler(req, res)).catch(err => {
    console.error(err);
    res.status(err.status || 500).json({ error: err.message || "Erro interno", details: err.data ?? null });
  });
}

function onlyDigits(value) { return String(value || "").replace(/\D/g, ""); }
function normalizeText(value) {
  return String(value || "")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

const STOP_WORDS = new Set([
  "a","o","as","os","de","da","do","das","dos","e","em","para","por","com","sem","um","uma","uns","umas",
  "na","no","nas","nos","ao","aos","que","se","servico","servicos","material","materiais","fornecimento","fornecer"
]);
function queryTokens(query) {
  return normalizeText(query).split(/\s+/).filter(t => t.length >= 2 && !STOP_WORDS.has(t));
}

// Expansão leve de consulta, sem depender de uma API de IA externa.
// A ideia é aumentar a cobertura sem transformar a IA em gargalo de velocidade.
const SEARCH_ALIASES = {
  "papel": ["papel sulfite", "papel para impressao"],
  "sulfite": ["papel sulfite"],
  "computador": ["microcomputador", "computador desktop", "microcomputador desktop"],
  "notebook": ["computador portatil", "microcomputador portatil"],
  "impressora": ["impressora multifuncional", "equipamento de impressao"],
  "toner": ["cartucho de toner", "suprimento de impressao"],
  "cartucho": ["cartucho de tinta", "cartucho de toner"],
  "material eletrico": ["materiais eletricos", "material eletrico e eletronico"],
  "limpeza": ["material de limpeza", "materiais de limpeza"],
  "veiculo": ["veiculo automotor", "automovel"],
  "medicamento": ["medicamentos", "produto farmaceutico"],
  "uniforme": ["uniformes", "vestuario profissional"]
};
function smartQueryVariants(query, max = 3) {
  const base = String(query || "").trim();
  const normalized = normalizeText(base);
  const variants = [base];
  for (const [key, values] of Object.entries(SEARCH_ALIASES)) {
    if (!normalized.includes(key)) continue;
    for (const alias of values) {
      const candidate = normalizeText(base).replace(key, alias);
      if (candidate && candidate !== normalized) variants.push(candidate);
      if (variants.length >= max) return [...new Set(variants)].slice(0, max);
    }
  }
  return [...new Set(variants)].slice(0, max);
}
function descriptionMatchesAny(description, queries) {
  return (queries || []).some(q => descriptionMatches(description, q));
}
function pncpRows(data) {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== "object") return [];
  for (const k of ["data","items","resultado","resultados","listaResultados","content"]) if (Array.isArray(data[k])) return data[k];
  return [];
}
function descriptionMatches(description, query) {
  const text = normalizeText(description);
  const phrase = normalizeText(query);
  if (!text) return false;
  if (phrase && text.includes(phrase)) return true;
  const tokens = queryTokens(query);
  if (!tokens.length) return false;
  const hits = tokens.filter(t => text.includes(t)).length;
  return hits / tokens.length >= 0.6;
}

function parsePurchaseUrl(itemUrl) {
  const match = String(itemUrl || "").match(/\/compras\/(\d{8,14})\/(\d{4})\/(\d+)/);
  if (!match) return null;
  return { orgao: match[1], ano: Number(match[2]), compra: Number(match[3]) };
}

async function pncpSearch(q, { uf, pagina = 1, tamPagina = 20 } = {}) {
  const url = new URL(PNCP_SEARCH_BASE + "/");
  url.searchParams.set("q", q);
  url.searchParams.set("tipos_documento", "edital");
  url.searchParams.set("status", "encerradas");
  url.searchParams.set("ordenacao", "-data");
  url.searchParams.set("pagina", String(pagina));
  url.searchParams.set("tam_pagina", String(Math.min(Math.max(tamPagina, 1), 50)));
  if (uf) url.searchParams.set("uf", uf);
  return fetchJson(url.toString());
}

async function pncpGetItems(purchase, pagina = 1) {
  const url = `${cleanBase(PNCP_API_BASE)}/orgaos/${purchase.orgao}/compras/${purchase.ano}/${purchase.compra}/itens?pagina=${pagina}&tamanhoPagina=50`;
  return fetchJson(url, { cacheTtl: 10 * 60 * 1000 });
}

async function pncpGetResults(purchase, numeroItem) {
  const url = `${cleanBase(PNCP_API_BASE)}/orgaos/${purchase.orgao}/compras/${purchase.ano}/${purchase.compra}/itens/${encodeURIComponent(numeroItem)}/resultados`;
  return fetchJson(url, { cacheTtl: 10 * 60 * 1000 });
}

async function enrichPhone(cnpj) {
  const digits = onlyDigits(cnpj);
  if (digits.length !== 14) return null;
  try {
    const data = await fetchJson(`${cleanBase(BRASIL_API_BASE)}/${digits}`);
    return data?.ddd_telefone_1 || data?.ddd_telefone_2 || data?.telefone || null;
  } catch (_) { return null; }
}

async function mapSupplierRecord(suppliers, r, meta = {}) {
  const cnpj = onlyDigits(r?.niFornecedor || r?.cnpjFornecedor || r?.codFornecedor || "");
  const nome = r?.nomeRazaoSocialFornecedor || r?.nomeFornecedor || r?.fornecedorNome || "Fornecedor não informado";
  if (!cnpj && !nome) return;
  const supplierKey = cnpj || normalizeText(nome);
  let s = suppliers.get(supplierKey);
  if (!s) {
    s = { nome, cnpj, registros: 0, vencedores: 0, meEpp: false, ultimaData: null, precoMedio: null, _sum: 0, _priceCount: 0, compras: [], fontes: new Set() };
    suppliers.set(supplierKey, s);
  }
  s.registros += 1;
  s.vencedores += 1;
  s.meEpp = s.meEpp || [1,2].includes(Number(r?.porteFornecedorId));
  const data = r?.dataResultado || r?.dataResultadoPncp || r?.dataCompra || null;
  if (data && (!s.ultimaData || new Date(data) > new Date(s.ultimaData))) s.ultimaData = data;
  const price = Number(r?.valorUnitarioHomologado ?? r?.valorUnitarioResultado ?? r?.precoUnitario);
  if (Number.isFinite(price)) { s._sum += price; s._priceCount++; }
  const fonte = meta.fonte || "PNCP";
  s.fontes.add(fonte);
  if (s.compras.length < 8) s.compras.push({
    descricao: meta.descricao || r?.descricaoResumida || r?.descricaodetalhada || r?.descricaoItem || "",
    orgao: meta.orgao || r?.nomeOrgao || "",
    uf: meta.uf || r?.estado || "",
    data,
    preco: Number.isFinite(price) ? price : null,
    link: meta.link || null,
    fonte
  });
}

async function comprasGovSearch(q, uf, suppliers) {
  const base = cleanBase(COMPRAS_BASE) + "/modulo-pesquisa-preco/1_consultarMaterial";
  const queries = queryTokens(q).slice(0, 2);
  // The official price endpoint requires CATMAT code, so use PNCP to discover
  // candidate catalog codes first; then query Compras.gov when codes are present.
  // This function is intentionally best-effort: a failure never aborts the map.
  return { registros: 0, aviso: "A API de preços do Compras.gov.br exige código CATMAT/CATSER; a descoberta textual é feita pelo PNCP." };
}

async function comprasGovRecentSearch(q, uf, suppliers) {
  // Fast secondary source: recent PNCP items already indexed by Compras.gov.br.
  // We inspect a small number of 500-row pages in parallel and filter locally.
  const endpoint = cleanBase(COMPRAS_BASE) + "/modulo-contratacoes/2_consultarItensContratacoes_PNCP_14133";
  const days = 180;
  const end = new Date();
  const begin = new Date(end.getTime() - days*86400000);
  const fmt = d => d.toISOString().slice(0,10);
  const common = new URLSearchParams({
    tamanhoPagina: "500",
    pagina: "1",
    dataInclusaoPncpInicial: fmt(begin),
    dataInclusaoPncpFinal: fmt(end),
    temResultado: "true"
  });
  if (uf) common.set("unidadeOrgaoUfSigla", uf);
  // The upstream API can be sensitive to optional filters. Try the documented
  // recent-window query first; failures are isolated from the main PNCP search.
  let total = 0;
  const maxPages = 4;
  const pages = await Promise.all(Array.from({length:maxPages}, (_,i) => {
    const u = new URL(endpoint); const p = new URLSearchParams(common); p.set("pagina", String(i+1)); u.search=p.toString();
    return fetchJson(u.toString(), { timeoutMs: 10000, retries: 1 }).catch(() => null);
  }));
  for (const data of pages) {
    const rows = Array.isArray(data?.resultado) ? data.resultado : [];
    total += rows.length;
    for (const r of rows) {
      if (!r?.temResultado || !descriptionMatches(`${r.descricaoResumida||""} ${r.descricaodetalhada||""}`, q)) continue;
      await mapSupplierRecord(suppliers, r, { fonte: "Compras.gov.br", descricao: r.descricaodetalhada || r.descricaoResumida, uf: r.estado, orgao: r.nomeOrgao });
    }
  }
  return total;
}

async function supplierMap(req, res) {
  await ensureJwt(req);
  const q = String(req.query.q || "").trim();
  if (q.length < 3) return res.status(400).json({ error: "Informe pelo menos 3 caracteres para pesquisar o item." });
  const uf = String(req.query.uf || "").trim().toUpperCase();
  const maxCompras = Math.min(Math.max(Number(req.query.maxCompras || 60), 30), 80);

  const suppliers = new Map();
  const matchedItems = [];
  const purchasesSeen = new Set();
  const analyzedPurchases = new Map();
  let purchasesProcessed = 0;
  let searchPages = [];

  const variants = smartQueryVariants(q, 3);
  try {
    const jobs = [];
    for (const variant of variants) {
      for (let i = 1; i <= 3; i++) {
        jobs.push(pncpSearch(variant, { uf, pagina:i, tamPagina:50 }).catch(err => { console.warn("PNCP busca", variant, i, err.message); return null; }));
      }
    }
    searchPages = await Promise.all(jobs);
  } catch (_) {}

  const uniqueSearch = new Map();
  for (const d of searchPages) for (const row of pncpRows(d)) {
    const key = row?.item_url || row?.id || JSON.stringify(row);
    uniqueSearch.set(String(key), row);
  }
  const searchItems = [...uniqueSearch.values()];
  const purchases = [];
  for (const result of searchItems) {
    const purchase = parsePurchaseUrl(result?.item_url);
    if (!purchase) continue;
    const purchaseUf = String(result?.uf || result?.ufSigla || result?.unidade_federativa || "").toUpperCase();
    if (uf && purchaseUf && purchaseUf !== uf) continue;
    const key = `${purchase.orgao}-${purchase.ano}-${purchase.compra}`;
    if (purchasesSeen.has(key)) continue;
    purchasesSeen.add(key);
    purchases.push({ purchase, result, key, purchaseUf });
    if (purchases.length >= maxCompras) break;
  }

  let cursor = 0;
  async function worker() {
    while (true) {
      const idx = cursor++;
      if (idx >= purchases.length) return;
      const {purchase,result,key,purchaseUf} = purchases[idx];
      const detail = {
        chave: key,
        orgao: result?.orgao_nome || result?.orgao || purchase.orgao || "",
        uf: purchaseUf || uf || result?.uf || result?.ufSigla || "",
        data: result?.data_publicacao || result?.dataPublicacao || result?.data || null,
        descricao: result?.objeto || result?.descricao || result?.titulo || "",
        link: `https://pncp.gov.br/app/editais/${purchase.orgao}/${purchase.ano}/${purchase.compra}`,
        itensCorrespondentes: 0,
        fornecedoresEncontrados: 0,
        status: "Analisando"
      };
      analyzedPurchases.set(key, detail);
      try {
        let items = await pncpGetItems(purchase, 1);
        let rows = pncpRows(items);
        let matches = rows.filter(item => descriptionMatchesAny(item?.descricao, variants) && item?.temResultado !== false && (item?.numeroItem ?? item?.numero) != null).slice(0, 20);
        if (rows.length >= 50) {
          try {
            const page2 = await pncpGetItems(purchase, 2);
            const rows2 = pncpRows(page2);
            rows = rows.concat(rows2);
            const more = rows2.filter(item => descriptionMatchesAny(item?.descricao, variants) && item?.temResultado !== false && (item?.numeroItem ?? item?.numero) != null).slice(0, 20);
            matches = matches.concat(more).slice(0, 30);
          } catch (_) {}
        }
        detail.itensCorrespondentes = matches.length;
        await Promise.all(matches.map(async item => {
          const numeroItem = item?.numeroItem ?? item?.numero;
          try {
            const resultados = pncpRows(await pncpGetResults(purchase, numeroItem));
            if (!resultados.length) return;
            let localCount = 0;
            for (const r of resultados) {
              const recordUf = String(r?.uf || r?.estado || purchaseUf || "").toUpperCase();
              if (uf && recordUf && recordUf !== uf) continue;
              await mapSupplierRecord(suppliers, r, {
                fonte: "PNCP", descricao:item.descricao, orgao:result?.orgao_nome || "", uf:recordUf || uf || "",
                link:detail.link
              });
              localCount++;
            }
            if (localCount) detail.fornecedoresEncontrados += localCount;
            matchedItems.push({ descricao:item.descricao, compra:key, numeroItem, quantidade:item.quantidade, unidade:item.unidadeMedida, resultados:localCount });
          } catch (err) { console.warn("PNCP resultados", key, numeroItem, err.message); }
        }));
        detail.status = detail.itensCorrespondentes ? "Concluída" : "Sem item compatível";
      } catch (err) {
        detail.status = "Falha na consulta";
        detail.erro = err.message;
        console.warn("PNCP itens", key, err.message);
      }
      purchasesProcessed++;
    }
  }
  await Promise.all(Array.from({length:16}, worker));

  let comprasRows = 0;
  const secondary = await Promise.allSettled([
    comprasGovRecentSearch(q, uf, suppliers),
    comprasGovArpSearch(q, uf)
  ]);
  if (secondary[0].status === "fulfilled") comprasRows += Number(secondary[0].value || 0);
  else console.warn("Compras.gov", secondary[0].reason?.message || secondary[0].reason);
  if (secondary[1].status === "fulfilled") {
    const arpRows = secondary[1].value || [];
    for (const r of arpRows.slice(0, 1200)) {
      const cnpj = onlyDigits(r?.cnpjFornecedor || r?.niFornecedor || r?.codFornecedor || "");
      const nome = r?.nomeFornecedor || r?.fornecedorNome || "Fornecedor não informado";
      if (!cnpj && !nome) continue;
      await mapSupplierRecord(suppliers, {
        niFornecedor: cnpj, nomeFornecedor: nome,
        valorUnitarioResultado: r?.valorUnitario || r?.valorUnitarioResultado,
        dataResultado: r?.dataVigenciaInicial || r?.dataInclusao
      }, { fonte: "Compras.gov.br - ARP", descricao: r?.descricaoItem || r?.descricao || "", uf: String(r?.estado || r?.uf || uf || "").toUpperCase(), orgao: r?.nomeOrgao || r?.orgao || "" });
    }
    comprasRows += arpRows.length;
  } else console.warn("Compras.gov ARP", secondary[1].reason?.message || secondary[1].reason);

  const list = [...suppliers.values()].map(s => {
    s.precoMedio = s._priceCount ? s._sum / s._priceCount : null;
    s.fontes = [...s.fontes];
    delete s._sum; delete s._priceCount;
    return s;
  });

  await Promise.all(list.slice(0, 120).map(async s => {
    s.telefone = await enrichPhone(s.cnpj);
    if (!s.telefone) s.telefone = "SEM TELEFONE PUBLICO";
  }));
  for (const s of list.slice(120)) s.telefone = "SEM TELEFONE PUBLICO";

  list.sort((a,b) => b.registros - a.registros || String(a.nome).localeCompare(String(b.nome), "pt-BR"));
  res.json({
    fonte: "PNCP (federal, estadual e municipal integrado) + Compras.gov.br + ARPs + dados cadastrais públicos para telefone",
    aviso: "Mapa próprio baseado em dados públicos. A cobertura depende dos registros disponíveis e da resposta das fontes no momento da pesquisa.",
    consulta:q, uf:uf||"TODAS", comprasAnalisadas:purchasesProcessed,
    totalResultadosBusca: searchPages.reduce((n,d)=>n+Number(d?.total||0),0), itensCorrespondentes:matchedItems.length,
    registrosComprasGov:comprasRows, totalFornecedores:list.length, totalMeEpp:list.filter(s=>s.meEpp).length,
    fornecedores:list, itens:matchedItems.slice(0,200), comprasDetalhadas:[...analyzedPurchases.values()]
  });
}


function buildPncpAtaLink(row) {
  // O PNCP não usa o número de controle inteiro diretamente na rota da tela.
  // Ex.: 45358249000101-1-000608/2026-000001 ->
  //      /app/atas/45358249000101/2026/608/1
  const control = String(row?.numero_controle_pncp || row?.numeroControlePNCP || row?.numero_controle_pncp_ata || "").trim();
  const m = control.match(/^(\d{14})-\d+-(\d+)\/(\d{4})-(\d+)$/);
  if (m) {
    const [, cnpj, sequencialCompra, ano, sequencialAta] = m;
    return `https://pncp.gov.br/app/atas/${cnpj}/${ano}/${Number(sequencialCompra)}/${Number(sequencialAta)}`;
  }
  if (row?.item_url) {
    const u = String(row.item_url);
    return u.startsWith("http") ? u : `https://pncp.gov.br${u.startsWith("/") ? u : "/" + u}`;
  }
  return null;
}

async function pncpAtaSearch(q, { pagina = 1, tamPagina = 50 } = {}) {
  const url = new URL(PNCP_SEARCH_BASE + "/");
  url.searchParams.set("q", q);
  url.searchParams.set("tipos_documento", "ata");
  url.searchParams.set("status", "vigente");
  url.searchParams.set("ordenacao", "-data");
  url.searchParams.set("pagina", String(pagina));
  url.searchParams.set("tam_pagina", String(Math.min(Math.max(tamPagina, 1), 50)));
  return fetchJson(url.toString(), { timeoutMs: 10000, retries: 1, cacheTtl: 5 * 60 * 1000 });
}

function parseAtaControl(control) {
  const m = String(control || "").trim().match(/^(\d{14})-1-(\d+)\/(\d{4})-(\d+)$/);
  if (!m) return null;
  return { orgao: m[1], ano: Number(m[3]), compra: Number(m[2]), ata: Number(m[4]) };
}

async function pncpGetAtaDetail(ata) {
  const url = `${cleanBase(PNCP_API_BASE)}/orgaos/${ata.orgao}/compras/${ata.ano}/${ata.compra}/atas/${ata.ata}`;
  return fetchJson(url, { timeoutMs: 9000, retries: 1, cacheTtl: 15 * 60 * 1000 });
}

async function findAtaSuppliers(ata, query) {
  if (!ata) return [];
  try {
    const items = pncpRows(await pncpGetItems(ata, 1));
    const variants = smartQueryVariants(query, 3);
    const matches = items.filter(item => descriptionMatchesAny(`${item?.descricao || item?.descricaoDetalhada || ""}`, variants)).slice(0, 8);
    const resultMap = new Map();
    await Promise.all(matches.map(async item => {
      const numeroItem = item?.numeroItem ?? item?.numero;
      if (numeroItem == null) return;
      try {
        const resultados = pncpRows(await pncpGetResults(ata, numeroItem));
        for (const r of resultados) {
          const cnpj = onlyDigits(r?.niFornecedor || r?.cnpjFornecedor || r?.codFornecedor || "");
          const nome = r?.nomeRazaoSocialFornecedor || r?.nomeFornecedor || r?.fornecedorNome || "";
          if (!cnpj && !nome) continue;
          const key = cnpj || normalizeText(nome);
          resultMap.set(key, {
            nome: nome || "Fornecedor não informado",
            cnpj: cnpj || null,
            item: item?.descricao || "",
            preco: Number.isFinite(Number(r?.valorUnitarioHomologado ?? r?.valorUnitarioResultado ?? r?.precoUnitario)) ? Number(r?.valorUnitarioHomologado ?? r?.valorUnitarioResultado ?? r?.precoUnitario) : null
          });
        }
      } catch (_) {}
    }));
    return [...resultMap.values()].slice(0, 8);
  } catch (_) { return []; }
}

async function comprasGovArpSearch(q, uf) {
  const endpoint = cleanBase(COMPRAS_BASE) + "/modulo-arp/2_consultarARPItem";
  const end = new Date();
  const begin = new Date(end.getTime() - 730 * 86400000);
  const fmt = d => d.toISOString().slice(0,10);
  const common = new URLSearchParams({
    pagina: "1", tamanhoPagina: "500",
    dataVigenciaInicial: fmt(begin), dataVigenciaFinal: fmt(end)
  });
  if (uf) common.set("estado", uf);
  const data = await fetchJson(endpoint + "?" + common.toString(), {timeoutMs:10000,retries:1,cacheTtl:5*60*1000});
  const rows = pncpRows(data);
  return rows.filter(r => descriptionMatches(`${r?.descricaoItem||r?.descricao||r?.nomeItem||""}`, q));
}

async function ataDetail(req, res) {
  await ensureJwt(req);
  const control = String(req.query.controle || req.query.numeroControlePNCP || "").trim();
  const parsed = parseAtaControl(control);
  if (!parsed) return res.status(400).json({ error: "Número de controle PNCP da ATA inválido." });
  try {
    const detail = await pncpGetAtaDetail(parsed);
    const items = pncpRows(await pncpGetItems(parsed, 1));
    const relevant = (await Promise.all(items.slice(0, 60).map(async item => {
      const numeroItem = item?.numeroItem ?? item?.numero;
      if (numeroItem == null) return null;
      try {
        const resultados = pncpRows(await pncpGetResults(parsed, numeroItem));
        return resultados.length ? { item, resultados } : null;
      } catch (_) { return null; }
    }))).filter(Boolean);
    const fornecedores = new Map();
    for (const group of relevant) for (const r of group.resultados) {
      const cnpj=onlyDigits(r?.niFornecedor||r?.cnpjFornecedor||r?.codFornecedor||"");
      const nome=r?.nomeRazaoSocialFornecedor||r?.nomeFornecedor||r?.fornecedorNome||"";
      if(!cnpj && !nome) continue;
      fornecedores.set(cnpj||normalizeText(nome), {
        nome:nome||"Fornecedor não informado", cnpj:cnpj||null, item:group.item?.descricao||group.item?.descricaoDetalhada||"",
        preco:Number.isFinite(Number(r?.valorUnitarioHomologado ?? r?.valorUnitarioResultado ?? r?.precoUnitario)) ? Number(r?.valorUnitarioHomologado ?? r?.valorUnitarioResultado ?? r?.precoUnitario) : null
      });
    }
    res.json({
      validacao:{status:"OK", mensagem:"Registro oficial da ATA localizado na API do PNCP."},
      controlePncp:control, link:buildPncpAtaLink({numero_controle_pncp:control}),
      ata:detail, itens:items, fornecedores:[...fornecedores.values()]
    });
  } catch (e) {
    res.status(e.status || 502).json({
      error:"O registro da ATA não respondeu à consulta detalhada do PNCP neste momento.",
      validacao:{status:"INSTÁVEL / INDISPONÍVEL", mensagem:e.message || "Falha na consulta detalhada."},
      controlePncp:control, link:buildPncpAtaLink({numero_controle_pncp:control})
    });
  }
}

async function ataMap(req, res) {
  await ensureJwt(req);
  const q = String(req.query.q || "").trim();
  if (q.length < 3) return res.status(400).json({error:"Informe pelo menos 3 caracteres para pesquisar a ata."});
  const uf = String(req.query.uf || "").trim().toUpperCase();
  const adesaoOnly = String(req.query.adesao || "true").toLowerCase() !== "false";
  const paginas = Math.min(Math.max(Number(req.query.paginas || 4),1),6);
  const variants = smartQueryVariants(q, 2);
  const atas = new Map();
  const warnings = [];

  const jobs = [];
  for (const variant of variants) for (let i=1;i<=paginas;i++) {
    jobs.push(pncpAtaSearch(variant,{pagina:i,tamPagina:50}).catch(e=>{warnings.push(`PNCP: ${e.message}`);return null;}));
  }
  const pages = await Promise.all(jobs);
  for(const data of pages){
    for(const r of pncpRows(data)){
      const desc = r?.description || r?.descricao || r?.objeto || r?.title || r?.objetoCompra || "";
      if(!descriptionMatchesAny(desc, variants)) continue;
      const rowUf=String(r?.uf||r?.ufSigla||r?.estado||r?.unidade_federativa||r?.localCompraUf||"").toUpperCase();
      if(uf && rowUf && rowUf!==uf) continue;
      const permite = r?.permiteAdesao ?? r?.possibilidadeAdesao ?? r?.permite_adesao ?? r?.permiteAdesaoAta ?? r?.adesao;
      if(adesaoOnly && permite === false) continue;
      if(adesaoOnly && permite == null) continue;
      const control=r?.numero_controle_pncp || r?.numeroControlePNCP || r?.numeroControle || r?.id || "";
      const key=String(control || r?.item_url || `${r?.numero||""}-${r?.ano||""}-${r?.orgao_cnpj||""}`);
      const parsed=parseAtaControl(control);
      atas.set(key,{
        fonte:"PNCP", numero:r?.numero||r?.numeroAta||r?.numero_ata||r?.numeroAtaRegistroPreco||"—", ano:r?.ano||r?.anoAta||"",
        controlePncp:control||"—", descricao:desc,
        orgao:r?.orgao_nome||r?.orgao_razao_social||r?.orgao||r?.orgaoCompra||"—", uf:rowUf||"—",
        permiteAdesao: permite === true || String(permite).toLowerCase()==="true",
        dataPublicacao:r?.createdAt||r?.data_publicacao||r?.dataPublicacao||r?.dataPublicacaoPncp||null,
        vigenciaInicio:r?.data_vigencia_inicial||r?.dataVigenciaInicial||r?.dataVigenciaInicio||null,
        vigenciaFim:r?.data_vigencia_final||r?.dataVigenciaFinal||r?.dataVigenciaFim||null,
        link:buildPncpAtaLink({numero_controle_pncp:control,item_url:r?.item_url}), itemUrl:r?.item_url||null,
        fornecedor:r?.fornecedor_nome||r?.nomeFornecedor||null, cnpjFornecedor:r?.cnpjFornecedor||r?.niFornecedor||null,
        origemPortal:r?.descricao||r?.title||null, _parsed:parsed,
        validacao: parsed ? {status:"PENDENTE", mensagem:"Validando registro oficial da ATA no PNCP..."} : {status:"NÃO VALIDADA", mensagem:"Número de controle PNCP não pôde ser interpretado."}
      });
    }
  }

  // Enriquecimento: consulta oficial da ata para vigência/adesão e os resultados
  // do item da contratação para recuperar fornecedor/CNPJ quando a busca textual não os trouxe.
  const ataList=[...atas.values()];
  let cursor=0;
  async function worker(){
    while(true){
      const idx=cursor++; if(idx>=ataList.length) return;
      const a=ataList[idx];
      if(a._parsed){
        try{
          const d=await pncpGetAtaDetail(a._parsed);
          a.numero=d?.numeroAtaRegistroPreco || a.numero;
          a.ano=d?.anoAta || a.ano;
          a.vigenciaInicio=d?.dataVigenciaInicio || a.vigenciaInicio;
          a.vigenciaFim=d?.dataVigenciaFim || a.vigenciaFim;
          a.dataPublicacao=d?.dataPublicacaoPncp || a.dataPublicacao;
          a.permiteAdesao=d?.possibilidadeAdesao ?? a.permiteAdesao;
          a.orgao=d?.orgaoCompra || a.orgao;
          const local=String(d?.localCompra||"");
          if(!a.uf && local) a.uf=(local.match(/\b([A-Z]{2})\b$/)||[])[1]||a.uf;
          a.descricao=d?.objetoCompra || a.descricao;
          a.validacao={status:"OK", mensagem:"Registro oficial da ATA localizado na API do PNCP."};
        }catch(e){
          a.validacao={status:"INSTÁVEL / INDISPONÍVEL", mensagem:"O registro da ATA não respondeu à consulta detalhada do PNCP neste momento."};
          warnings.push(`Detalhe PNCP: ${a.numero || a.controlePncp} (${e.message})`);
        }
        if(!a.fornecedor){
          const suppliers=await findAtaSuppliers(a._parsed,q);
          if(suppliers.length){
            a.fornecedor=suppliers.map(x=>x.nome).join("; ");
            a.cnpjFornecedor=suppliers.map(x=>x.cnpj).filter(Boolean).join("; ");
            a.fornecedores=suppliers;
          }
        }
      }
      delete a._parsed;
    }
  }
  await Promise.all(Array.from({length:10},worker));

  try{
    const arpRows=await comprasGovArpSearch(q,uf);
    for(const r of arpRows){
      const desc=r?.descricaoItem||r?.descricao||r?.nomeItem||"";
      const key=`compras-${r?.numeroAta||r?.numero_ata||""}-${r?.unidadeGerenciadora||r?.codigoUnidadeGerenciadora||""}-${r?.numeroItem||""}`;
      if(atas.has(key)) continue;
      const controle=r?.numeroControlePncp||r?.numeroControlePNCP||"";
      atas.set(key,{
        fonte:"Compras.gov.br", numero:r?.numeroAta||r?.numero_ata||"—", ano:r?.ano||"", controlePncp:controle||"—",
        descricao:desc, orgao:r?.nomeOrgao||r?.orgao||"—", uf:String(r?.estado||r?.uf||uf||"").toUpperCase(),
        permiteAdesao:r?.permiteAdesao ?? null, dataPublicacao:r?.dataInclusao||null,
        vigenciaInicio:r?.dataVigenciaInicial||null, vigenciaFim:r?.dataVigenciaFinal||null,
        link:buildPncpAtaLink({numeroControlePNCP:controle}), fornecedor:r?.nomeFornecedor||null,
        cnpjFornecedor:r?.cnpjFornecedor||r?.codFornecedor||null, item:r?.numeroItem||null,
        quantidade:r?.quantidadeRegistrada||r?.quantidade||null, saldo:r?.saldo||null
      });
    }
  }catch(e){warnings.push(`Compras.gov.br: ${e.message}`);}

  const list=[...atas.values()].filter(a=>!uf||!a.uf||a.uf===uf).filter(a=>!adesaoOnly || a.permiteAdesao===true);
  list.sort((a,b)=>String(b.vigenciaFim||b.dataPublicacao||"").localeCompare(String(a.vigenciaFim||a.dataPublicacao||"")));
  res.json({consulta:q,uf:uf||"TODAS", somenteComAdesao:adesaoOnly,totalAtas:list.length,atas:list,warnings,
    fonte:"PNCP + Compras.gov.br", observacao:"A indicação de adesão e a vigência vêm dos registros públicos consultados. A disponibilidade efetiva de saldo, limites e autorização para adesão deve ser confirmada no documento da ata e com o órgão gerenciador."});
}

app.post("/api/auth/login", asyncRoute(async (req, res) => {
  const body = req.body || {};
  const usuarioApiToken = String(body.usuarioApiToken ?? body.token ?? "").trim();
  if (!usuarioApiToken) return res.status(400).json({ error: "Informe o usuarioApiToken." });
  req.session.apiToken = usuarioApiToken;
  req.session.jwt = null;
  req.session.jwtExpiresAt = 0;
  try {
    await ensureJwt(req);
    await new Promise((resolve, reject) => req.session.save(err => err ? reject(err) : resolve()));
    recordLogin(req);
    res.json({ ok: true, message: "Autenticado com sucesso. JWT válido por até 8 horas." });
  } catch (err) {
    req.session.apiToken = null; req.session.jwt = null; req.session.jwtExpiresAt = 0;
    await new Promise(resolve => req.session.save(() => resolve()));
    throw err;
  }
}));

app.post("/api/auth/logout", asyncRoute(async (req, res) => {
  const row = accessLog.get(req.sessionID);
  if (row) { row.logoutAt = Date.now(); row.lastSeenAt = row.logoutAt; row.status = "SAIU"; }
  req.session.destroy(() => res.json({ ok: true }));
}));
app.post("/api/auth/heartbeat", asyncRoute(async (req, res) => {
  if (!req.session.apiToken || !req.session.jwt) return res.status(401).json({ error: "Não autenticado" });
  touchAccess(req);
  res.json({ ok: true, serverTime: Date.now() });
}));
app.get("/api/auth/status", asyncRoute(async (req, res) => {
  if (req.session.apiToken) await ensureJwt(req);
  touchAccess(req);
  res.json({ authenticated: !!req.session.apiToken && !!req.session.jwt, jwtValidUntil: req.session.jwtExpiresAt || null });
}));
app.get("/api/painel/acessos", asyncRoute(async (req, res) => {
  await ensureJwt(req);
  res.json({ acessos: accessRows(), inatividadeMs: ACCESS_INACTIVE_MS });
}));

app.get("/api/cotacoes", asyncRoute(async (req, res) => res.json(await authenticatedCall(req, "/api/bp4/Cotacoes/GetCotacoes"))));
app.get("/api/cotacoes/completa", asyncRoute(async (req, res) => { const id = Number(req.query.IdCotacao); if (!Number.isInteger(id)) return res.status(400).json({ error: "IdCotacao é obrigatório." }); res.json(await authenticatedCall(req, `/api/bp4/Cotacoes/GetCotacaoCompleta?IdCotacao=${encodeURIComponent(id)}`)); }));
app.get("/api/cotacoes/lotes", asyncRoute(async (req, res) => { const id = Number(req.query.IdCotacao); if (!Number.isInteger(id)) return res.status(400).json({ error: "IdCotacao é obrigatório." }); res.json(await authenticatedCall(req, `/api/bp4/Cotacoes/GetCotacoesLotes?IdCotacao=${encodeURIComponent(id)}`)); }));
app.get("/api/cotacoes/itens", asyncRoute(async (req, res) => { const id = Number(req.query.IdCotacao); if (!Number.isInteger(id)) return res.status(400).json({ error: "IdCotacao é obrigatório." }); res.json(await authenticatedCall(req, `/api/bp4/Cotacoes/GetCotacoesItens?IdCotacao=${encodeURIComponent(id)}`)); }));
app.get("/api/cotacoes/precos", asyncRoute(async (req, res) => { const id = Number(req.query.IdItem); if (!Number.isInteger(id)) return res.status(400).json({ error: "IdItem é obrigatório." }); res.json(await authenticatedCall(req, `/api/bp4/Cotacoes/GetCotacoesPrecosItens?IdItem=${encodeURIComponent(id)}`)); }));
app.post("/api/cotacoes", asyncRoute(async (req, res) => res.json(await authenticatedCall(req, "/api/bp4/Cotacoes/CriarCotacoes", { method: "POST", body: req.body || {} }))));
app.post("/api/cotacoes/itens", asyncRoute(async (req, res) => res.json(await authenticatedCall(req, "/api/bp4/Cotacoes/CriarItens", { method: "POST", body: req.body || {} }))));
app.get("/api/catalogos/unidades", asyncRoute(async (req, res) => res.json(await authenticatedCall(req, "/api/bp4/Cotacoes/GetTodasUnidadeMedida"))));
app.get("/api/catalogos/cidades", asyncRoute(async (req, res) => res.json(await authenticatedCall(req, "/api/bp4/Cotacoes/GetTodasCidades"))));
app.get("/api/fornecedores/mapa", asyncRoute(supplierMap));
app.get("/api/atas/mapa", asyncRoute(ataMap));
app.get("/api/atas/detalhe", asyncRoute(ataDetail));

app.listen(PORT, () => console.log(`BP4 Site rodando em http://localhost:${PORT}`));
