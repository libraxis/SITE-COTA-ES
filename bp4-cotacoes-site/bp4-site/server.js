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
const CNPJ_BIZ_BASE = process.env.CNPJ_BIZ_URL || "https://cnpj.biz";
const CNPJ_WS_BASE = process.env.CNPJ_WS_URL || "https://publica.cnpj.ws/cnpj";
const CNPJ_BIZ_API_KEY = process.env.CNPJ_BIZ_API_KEY || "";
const CNPJ_IA_API_KEY = process.env.CNPJ_IA_API_KEY || process.env.CNPJ_API_KEY || "";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_CONTACT_MODEL = process.env.OPENAI_CONTACT_MODEL || "gpt-5.6-luna";
const SERPER_API_KEY = process.env.SERPER_API_KEY || "";
const GOOGLE_CSE_API_KEY = process.env.GOOGLE_CSE_API_KEY || "";
const GOOGLE_CSE_ID = process.env.GOOGLE_CSE_ID || "";
const CONTACT_SEARCH_MAX = Number(process.env.CONTACT_SEARCH_MAX || 200);
const CONTACT_SEARCH_TIMEOUT = Number(process.env.CONTACT_SEARCH_TIMEOUT || 12000);
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


async function fetchText(url, options = {}) {
  const timeoutMs = Number(options.timeoutMs || 10000);
  const retries = Number(options.retries ?? 1);
  const useCache = options.cache !== false;
  const cacheTtl = Number(options.cacheTtl ?? (24 * 60 * 60 * 1000));
  const cacheKey = `TEXT:${url}`;
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
          method: "GET",
          headers: { "Accept": "text/html,application/xhtml+xml,text/plain,*/*", "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130 Safari/537.36" },
          signal: controller.signal
        });
        const text = await response.text();
        if (!response.ok) {
          const err = new Error(`HTTP ${response.status}`); err.status = response.status;
          if (![408,429,500,502,503,504].includes(response.status) || attempt >= retries) throw err;
          lastErr = err;
        } else {
          return useCache ? cacheSet(cacheKey, text, cacheTtl) : text;
        }
      } catch (err) {
        lastErr = err.name === "AbortError" ? new Error(`Tempo limite ao consultar ${url}`) : err;
        if (attempt >= retries) break;
      } finally { clearTimeout(timer); }
      await new Promise(r => setTimeout(r, Math.min(500 * (attempt + 1), 1200)));
    }
    throw lastErr || new Error("Falha ao consultar página externa.");
  })();
  if (useCache) {
    httpInflight.set(cacheKey, run);
    try { return await run; } finally { httpInflight.delete(cacheKey); }
  }
  return run;
}

function decodeHtmlEntities(s) {
  return String(s || "").replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&quot;/gi, '"').replace(/&#39;/gi, "'").replace(/&#x27;/gi, "'").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">");
}

function extractPublicContactsFromCnpjBiz(html) {
  const raw = decodeHtmlEntities(String(html || "").replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " "));
  const emails = [...new Set((raw.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [])
    .map(x => x.toLowerCase()).filter(x => !/example|emailprotected|sentry|wix|cloudflare/.test(x)))];
  const phones = [...new Set((raw.match(/(?:\+?55\s*)?(?:\(?\d{2}\)?\s*)?(?:9\s*)?\d{4}[\s.-]?\d{4}/g) || [])
    .map(x => x.replace(/\s+/g, " ").trim())
    .filter(x => x.replace(/\D/g, "").length >= 10 && x.replace(/\D/g, "").length <= 13))];
  return { email: emails[0] || null, telefone: phones[0] || null };
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


function cleanEmail(value) {
  const m = String(value || "").toLowerCase().match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i);
  if (!m) return null;
  const e = m[0].replace(/[.,;:]+$/, "");
  if (/example|emailprotected|sentry|cloudflare|wix|noreply|no-reply/i.test(e)) return null;
  return e;
}
function cleanPhone(value) {
  const raw = String(value || "");
  const candidates = raw.match(/(?:\+?55\s*)?(?:\(?\d{2}\)?\s*)?(?:9\s*)?\d{4}[\s.-]?\d{4}/g) || [];
  for (const c of candidates) {
    const digits = c.replace(/\D/g, "");
    if (digits.length >= 10 && digits.length <= 13) return c.trim();
  }
  return null;
}


