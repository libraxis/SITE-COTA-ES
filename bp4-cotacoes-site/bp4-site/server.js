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

function cleanBase(url) { return url.replace(/\/+$/, ""); }
function reqToken(req) { return req.session && req.session.jwt; }

async function fetchJson(url, options = {}) {
  const timeoutMs = Number(options.timeoutMs || 12000);
  const retries = Number(options.retries ?? 2);
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        method: options.method || "GET",
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
        return data;
      }
    } catch (err) {
      lastErr = err.name === "AbortError" ? new Error(`Tempo limite ao consultar fonte externa (${timeoutMs/1000}s).`) : err;
      if (attempt >= retries) break;
    } finally { clearTimeout(timer); }
    const wait = Math.min(1500 * (attempt + 1), 3500) + Math.floor(Math.random()*250);
    await new Promise(r => setTimeout(r, wait));
  }
  throw lastErr || new Error("Falha de comunicação com a fonte externa.");
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
  return fetchJson(url);
}

async function pncpGetResults(purchase, numeroItem) {
  const url = `${cleanBase(PNCP_API_BASE)}/orgaos/${purchase.orgao}/compras/${purchase.ano}/${purchase.compra}/itens/${encodeURIComponent(numeroItem)}/resultados`;
  return fetchJson(url);
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
  const maxCompras = Math.min(Math.max(Number(req.query.maxCompras || 30), 20), 50);

  const suppliers = new Map();
  const matchedItems = [];
  const purchasesSeen = new Set();
  let purchasesProcessed = 0;
  let searchPages = [];

  // Search several PNCP pages in parallel: this is much faster than the old
  // one-page/one-purchase sequential flow and gives the map a larger sample.
  try {
    searchPages = await Promise.all(Array.from({length:4}, (_,i) =>
      pncpSearch(q, { uf, pagina:i+1, tamPagina:50 }).catch(err => { console.warn("PNCP busca", i+1, err.message); return null; })
    ));
  } catch (_) {}

  const searchItems = searchPages.flatMap(d => Array.isArray(d?.items) ? d.items : []);
  const purchases = [];
  for (const result of searchItems) {
    const purchase = parsePurchaseUrl(result?.item_url);
    if (!purchase) continue;
    const key = `${purchase.orgao}-${purchase.ano}-${purchase.compra}`;
    if (purchasesSeen.has(key)) continue;
    purchasesSeen.add(key);
    purchases.push({ purchase, result, key });
    if (purchases.length >= maxCompras) break;
  }

  // Small concurrency pool. A single failed purchase is discarded, not fatal.
  let cursor = 0;
  async function worker() {
    while (true) {
      const idx = cursor++;
      if (idx >= purchases.length) return;
      const {purchase,result,key} = purchases[idx];
      try {
        let items = await pncpGetItems(purchase, 1);
        let rows = Array.isArray(items) ? items : [];
        let matches = rows.filter(item => descriptionMatches(item?.descricao, q) && item?.temResultado !== false && (item?.numeroItem ?? item?.numero) != null).slice(0, 12);
        if (!matches.length && rows.length >= 50) {
          try { const page2 = await pncpGetItems(purchase, 2); const rows2 = Array.isArray(page2) ? page2 : []; rows = rows.concat(rows2); matches = rows2.filter(item => descriptionMatches(item?.descricao, q) && item?.temResultado !== false && (item?.numeroItem ?? item?.numero) != null).slice(0, 12); } catch (_) {}
        }
        await Promise.all(matches.map(async item => {
          const numeroItem = item?.numeroItem ?? item?.numero;
          try {
            const resultados = await pncpGetResults(purchase, numeroItem);
            if (!Array.isArray(resultados) || !resultados.length) return;
            for (const r of resultados) await mapSupplierRecord(suppliers, r, {
              fonte: "PNCP", descricao:item.descricao, orgao:result?.orgao_nome || "", uf:result?.uf || result?.ufSigla || uf || "",
              link:`https://pncp.gov.br/app/editais/${purchase.orgao}/${purchase.ano}/${purchase.compra}`
            });
            matchedItems.push({ descricao:item.descricao, compra:key, numeroItem, quantidade:item.quantidade, unidade:item.unidadeMedida, resultados:resultados.length });
          } catch (err) { console.warn("PNCP resultados", key, numeroItem, err.message); }
        }));
      } catch (err) { console.warn("PNCP itens", key, err.message); }
      purchasesProcessed++;
    }
  }
  await Promise.all(Array.from({length:10}, worker));

  // Secondary federal source. It is deliberately best-effort and never blocks
  // the main map when Compras.gov.br is unstable.
  let comprasRows = 0;
  try { comprasRows = await comprasGovRecentSearch(q, uf, suppliers); } catch (err) { console.warn("Compras.gov", err.message); }

  const list = [...suppliers.values()].map(s => {
    s.precoMedio = s._priceCount ? s._sum / s._priceCount : null;
    s.fontes = [...s.fontes];
    delete s._sum; delete s._priceCount;
    return s;
  });

  // Phone enrichment is parallel and capped so it never becomes the bottleneck.
  await Promise.all(list.slice(0, 80).map(async s => {
    s.telefone = await enrichPhone(s.cnpj);
    if (!s.telefone) s.telefone = "SEM TELEFONE PUBLICO";
  }));
  for (const s of list.slice(80)) s.telefone = "SEM TELEFONE PUBLICO";

  list.sort((a,b) => b.registros - a.registros || String(a.nome).localeCompare(String(b.nome), "pt-BR"));
  res.json({
    fonte: "PNCP + Compras.gov.br + dados cadastrais públicos para telefone",
    aviso: "Mapa próprio baseado em dados públicos. A cobertura depende dos registros disponíveis e da resposta das fontes no momento da pesquisa.",
    consulta:q, uf:uf||"TODAS", comprasAnalisadas:purchasesProcessed,
    totalResultadosBusca: searchPages.reduce((n,d)=>n+Number(d?.total||0),0), itensCorrespondentes:matchedItems.length,
    registrosComprasGov:comprasRows, totalFornecedores:list.length, totalMeEpp:list.filter(s=>s.meEpp).length,
    fornecedores:list, itens:matchedItems.slice(0,100)
  });
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
    res.json({ ok: true, message: "Autenticado com sucesso. JWT válido por até 8 horas." });
  } catch (err) {
    req.session.apiToken = null; req.session.jwt = null; req.session.jwtExpiresAt = 0;
    await new Promise(resolve => req.session.save(() => resolve()));
    throw err;
  }
}));

app.post("/api/auth/logout", asyncRoute(async (req, res) => { req.session.destroy(() => res.json({ ok: true })); }));
app.get("/api/auth/status", asyncRoute(async (req, res) => {
  if (req.session.apiToken) await ensureJwt(req);
  res.json({ authenticated: !!req.session.apiToken && !!req.session.jwt, jwtValidUntil: req.session.jwtExpiresAt || null });
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

app.listen(PORT, () => console.log(`BP4 Site rodando em http://localhost:${PORT}`));