function extractContactsFromText(text) {
  const raw = decodeHtmlEntities(String(text || "").replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " "));
  const emails = [...new Set((raw.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [])
    .map(x => cleanEmail(x)).filter(Boolean))];
  const phones = [...new Set((raw.match(/(?:\+?55\s*)?(?:\(?\d{2}\)?\s*)?(?:9\s*)?\d{4}[\s.-]?\d{4}/g) || [])
    .map(x => cleanPhone(x)).filter(Boolean))];
  return { email: emails[0] || null, telefone: phones[0] || null, emails, telefones: phones };
}

function contactBelongsToCnpj(text, cnpj) {
  const digits = onlyDigits(cnpj);
  const compact = String(text || "").replace(/\D/g, "");
  return digits.length === 14 && compact.includes(digits);
}

async function fetchPublicContactPages(cnpj, nome) {
  const digits = onlyDigits(cnpj);
  const q = encodeURIComponent(`"${digits}" "${String(nome || "")}"`);
  const urls = [
    `https://www.google.com/search?q=${q}`,
    `https://www.google.com/search?q=${encodeURIComponent(`"${digits}" telefone email`)}`,
    `https://www.bing.com/search?q=${q}`,
    `https://html.duckduckgo.com/html/?q=${q}`,
    `https://www.cnpjbiz.com.br/${digits}`,
    `https://cnpj.biz/${digits}`,
    `https://casadosdados.com.br/solucao/cnpj/${digits}`,
    `https://radarpj.com/cnpj/${digits}`,
    `https://breela.com.br/cnpj/${digits}`
  ];
  const out = { telefone:null, email:null, fonte:null, paginas:[] };
  const headers = {
    "User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36",
    "Accept":"text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language":"pt-BR,pt;q=0.9,en;q=0.7"
  };
  const results = await Promise.allSettled(urls.map(u => fetchText(u, { cacheTtl: 24*60*60*1000, timeoutMs: CONTACT_SEARCH_TIMEOUT, retries:0, headers })));
  for (let i=0;i<results.length;i++) {
    if (results[i].status !== "fulfilled") continue;
    const html = String(results[i].value || "");
    const text = html.replace(/<[^>]+>/g, " ");
    const c = extractContactsFromText(`${html}\n${text}`);
    if (!c.email && !c.telefone) continue;
    // Para páginas de busca, exige que o CNPJ apareça no conteúdo; para páginas diretas,
    // o próprio endereço já contém o CNPJ. Isso reduz falsos positivos.
    const valid = contactBelongsToCnpj(html, digits) || /cnpj\.biz|casadosdados|radarpj|breela/i.test(urls[i]);
    if (!valid) continue;
    if (!out.email && c.email) out.email = c.email;
    if (!out.telefone && c.telefone) out.telefone = c.telefone;
    if ((c.email || c.telefone) && !out.fonte) out.fonte = urls[i];
    out.paginas.push(urls[i]);
    if (out.email && out.telefone) break;
  }
  return out;
}

async function googleSearchContacts(cnpj, nome) {
  const q = `"${cnpj}" "${String(nome || "")}" telefone email contato`;
  // Google Programmable Search (para contas existentes/configuradas).
  if (GOOGLE_CSE_API_KEY && GOOGLE_CSE_ID) {
    try {
      const u = new URL("https://www.googleapis.com/customsearch/v1");
      u.searchParams.set("key", GOOGLE_CSE_API_KEY); u.searchParams.set("cx", GOOGLE_CSE_ID); u.searchParams.set("q", q); u.searchParams.set("num", "10"); u.searchParams.set("hl", "pt-BR");
      const data = await fetchJson(u.toString(), { cacheTtl: 24*60*60*1000, timeoutMs: 10000, retries: 0 });
      return (data?.items || []).map(x => ({ title:x.title, link:x.link, snippet:x.snippet })).filter(x => x.link || x.snippet);
    } catch (_) {}
  }
  // Serper é uma alternativa para resultados do Google quando configurada.
  if (SERPER_API_KEY) {
    try {
      const data = await fetchJson("https://google.serper.dev/search", { method:"POST", cache:false, timeoutMs:10000, retries:0, headers:{"X-API-KEY":SERPER_API_KEY,"Content-Type":"application/json"}, body:JSON.stringify({q, gl:"br", hl:"pt-br", num:10}) });
      return (data?.organic || []).map(x => ({ title:x.title, link:x.link, snippet:x.snippet })).filter(x => x.link || x.snippet);
    } catch (_) {}
  }
  return [];
}

async function aiSearchContacts(cnpj, nome, searchResults = []) {
  if (!OPENAI_API_KEY) return null;
  const searchText = searchResults.slice(0,10).map((r,i)=>`RESULTADO ${i+1}\nTITULO: ${r.title||""}\nURL: ${r.link||""}\nTRECHO: ${r.snippet||""}`).join("\n\n");
  const prompt = `Você está enriquecendo dados públicos de uma empresa brasileira.\nCNPJ: ${cnpj}\nRazão social/nome: ${nome || "não informado"}\n\nPesquise na web por esta empresa usando o CNPJ exato e identifique SOMENTE telefone e e-mail de contato publicamente exibidos e que pertençam à empresa. Priorize site oficial, página de contato, CNPJ.BIZ e diretórios empresariais confiáveis. Não invente, não deduza e não use dados de outra empresa. Se houver conflito, prefira o contato associado ao CNPJ exato.\n\nResultados de busca já encontrados:\n${searchText || "(nenhum)"}\n\nResponda SOMENTE JSON válido no formato: {"telefone":"... ou null","email":"... ou null","fonte":"URL da fonte ou null","confianca":"alta|media|baixa|nenhuma"}.`;
  try {
    const data = await fetchJson("https://api.openai.com/v1/responses", { method:"POST", cache:false, timeoutMs:25000, retries:0, headers:{"Authorization":`Bearer ${OPENAI_API_KEY}`,"Content-Type":"application/json"}, body:JSON.stringify({model:OPENAI_CONTACT_MODEL,tools:[{type:"web_search"}],input:prompt,store:false}) });
    const text = String(data?.output_text || "");
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const obj = JSON.parse(m[0]);
    return { telefone:cleanPhone(obj.telefone), email:cleanEmail(obj.email), fonte:obj.fonte || null, confianca:obj.confianca || "nenhuma" };
  } catch (_) { return null; }
}

async function aiEnrichCompanyContacts(cnpj, nome) {
  const results = await googleSearchContacts(cnpj, nome);
  const direct = { telefone:null, email:null, fonte:null, confianca:"nenhuma" };
  for (const r of results) {
    const e=cleanEmail(`${r.title||""} ${r.snippet||""}`), p=cleanPhone(`${r.title||""} ${r.snippet||""}`);
    if (!direct.email && e) direct.email=e; if (!direct.telefone && p) direct.telefone=p;
    if ((e||p) && !direct.fonte) direct.fonte=r.link||null;
  }
  if (direct.telefone && direct.email) return direct;
  const ai = await aiSearchContacts(cnpj, nome, results);
  return { telefone:direct.telefone||ai?.telefone||null, email:direct.email||ai?.email||null, fonte:direct.fonte||ai?.fonte||null, confianca:ai?.confianca||((direct.telefone||direct.email)?"media":"nenhuma") };
}

async function comprasGovFornecedor(cnpj) {
  const digits = onlyDigits(cnpj);
  if (digits.length !== 14) return null;
  try {
    const url = `${COMPRAS_BASE}/modulo-fornecedor/1_consultarFornecedor?pagina=1&tamanhoPagina=10&cnpj=${encodeURIComponent(digits)}`;
    const data = await fetchJson(url, { cacheTtl: 24 * 60 * 60 * 1000, timeoutMs: 9000, retries: 1 });
    const rows = Array.isArray(data) ? data : (data?.resultado || data?.data || data?.content || []);
    return Array.isArray(rows) ? (rows.find(x => onlyDigits(x?.cnpj || x?.niFornecedor || x?.numeroInscricao || "") === digits) || rows[0] || null) : null;
  } catch (_) { return null; }
}

async function enrichCompanyContacts(cnpj, nome = "", options = {}) {
  const digits = onlyDigits(cnpj);
  if (digits.length !== 14) return { telefone: null, email: null, fonteContato: null, cnpjUrl: null, fontesConsultadas: [] };
  const result = { telefone: null, email: null, fonteContato: null, fonteWeb: null, confiancaContato: "nenhuma", nome: nome || null, cnpjUrl: `${cleanBase(CNPJ_BIZ_BASE)}/${digits}`, fontesConsultadas: [] };

  const addContact = (phone, email, source) => {
    const p = Array.isArray(phone) ? phone.filter(Boolean).join(" / ") : phone;
    if (!result.telefone && p) result.telefone = String(p).trim();
    if (!result.email && email) result.email = String(email).trim();
    if ((p || email) && !result.fonteContato) result.fonteContato = source;
    if (source && !result.fontesConsultadas.includes(source)) result.fontesConsultadas.push(source);
  };

  // 0) Cadastro oficial de fornecedor do Compras.gov.br.
  // O endpoint é filtrável por CNPJ e serve como primeira validação do fornecedor.
  try {
    const data = await comprasGovFornecedor(digits);
    if (data) {
      addContact(
        data?.telefone || data?.telefoneFornecedor || data?.dddTelefone || data?.ddd_telefone_1 || data?.ddd_telefone_2,
        data?.email || data?.emailFornecedor || data?.correioEletronico || data?.correio_eletronico,
        "Compras.gov.br / cadastro do fornecedor"
      );
      if (!result.nome) result.nome = data?.nomeRazaoSocial || data?.razaoSocial || data?.nomeFornecedor || null;
    }
  } catch (_) {}

  // 1) BrasilAPI: rápida e sem chave.
  try {
    const data = await fetchJson(`${cleanBase(BRASIL_API_BASE)}/${digits}`, { cacheTtl: 24 * 60 * 60 * 1000, timeoutMs: 7000, retries: 1 });
    addContact(
      data?.ddd_telefone_1 || data?.ddd_telefone_2 || data?.telefone || data?.estabelecimento?.telefone1 || data?.estabelecimento?.telefone2,
      data?.email || data?.correio_eletronico || data?.emailContato || data?.estabelecimento?.email,
      "BrasilAPI / dados cadastrais"
    );
  } catch (_) {}

  // 2) CNPJ.ws público: outra base independente. O serviço gratuito limita a 3 consultas/minuto;
  // por isso só usamos como fallback e respeitamos a lentidão em vez de disparar dezenas de chamadas.
  if (!result.telefone || !result.email) {
    try {
      const data = await fetchJson(`${cleanBase(CNPJ_WS_BASE)}/${digits}`, { cacheTtl: 24 * 60 * 60 * 1000, timeoutMs: 7000, retries: 0 });
      const e = data?.estabelecimento || {};
      addContact(
        [e.ddd1, e.telefone1].filter(Boolean).join(" ") || [e.ddd2, e.telefone2].filter(Boolean).join(" "),
        e.email,
        "CNPJ.ws / dados públicos"
      );
    } catch (_) {}
  }

  // 3) CNPJ.BIZ API, se uma chave for configurada no Render. A API aceita até 100 CNPJs por lote;
  // a chave fica somente no backend e nunca vai para o navegador.
  if ((!result.telefone || !result.email) && CNPJ_BIZ_API_KEY) {
    try {
      const data = await fetchJson(`${cleanBase(CNPJ_BIZ_BASE)}/api/v2/empresas/cnpj`, {
        method: "POST", cache: false, timeoutMs: 9000, retries: 1,
        headers: { "Authorization": `Bearer ${CNPJ_BIZ_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ cnpj: digits })
      });
      const item = Array.isArray(data) ? data[0] : data;
      addContact(item?.telefones || item?.telefone || item?.ddd_telefone_1 || item?.ddd_telefone_2, item?.email || item?.correio_eletronico, "CNPJ.BIZ API");
    } catch (_) {}
  }

  // 4) CNPJ.IA/Oportunidados, se a chave estiver configurada. O perfil full retorna telefones e e-mail.
  if ((!result.telefone || !result.email) && CNPJ_IA_API_KEY) {
    try {
      const data = await fetchJson(`https://api.cnpj.ia.br/v1/cnpjs/${digits}?profile=full`, {
        cacheTtl: 24 * 60 * 60 * 1000, timeoutMs: 9000, retries: 1,
        headers: { "Authorization": `Bearer ${CNPJ_IA_API_KEY}` }
      });
      const item = data?.data || data;
      addContact(item?.telefones?.map?.(x => `${x.ddd || ""}${x.numero || ""}`) || item?.telefones, item?.email, "CNPJ.IA / base cadastral enriquecida");
    } catch (_) {}
  }

  // 5) Página pública do CNPJ.BIZ. É justamente a página que o usuário consegue abrir
  // manualmente e que, em muitos casos, contém telefone/e-mail mesmo quando as APIs
  // cadastrais anteriores não os retornam. O HTML é consultado somente como fallback.
  if (!result.telefone || !result.email) {
    try {
      const html = await fetchText(`${cleanBase(CNPJ_BIZ_BASE)}/${digits}`, { cacheTtl: 24 * 60 * 60 * 1000, timeoutMs: 8000, retries: 1 });
      const found = extractPublicContactsFromCnpjBiz(html);
      addContact(found.telefone, found.email, "CNPJ.BIZ / página pública");
    } catch (_) {}
  }

  // 6) Pesquisa em páginas públicas e motores de busca. Não depende de chave Google.
  // O CNPJ exato é usado como âncora para evitar confundir empresas homônimas.
  if ((!result.telefone || !result.email) && options.allowPublicSearch !== false) {
    try {
      const web = await fetchPublicContactPages(digits, result.nome || nome || "");
      addContact(web.telefone, web.email, web.fonte ? `Pesquisa pública / ${web.fonte}` : "Pesquisa pública");
      if (web.fonte) result.fonteWeb = web.fonte;
    } catch (_) {}
  }

  // 7) Pesquisa web + IA para os casos que continuam sem contato.
  // O Google é usado quando GOOGLE_CSE_* ou SERPER_API_KEY estiver configurado;
  // a IA também pode pesquisar a web diretamente quando OPENAI_API_KEY estiver disponível.
  if (options.allowAi !== false && (!result.telefone || !result.email) && (OPENAI_API_KEY || (GOOGLE_CSE_API_KEY && GOOGLE_CSE_ID) || SERPER_API_KEY)) {
    const web = await aiEnrichCompanyContacts(digits, result.nome || "");
    if (!result.telefone && web?.telefone) result.telefone = web.telefone;
    if (!result.email && web?.email) result.email = web.email;
    if ((web?.telefone || web?.email) && !result.fonteContato) result.fonteContato = `Pesquisa web/IA${web.fonte ? " / " + web.fonte : ""}`;
    if (web?.confianca) result.confiancaContato = web.confianca;
    if (web?.fonte) result.fonteWeb = web.fonte;
    result.fontesConsultadas.push("Pesquisa web/IA");
  }

  return result;
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

async function comprasGovCatalogSearch(q, uf, suppliers) {
  // Fonte oficial estruturada: o catálogo do Compras.gov.br permite localizar
  // CATMAT por descrição e a pesquisa de preços por código retorna CNPJ/nome
  // do fornecedor, preço, órgão, UF e data. Isso amplia muito a cobertura do mapa.
  const materialUrl = cleanBase(COMPRAS_BASE) + "/modulo-material/4_consultarItemMaterial";
  const serviceUrl = cleanBase(COMPRAS_BASE) + "/modulo-servico/6_consultarItemServico";
  const priceMaterialUrl = cleanBase(COMPRAS_BASE) + "/modulo-pesquisa-preco/1_consultarMaterial";
  const priceServiceUrl = cleanBase(COMPRAS_BASE) + "/modulo-pesquisa-preco/3_consultarServico";
  const catalogQueries = smartQueryVariants(q, 4);
  const codes = new Set();
  const catalogMatches = [];

  async function catalog(url, params) {
    const u = new URL(url);
    for (const [k,v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") u.searchParams.set(k,String(v));
    return fetchJson(u.toString(), { cacheTtl: 24*60*60*1000, timeoutMs: 10000, retries: 1 });
  }

  for (const query of catalogQueries) {
    try {
      const data = await catalog(materialUrl, { pagina:1, tamanhoPagina:100, descricaoItem:query, statusItem:1 });
      for (const row of pncpRows(data)) {
        const code = Number(row?.codigoItem);
        if (!Number.isFinite(code) || code <= 0) continue;
        const desc = row?.descricaoItem || row?.nomePdm || "";
        if (!descriptionMatches(desc, query) && !descriptionMatches(desc, q)) continue;
        if (!codes.has(`M:${code}`)) { codes.add(`M:${code}`); catalogMatches.push({tipo:"material", codigo:code, descricao:desc, row}); }
        if (catalogMatches.length >= 12) break;
      }
    } catch (_) {}
    if (catalogMatches.length >= 12) break;
  }

  const maxCatalogCodes = Math.min(Math.max(Number(process.env.CATALOG_MAX_CODES || 10), 1), 20);
  if (catalogMatches.length > maxCatalogCodes) catalogMatches.length = maxCatalogCodes;

  let registros = 0;
  const priceJobs = catalogMatches.slice(0,18).map(async match => {
    try {
      const url = match.tipo === "material" ? priceMaterialUrl : priceServiceUrl;
      const maxPricePages = Math.min(Math.max(Number(process.env.CATALOG_PRICE_PAGES || 2), 1), 5);
      const pages = await Promise.all(Array.from({length:maxPricePages}, (_,pi) => catalog(url, { pagina:pi+1, tamanhoPagina:500, codigoItemCatalogo:match.codigo, ...(uf ? {estado:uf} : {}), dataResultado:1 }).catch(() => null)));
      const rows = pages.flatMap(p => pncpRows(p));
      registros += rows.length;
      for (const r of rows) {
        const desc = r?.descricaoItem || match.descricao || q;
        if (!descriptionMatches(desc, q) && !descriptionMatches(desc, match.descricao)) continue;
        const cnpj = onlyDigits(r?.niFornecedor || "");
        const nome = r?.nomeFornecedor || "Fornecedor não informado";
        if (!cnpj && !nome) continue;
        await mapSupplierRecord(suppliers, {
          niFornecedor:cnpj, nomeRazaoSocialFornecedor:nome,
          nomeFornecedor:nome, valorUnitarioHomologado:r?.precoUnitario,
          dataResultado:r?.dataResultado || r?.dataCompra
        }, {
          fonte:`Compras.gov.br / ${match.tipo === "material" ? "CATMAT" : "CATSER"}`,
          descricao:desc, orgao:r?.nomeOrgao || "", uf:String(r?.estado || "").toUpperCase()
        });
      }
    } catch (_) {}
  });
  await Promise.all(priceJobs);
  return { registros, codigosCatalogo: catalogMatches.map(x=>({tipo:x.tipo,codigo:x.codigo,descricao:x.descricao})), fornecedoresCatalogo: suppliers.size };
}

async function comprasGovSearch(q, uf, suppliers) {
  return comprasGovCatalogSearch(q, uf, suppliers);
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
  const streamMode = String(req.query.stream || "0") === "1";
  const emit = (event, payload) => {
    if (!streamMode || res.writableEnded) return;
    try { res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`); } catch (_) {}
  };
  if (streamMode) {
    res.status(200);
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();
    emit("status", {fase:"busca", mensagem:"Localizando fornecedores em PNCP e Compras.gov.br..."});
    req.on("close", () => { req.__streamClosed = true; });
  }

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
    comprasGovCatalogSearch(q, uf, suppliers),
    comprasGovRecentSearch(q, uf, suppliers),
    comprasGovArpSearch(q, uf)
  ]);
  if (secondary[0].status === "fulfilled") comprasRows += Number(secondary[0].value?.registros || 0);
  else console.warn("Compras.gov catálogo/preços", secondary[0].reason?.message || secondary[0].reason);
  if (secondary[1].status === "fulfilled") comprasRows += Number(secondary[1].value || 0);
  else console.warn("Compras.gov recente", secondary[1].reason?.message || secondary[1].reason);
  if (secondary[2].status === "fulfilled") {
    const arpRows = secondary[2].value || [];
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
  } else console.warn("Compras.gov ARP", secondary[2].reason?.message || secondary[2].reason);

  const list = [...suppliers.values()].map(s => {
    s.razaoSocial = s.nome;
    s.precoMedio = s._priceCount ? s._sum / s._priceCount : null;
    s.fontes = [...s.fontes];
    delete s._sum; delete s._priceCount;
    s.telefone = null;
    s.email = null;
    s.fonteContato = null;
    s.cnpjUrl = s.cnpj ? `${cleanBase(CNPJ_BIZ_BASE)}/${onlyDigits(s.cnpj)}` : null;
    return s;
  });

  if (streamMode) {
    emit("initial", {
      fornecedores: list,
      totalFornecedores: list.length,
      totalMeEpp: list.filter(s => s.meEpp).length,
      itensCorrespondentes: matchedItems.length,
      comprasAnalisadas: purchasesProcessed,
      comprasDetalhadas: [...analyzedPurchases.values()],
      consulta: q
    });
    emit("status", {fase:"contatos", mensagem:`Foram encontrados ${list.length} fornecedores. Agora vou buscar telefone e e-mail de cada CNPJ.`});
  }

  // Enriquece TODOS os fornecedores em pequenos lotes paralelos. O cache de 24h
  // evita repetir consultas para o mesmo CNPJ em pesquisas seguintes.
  const batchSize = Number(process.env.CONTACT_BATCH_SIZE || 8);
  const aiMax = Number(process.env.CONTACT_AI_MAX || 250);
  let aiUsed = 0;
  for (let i = 0; i < list.length; i += batchSize) {
    const batch = list.slice(i, i + batchSize);
    await Promise.all(batch.map(async s => {
      const shouldUseAi = aiUsed < aiMax;
      if (shouldUseAi) aiUsed++;
      const c = await enrichCompanyContacts(s.cnpj, s.nome, { allowAi: shouldUseAi, allowPublicSearch: true });
      s.telefone = c.telefone || "SEM TELEFONE PUBLICO";
      s.email = c.email || "SEM EMAIL PUBLICO";
      s.fonteContato = c.fonteContato;
      s.fontesContato = c.fontesConsultadas || [];
      s.confiancaContato = c.confiancaContato || "nenhuma";
      s.fonteWeb = c.fonteWeb || null;
      s.cnpjUrl = c.cnpjUrl || s.cnpjUrl;
      if (streamMode) emit("contact", { cnpj:s.cnpj, nome:s.nome, telefone:s.telefone, email:s.email, fonteContato:s.fonteContato, fontesContato:s.fontesContato, confiancaContato:s.confiancaContato, fonteWeb:s.fonteWeb });
    }));
  }

  list.sort((a,b) => b.registros - a.registros || String(a.nome).localeCompare(String(b.nome), "pt-BR"));
  const finalPayload = {
    fonte: "PNCP + Compras.gov.br (CATMAT/CATSER + preços públicos + cadastro de fornecedor) + dados cadastrais públicos de CNPJ + pesquisa web/IA",
    aviso: "Mapa próprio baseado em dados públicos. A cobertura depende dos registros disponíveis e da resposta das fontes no momento da pesquisa.",
    consulta:q, uf:uf||"TODAS", comprasAnalisadas:purchasesProcessed,
    totalResultadosBusca: searchPages.reduce((n,d)=>n+Number(d?.total||0),0), itensCorrespondentes:matchedItems.length,
    registrosComprasGov:comprasRows, totalFornecedores:list.length, totalMeEpp:list.filter(s=>s.meEpp).length,
    fornecedores:list, itens:matchedItems.slice(0,200), comprasDetalhadas:[...analyzedPurchases.values()]
  };
  if (streamMode) {
    emit("complete", finalPayload);
    if (!res.writableEnded) res.end();
    return;
  }
  res.json(finalPayload);
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
