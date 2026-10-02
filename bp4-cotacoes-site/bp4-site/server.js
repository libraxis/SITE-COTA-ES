const express = require("express");
const session = require("express-session");
const cookieParser = require("cookie-parser");
const path = require("path");
const ExcelJS = require("exceljs");

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
const ADMIN_PASSWORD = String(process.env.ADMIN_PASSWORD || "").trim();

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
app.use((req,res,next)=>{
  if (req.path.startsWith("/api/") && req.path !== "/api/auth/heartbeat" && req.path !== "/api/auth/status") {
    adminEvent("API",{method:req.method,path:req.path},req);
    const row=accessLog.get(req.sessionID); if(row) row.currentActivity=`${req.method} ${req.path}`;
  }
  next();
});
app.use((req,res,next)=>{
  if (adminState.maintenance && req.path.startsWith("/api/") && !req.path.startsWith("/api/auth/") && !req.path.startsWith("/api/admin/") && !sessionIsAdmin(req)) return res.status(503).json({error:adminState.maintenanceMessage || "Sistema em manutenção."});
  next();
});

// Registro de acessos do painel. Fica em memória neste processo do Render.
// Login explícito gera um registro; heartbeat mantém a atividade atualizada;
// logout marca a saída. Se o navegador for fechado sem logout, o painel marca
// a sessão como inativa após o prazo de heartbeat.
const accessLog = new Map();
const revokedIps = new Map();
const ACCESS_INACTIVE_MS = 90 * 1000;
const ADMIN_MAX_EVENTS = 1200;
const adminEvents = [];
const adminSourceStats = new Map();
const adminAlerts = [];
const adminSearchHistory = [];
const adminSecurityEvents = [];
const adminState = { maintenance: false, maintenanceMessage: "Sistema em manutenção programada.", banner: "", bannerAt: null };
function adminEvent(type, details = {}, req = null) {
  const row = { at: Date.now(), type, ip: req ? clientIp(req) : null, session: req?.sessionID || null, user: req?.session?.isAdmin ? "ADMIN" : (req?.session?.apiToken ? "USUÁRIO" : "SISTEMA"), details };
  adminEvents.unshift(row); if (adminEvents.length > ADMIN_MAX_EVENTS) adminEvents.length = ADMIN_MAX_EVENTS;
  return row;
}
function adminAlert(message, severity = "info", details = {}) {
  const row = { id: `${Date.now()}-${Math.random().toString(36).slice(2,7)}`, at: Date.now(), severity, message, details, read: false };
  adminAlerts.unshift(row); if (adminAlerts.length > 200) adminAlerts.length = 200; return row;
}
function sourceName(url) {
  try { const h = new URL(url).hostname.toLowerCase(); if (h.includes("pncp.gov.br")) return "PNCP"; if (h.includes("compras.gov.br") || h.includes("dadosabertos.compras.gov.br")) return "Compras.gov.br"; if (h.includes("brasilapi")) return "BrasilAPI"; if (h.includes("cnpj.ws")) return "CNPJ.ws"; if (h.includes("portaldatransparencia")) return "Portal da Transparência"; if (h.includes("googleapis") || h.includes("google.com")) return "Google"; if (h.includes("openai.com")) return "OpenAI"; return h; } catch (_) { return "Fonte externa"; }
}
function trackSource(url, ok, ms, status = 200) {
  const name = sourceName(url); const row = adminSourceStats.get(name) || { fonte:name, chamadas:0, sucessos:0, erros:0, totalMs:0, ultimoStatus:null, ultimaConsulta:null };
  row.chamadas++; row.totalMs += Number(ms)||0; row.ultimaConsulta = Date.now(); row.ultimoStatus = status; if (ok) row.sucessos++; else { row.erros++; if (row.erros >= 5 && row.erros % 5 === 0) adminAlert(`${name} apresentou ${row.erros} erros acumulados.`, "warning", {fonte:name}); }
  adminSourceStats.set(name,row);
}
function adminOnly(req,res,next){ if (!sessionIsAdmin(req)) return res.status(403).json({error:"Acesso exclusivo do administrador."}); next(); }
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
    isAdmin: req.session.isAdmin === true,
    userAgent: String(req.headers["user-agent"] || ""),
    currentActivity: "Conectado"
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
    const startedAt = Date.now();
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
          trackSource(url, true, Date.now() - startedAt, response.status);
          return useCache ? cacheSet(cacheKey, data, cacheTtl) : data;
        }
      } catch (err) {
        lastErr = err.name === "AbortError" ? new Error(`Tempo limite ao consultar fonte externa (${timeoutMs/1000}s).`) : err;
        if (attempt >= retries) break;
      } finally { clearTimeout(timer); }
      const wait = Math.min(700 * (attempt + 1), 1800);
      await new Promise(r => setTimeout(r, wait));
    }
    trackSource(url, false, Date.now() - startedAt, lastErr?.status || 0);
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
  const ip = clientIp(req);
  const revokedAt = revokedIps.get(ip);
  if (revokedAt && Date.now() >= revokedAt) revokedIps.delete(ip);
  else if (revokedAt) {
    const err = new Error("Acesso deslogado pelo administrador. Informe novamente o Token de Acesso API-Banco de Preços.");
    err.status = 401;
    throw err;
  }
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

async function pncpSearch(q, { uf, ano, pagina = 1, tamPagina = 20 } = {}) {
  const url = new URL(PNCP_SEARCH_BASE + "/");
  url.searchParams.set("q", q);
  url.searchParams.set("tipos_documento", "edital");
  url.searchParams.set("status", "encerradas");
  url.searchParams.set("ordenacao", "-data");
  url.searchParams.set("pagina", String(pagina));
  url.searchParams.set("tam_pagina", String(Math.min(Math.max(tamPagina, 1), 50)));
  if (uf) url.searchParams.set("uf", uf);
  if (ano) url.searchParams.set("ano", String(ano));
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
  if (/example|emailprotected|sentry|cloudflare|wix|noreply|no-reply|error[-_]?lite|duckduckgo|captcha|abuse@/i.test(e)) return null;
  return e;
}
function cleanPhone(value) {
  const raw = String(value || "");
  const candidates = raw.match(/(?:\+?55\s*)?(?:\(?\d{2}\)?\s*)?(?:9\s*)?\d{4}[\s.-]?\d{4}/g) || [];
  for (const c of candidates) {
    const digits = c.replace(/\D/g, "");
    if (digits.length < 10 || digits.length > 13) continue;
    const local = digits.slice(-11);
    if (/^(\d)\1+$/.test(local)) continue;
    if (/^(0123456789|1234567890|9876543210)/.test(local)) continue;
    return c.trim();
  }
  return null;
}
function validPhoneForCnpj(phone, cnpj) {
  const cleaned = cleanPhone(phone);
  if (!cleaned) return null;
  const pd = onlyDigits(cleaned);
  const cd = onlyDigits(cnpj);
  if (!pd || !cd || cd.length !== 14) return cleaned;
  // Nunca aceitar qualquer telefone que seja uma sequência do próprio CNPJ.
  // Isso bloqueia inclusive números de 10/11 dígitos extraídos de dentro dos 14 dígitos.
  if (cd.includes(pd) || pd.includes(cd)) return null;
  if (pd === cd.slice(0, 11) || pd === cd.slice(-11) || pd === cd.slice(0, 10) || pd === cd.slice(-10)) return null;
  return cleaned;
}
function normalizeCompanyName(value) {
  return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\b(ltda|me|epp|eireli|sa|s a|sociedade|anonima|limitada)\b/g, " ").replace(/\s+/g, " ").trim();
}
function pageSupportsCompany(text, cnpj, nome) {
  const raw = decodeHtmlEntities(String(text || ""));
  const digits = onlyDigits(cnpj);
  if (digits.length === 14 && raw.replace(/\D/g, "").includes(digits)) return true;
  const wanted = normalizeCompanyName(nome);
  if (!wanted || wanted.length < 6) return false;
  const page = normalizeCompanyName(raw.replace(/<[^>]+>/g, " "));
  const tokens = wanted.split(" ").filter(t => t.length >= 4).slice(0, 8);
  const hits = tokens.filter(t => page.includes(t)).length;
  return tokens.length >= 2 && hits >= Math.max(2, Math.ceil(tokens.length * 0.6));
}
function isSearchEngineUrl(url) {
  try { const h=new URL(url).hostname.toLowerCase(); return /(^|\.)google\./.test(h)||/(^|\.)bing\.com$/.test(h)||/(^|\.)duckduckgo\.com$/.test(h); } catch (_) { return false; }
}
function decodeSearchRedirect(href) {
  if (!href) return null;
  let u=decodeHtmlEntities(String(href));
  try {
    const parsed=new URL(u,"https://www.google.com");
    for(const key of ["q","url","uddg"]){ const target=parsed.searchParams.get(key); if(target&&/^https?:\/\//i.test(target)) return decodeURIComponent(target); }
    return parsed.toString();
  } catch (_) { return null; }
}
function extractSearchLinks(html,max=12){
  const out=[],seen=new Set(),re=/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi; let m;
  while((m=re.exec(String(html||"")))&&out.length<max){
    const url=decodeSearchRedirect(m[1]); if(!url||!/^https?:\/\//i.test(url)||isSearchEngineUrl(url)) continue;
    const key=url.split("#")[0]; if(seen.has(key)) continue; seen.add(key);
    out.push({url:key,title:decodeHtmlEntities(m[2]).replace(/<[^>]+>/g," ").replace(/\s+/g," ").trim()});
  }
  return out;
}
function extractContactsFromText(text) {
  const raw=decodeHtmlEntities(String(text||"").replace(/<script[\s\S]*?<\/script>/gi," ").replace(/<style[\s\S]*?<\/style>/gi," "));
  const emails=[...new Set((raw.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)||[]).map(cleanEmail).filter(Boolean))];
  const phones=[...new Set((raw.match(/(?:\+?55\s*)?(?:\(?\d{2}\)?\s*)?(?:9\s*)?\d{4}[\s.-]?\d{4}/g)||[]).map(cleanPhone).filter(Boolean))];
  return {email:emails[0]||null,telefone:phones[0]||null,emails,telefones:phones};
}
function contactBelongsToCnpj(text,cnpj){ const digits=onlyDigits(cnpj); return digits.length===14&&String(text||"").replace(/\D/g,"").includes(digits); }
async function fetchPublicContactPages(cnpj,nome){
  const digits=onlyDigits(cnpj), q=encodeURIComponent(`"${digits}" "${String(nome||"")}" telefone email`);
  const searchUrls=[`https://www.google.com/search?q=${q}&hl=pt-BR`,`https://www.bing.com/search?q=${q}&setlang=pt-BR`,`https://html.duckduckgo.com/html/?q=${q}`];
  const directUrls=[`${cleanBase(CNPJ_BIZ_BASE)}/${digits}`,`https://cnpj.biz/${digits}`,`https://casadosdados.com.br/solucao/cnpj/${digits}`,`https://radarpj.com/cnpj/${digits}`,`https://breela.com.br/cnpj/${digits}`];
  const out={telefone:null,email:null,fonte:null,paginas:[]};
  const headers={"User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130 Safari/537.36","Accept":"text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8","Accept-Language":"pt-BR,pt;q=0.9,en;q=0.7"};
  const direct=await Promise.allSettled(directUrls.map(u=>fetchText(u,{cacheTtl:24*60*60*1000,timeoutMs:CONTACT_SEARCH_TIMEOUT,retries:0,headers})));
  for(let i=0;i<direct.length;i++){
    if(direct[i].status!=="fulfilled") continue; const html=String(direct[i].value||"");
    if(!pageSupportsCompany(html,digits,nome)) continue; const c=extractContactsFromText(html); if(!c.email&&!c.telefone) continue;
    if(!out.email&&c.email) out.email=c.email; if(!out.telefone&&c.telefone) out.telefone=c.telefone; if(!out.fonte) out.fonte=directUrls[i]; out.paginas.push(directUrls[i]);
    if(out.email&&out.telefone) return out;
  }
  const searchPages=await Promise.allSettled(searchUrls.map(u=>fetchText(u,{cacheTtl:6*60*60*1000,timeoutMs:CONTACT_SEARCH_TIMEOUT,retries:0,headers})));
  const links=[],seen=new Set();
  for(const r of searchPages){ if(r.status!=="fulfilled") continue; for(const item of extractSearchLinks(r.value,12)){ if(seen.has(item.url)) continue; seen.add(item.url); links.push(item); } }
  links.sort((a,b)=>{const score=u=>/cnpj\.biz|casadosdados|radarpj|breela|gov\.br|com\.br/i.test(u)?0:1;return score(a.url)-score(b.url);});
  const candidates=links.slice(0,18);
  const pages=await Promise.allSettled(candidates.map(x=>fetchText(x.url,{cacheTtl:24*60*60*1000,timeoutMs:CONTACT_SEARCH_TIMEOUT,retries:0,headers})));
  for(let i=0;i<pages.length;i++){
    if(pages[i].status!=="fulfilled") continue; const html=String(pages[i].value||"");
    if(!pageSupportsCompany(html,digits,nome)) continue; const c=extractContactsFromText(html); if(!c.email&&!c.telefone) continue;
    if(!out.email&&c.email) out.email=c.email; if(!out.telefone&&c.telefone) out.telefone=c.telefone; if(!out.fonte) out.fonte=candidates[i].url; out.paginas.push(candidates[i].url);
    if(out.email&&out.telefone) break;
  }
  return out;
}
async function googleSearchContacts(cnpj,nome){
  const cleanName = String(nome || "").replace(/\s+/g," ").trim();
  const queries = [
    `"${cnpj}" "${cleanName}" email`,
    `"${cnpj}" "${cleanName}" "e-mail"`,
    `"${cnpj}" "${cleanName}" contato telefone`,
    `"${cnpj}" email contato fornecedor`,
    `"${cnpj}" @`
  ];
  const all = [], seen = new Set();
  const add = (items) => { for (const x of (items || [])) {
    const link=String(x?.link||x?.url||"").trim(); if(!link||isSearchEngineUrl(link)||seen.has(link)) continue;
    seen.add(link); all.push({title:String(x?.title||""),link,snippet:String(x?.snippet||x?.description||"")});
  }};
  if(GOOGLE_CSE_API_KEY&&GOOGLE_CSE_ID){
    for(const q of queries){ try{
      const u=new URL("https://www.googleapis.com/customsearch/v1");
      u.searchParams.set("key",GOOGLE_CSE_API_KEY);u.searchParams.set("cx",GOOGLE_CSE_ID);u.searchParams.set("q",q);u.searchParams.set("num","10");u.searchParams.set("hl","pt-BR");u.searchParams.set("gl","br");
      const data=await fetchJson(u.toString(),{cacheTtl:24*60*60*1000,timeoutMs:10000,retries:0}); add(data?.items);
    }catch(_){} if(all.length>=40) break; }
    return all.slice(0,40);
  }
  if(SERPER_API_KEY){
    for(const q of queries.slice(0,4)){ try{
      const data=await fetchJson("https://google.serper.dev/search",{method:"POST",cache:false,timeoutMs:10000,retries:0,headers:{"X-API-KEY":SERPER_API_KEY,"Content-Type":"application/json"},body:JSON.stringify({q,gl:"br",hl:"pt-br",num:10})}); add(data?.organic);
    }catch(_){} if(all.length>=40) break; }
  }
  return all.slice(0,40);
}

async function extractVerifiedEmailFromGoogleResults(cnpj,nome,results){
  const digits=onlyDigits(cnpj); if(digits.length!==14) return {email:null,fonte:null};
  const wanted=normalizeCompanyName(nome), candidates=[];
  for(const r of (results||[])){
    const blob=decodeHtmlEntities(`${r.title||""} ${r.snippet||""}`);
    const emails=[...new Set((blob.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)||[]).map(cleanEmail).filter(Boolean))];
    if(!emails.length) continue;
    const exactCnpj=blob.replace(/\D/g,"").includes(digits);
    const nameNorm=normalizeCompanyName(blob), nameHit=wanted&&wanted.length>=6&&nameNorm.includes(wanted);
    if(exactCnpj||nameHit) candidates.push({r,emails,exactCnpj});
  }
  for(const c of candidates){
    try{
      const html=await fetchText(c.r.link,{cacheTtl:24*60*60*1000,timeoutMs:CONTACT_SEARCH_TIMEOUT,retries:0,headers:{"User-Agent":"Mozilla/5.0"}});
      if(!pageSupportsCompany(html,digits,nome)) continue;
      const pageEmails=extractContactsFromText(html).emails;
      for(const e of c.emails) if(pageEmails.includes(e)) return {email:e,fonte:c.r.link};
    }catch(_){}
  }
  const exact=candidates.find(x=>x.exactCnpj); return exact?{email:exact.emails[0],fonte:exact.r.link}:{email:null,fonte:null};
}

async function aiSearchContacts(cnpj,nome,searchResults=[]){
  if(!OPENAI_API_KEY) return null;
  const searchText=searchResults.slice(0,10).map((r,i)=>`RESULTADO ${i+1}\nTITULO: ${r.title||""}\nURL: ${r.link||""}\nTRECHO: ${r.snippet||""}`).join("\n\n");
  const prompt=`Você está enriquecendo dados públicos de uma empresa brasileira.\nCNPJ: ${cnpj}\nRazão social/nome: ${nome||"não informado"}\n\nPesquise na web usando o CNPJ exato. Só aceite telefone/e-mail publicamente associado a esta empresa. Não invente, não deduza e não use dados de outra empresa. Informe a URL exata da página onde o contato aparece.\n\nResultados:\n${searchText||"(nenhum)"}\n\nResponda SOMENTE JSON: {"telefone":"... ou null","email":"... ou null","fonte":"URL ou null","confianca":"alta|media|baixa|nenhuma"}.`;
  try{const data=await fetchJson("https://api.openai.com/v1/responses",{method:"POST",cache:false,timeoutMs:25000,retries:0,headers:{"Authorization":`Bearer ${OPENAI_API_KEY}`,"Content-Type":"application/json"},body:JSON.stringify({model:OPENAI_CONTACT_MODEL,tools:[{type:"web_search"}],input:prompt,store:false})});const text=String(data?.output_text||"");const m=text.match(/\{[\s\S]*\}/);if(!m)return null;const obj=JSON.parse(m[0]);return{telefone:cleanPhone(obj.telefone),email:cleanEmail(obj.email),fonte:obj.fonte||null,confianca:obj.confianca||"nenhuma"};}catch(_){return null;}
}
async function aiEnrichCompanyContacts(cnpj,nome){
  const results=await googleSearchContacts(cnpj,nome);
  const out={telefone:null,email:null,fonte:null,confianca:"nenhuma"};
  try{ const verified=await extractVerifiedEmailFromGoogleResults(cnpj,nome,results); if(verified.email){out.email=verified.email;out.fonte=verified.fonte;out.confianca="media";} }catch(_){}
  // Fallback adicional para e-mail: o Google CSE pode colocar o contato no
  // snippet sem que o HTML da página permita nova validação (bloqueio, JS,
  // robots, etc.). Quando CNPJ exato ou nome forte aparece no próprio resultado,
  // o e-mail do snippet pode ser aproveitado. Isso não altera a lógica de telefone.
  if(!out.email){
    const wanted=normalizeCompanyName(nome);
    for(const r of (results||[])){
      const blob=decodeHtmlEntities(`${r.title||""} ${r.snippet||""}`);
      const emails=[...new Set((blob.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)||[]).map(cleanEmail).filter(Boolean))];
      if(!emails.length) continue;
      const exactCnpj=blob.replace(/\D/g,"").includes(onlyDigits(cnpj));
      const norm=normalizeCompanyName(blob);
      const tokens=(wanted||"").split(" ").filter(t=>t.length>=4);
      const hits=tokens.filter(t=>norm.includes(t)).length;
      const strongName=tokens.length>=2 && hits>=Math.max(2,Math.ceil(tokens.length*.6));
      if(exactCnpj || strongName){ out.email=emails[0]; out.fonte=r.link||null; out.confianca=exactCnpj?"media":"baixa"; break; }
    }
  }
  const ai=await aiSearchContacts(cnpj,nome,results);
  if(ai?.fonte&&/^https?:\/\//i.test(ai.fonte)&&!isSearchEngineUrl(ai.fonte)){
    try{const html=await fetchText(ai.fonte,{cacheTtl:24*60*60*1000,timeoutMs:CONTACT_SEARCH_TIMEOUT,retries:0});if(pageSupportsCompany(html,cnpj,nome)){const page=extractContactsFromText(html);if(!out.email&&page.email&&ai.email&&page.email===ai.email)out.email=page.email;if(page.telefone&&ai.telefone&&page.telefone.replace(/\D/g,"")===ai.telefone.replace(/\D/g,""))out.telefone=page.telefone;if(out.email||out.telefone){out.fonte=out.fonte||ai.fonte;out.confianca=ai.confianca||"media";}}}catch(_){}
  }
  return out;
}

async function comprasGovFornecedor(cnpj) {
  const digits = onlyDigits(cnpj);
  if (digits.length !== 14) return null;
  try {
    const url = `${COMPRAS_BASE}/modulo-fornecedor/1_consultarFornecedor?pagina=1&tamanhoPagina=10&cnpj=${encodeURIComponent(digits)}`;
    const data = await fetchJson(url, { cacheTtl: 24 * 60 * 60 * 1000, timeoutMs: 9000, retries: 1 });
    const rows = Array.isArray(data) ? data : (data?.resultado || data?.data || data?.content || []);
    if (!Array.isArray(rows)) return null;
    // Nunca usar a primeira linha como fallback: se a API ignorar o filtro de CNPJ,
    // isso faria o telefone de um fornecedor ser copiado para todos os demais.
    return rows.find(x => onlyDigits(x?.cnpj || x?.niFornecedor || x?.numeroInscricao || x?.numeroIdentificacao || "") === digits) || null;
  } catch (_) { return null; }
}

async function enrichPhoneFromDirectories(cnpj, nome = "") {
  const digits = onlyDigits(cnpj);
  if (digits.length !== 14) return { telefone: null, fonte: null };
  const urls = [
    `https://radardocnpj.com.br/empresa/${digits}`,
    `https://guiapj.com.br/consulta-cnpj/${digits}`,
    `https://portaldatransparencia.gov.br/pessoa-juridica/${digits}`,
    `https://www.cnpj.biz/${digits}`,
    `https://cnpj.biz/${digits}`
  ];
  const headers = {"User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130 Safari/537.36","Accept-Language":"pt-BR,pt;q=0.9,en;q=0.7"};
  for (const url of urls) {
    try {
      const html = await fetchText(url, { cacheTtl: 24*60*60*1000, timeoutMs: 9000, retries: 0, headers });
      if (!pageSupportsCompany(html, digits, nome)) continue;
      const c = extractContactsFromText(html);
      const phone = validPhoneForCnpj(c.telefone, digits);
      if (phone) return { telefone: phone, fonte: url };
    } catch (_) {}
  }
  return { telefone: null, fonte: null };
}

async function enrichCompanyContacts(cnpj, nome = "", options = {}) {
  const digits = onlyDigits(cnpj);
  if (digits.length !== 14) return { telefone: null, email: null, fonteContato: null, cnpjUrl: null, fontesConsultadas: [] };
  const result = { telefone: null, email: null, fonteContato: null, fonteWeb: null, confiancaContato: "nenhuma", nome: nome || null, cnpjUrl: `${cleanBase(CNPJ_BIZ_BASE)}/${digits}`, fontesConsultadas: [] };

  const blockedPhones = options.blockedPhones instanceof Set ? options.blockedPhones : new Set();
  const phoneDigits = value => onlyDigits(value);
  const addContact = (phone, email, source) => {
    // IMPORTANTE: não permitir que uma sequência do próprio CNPJ seja
    // confundida com telefone. Isso acontecia quando uma página/API devolvia
    // o CNPJ em um campo incorreto ou quando o extrator encontrava 10/11
    // dígitos dentro do CNPJ (ex.: 36957099000).
    const rawPhones = Array.isArray(phone) ? phone.filter(Boolean) : [phone];
    let validPhone = null;
    for (const candidate of rawPhones) {
      const cleaned = validPhoneForCnpj(candidate, digits);
      if (!cleaned) continue;
      const pd = phoneDigits(cleaned);
      if (pd && blockedPhones.has(pd)) continue;
      validPhone = cleaned;
      break;
    }
    if (!result.telefone && validPhone) result.telefone = String(validPhone).trim();
    // NÃO ALTERAR A LÓGICA DE E-MAIL: permanece exatamente como vinha sendo
    // aceita/validada nas versões anteriores.
    if (!result.email && email) result.email = String(email).trim();
    if ((validPhone || email) && !result.fonteContato) result.fonteContato = source;
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
      if (pageSupportsCompany(html, digits, result.nome || nome || "")) {
        const found = extractPublicContactsFromCnpjBiz(html);
        addContact(validPhoneForCnpj(found.telefone, digits), found.email, "CNPJ.BIZ / página pública");
      }
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
    if (!result.telefone && web?.telefone) {
      const aiPhone = validPhoneForCnpj(web.telefone, digits);
      if (aiPhone && !blockedPhones.has(phoneDigits(aiPhone))) result.telefone = aiPhone;
    }
    if (!result.email && web?.email) result.email = web.email;
    if ((web?.telefone || web?.email) && !result.fonteContato) result.fonteContato = `Pesquisa web/IA${web.fonte ? " / " + web.fonte : ""}`;
    if (web?.confianca) result.confiancaContato = web.confianca;
    if (web?.fonte) result.fonteWeb = web.fonte;
    result.fontesConsultadas.push("Pesquisa web/IA");
  }

  // 8) Fallback EXCLUSIVO para telefone. Não altera nem reprocessa o e-mail.
  // Algumas bases públicas exibem telefone em páginas que as APIs anteriores
  // não retornam. O Radar do CNPJ, GuiaPJ e Portal da Transparência são
  // consultados pelo CNPJ exato e o telefone só é aceito se a página pertencer
  // à mesma empresa.
  if (!result.telefone) {
    try {
      const phone = await enrichPhoneFromDirectories(digits, result.nome || nome || "");
      if (phone.telefone && !blockedPhones.has(phoneDigits(phone.telefone))) {
        result.telefone = phone.telefone;
        result.fonteContato = result.fonteContato || `Telefone / fonte pública`;
        if (phone.fonte && !result.fonteWeb) result.fonteWeb = phone.fonte;
        if (phone.fonte && !result.fontesConsultadas.includes(phone.fonte)) result.fontesConsultadas.push(phone.fonte);
      }
    } catch (_) {}
  }

  return result;
}
async function mapSupplierRecord(suppliers, r, meta = {}) {
  const cnpj = onlyDigits(r?.niFornecedor || r?.cnpjFornecedor || r?.codFornecedor || r?.cnpj || "");
  const nome = r?.nomeRazaoSocialFornecedor || r?.nomeFornecedor || r?.fornecedorNome || r?.nome || "Fornecedor não informado";
  if (!cnpj && !nome) return;
  const supplierKey = cnpj || normalizeText(nome);
  let s = suppliers.get(supplierKey);
  if (!s) {
    s = { nome, cnpj, registros: 0, vencedores: 0, participacoes: 0, propostas: 0, classificados: 0, referenciasPreco: 0, tipos: new Set(), evidencias: [], meEpp: false, ultimaData: null, precoMedio: null, _sum: 0, _priceCount: 0, compras: [], fontes: new Set() };
    suppliers.set(supplierKey, s);
  }
  s.registros += 1;
  const tipo = String(meta.tipo || "homologado").toLowerCase();
  if (tipo === "homologado" || tipo === "vencedor") s.vencedores += 1;
  if (tipo === "participante" || tipo === "classificado" || tipo === "proposta") s.participacoes += 1;
  if (tipo === "proposta") s.propostas += 1;
  if (tipo === "classificado") s.classificados += 1;
  if (tipo === "preco_publico") s.referenciasPreco += 1;
  s.tipos.add(tipo);
  s.meEpp = s.meEpp || [1,2].includes(Number(r?.porteFornecedorId));
  const data = r?.dataResultado || r?.dataResultadoPncp || r?.dataCompra || r?.data || null;
  if (data && (!s.ultimaData || new Date(data) > new Date(s.ultimaData))) s.ultimaData = data;
  const price = Number(r?.valorUnitarioHomologado ?? r?.valorUnitarioResultado ?? r?.precoUnitario ?? r?.preco ?? r?.valorUnitario);
  if (Number.isFinite(price)) { s._sum += price; s._priceCount++; }
  const fonte = meta.fonte || "PNCP";
  s.fontes.add(fonte);
  if (meta.evidencia && s.evidencias.length < 12) s.evidencias.push({tipo, evidencia:meta.evidencia, link:meta.link || null, fonte});
  if (s.compras.length < 10) s.compras.push({
    descricao: meta.descricao || r?.descricaoResumida || r?.descricaodetalhada || r?.descricaoItem || "",
    orgao: meta.orgao || r?.nomeOrgao || "",
    uf: meta.uf || r?.estado || "",
    data,
    preco: Number.isFinite(price) ? price : null,
    link: meta.link || null,
    fonte,
    tipo
  });
}

function classifyPublicResult(r) {
  const status = normalizeText(r?.situacaoCompraItemResultadoNome || r?.situacaoCompraItemResultado || r?.situacao || r?.status || "");
  const motivo = normalizeText(r?.motivoCancelamento || "");
  const ordem = Number(r?.ordemClassificacaoSrp);
  if (/(desclassific|inabilitad|cancelad|fracassad|revogad)/i.test(status + " " + motivo)) return "participante";
  if (/(homologad|adjudicad|vencedor)/i.test(status)) return "homologado";
  if (Number.isFinite(ordem) && ordem > 0) return "classificado";
  return "participante";
}

function extractJsonArray(text) {
  const raw = String(text || "");
  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  if (start < 0 || end <= start) return [];
  try { const value = JSON.parse(raw.slice(start, end + 1)); return Array.isArray(value) ? value : []; } catch (_) { return []; }
}

async function aiDiscoverParticipatingSuppliers(query, { uf = "", ano = "" } = {}) {
  if (!OPENAI_API_KEY) return [];
  const filtroAno = ano || "últimos anos disponíveis";
  const filtroUf = uf || "todo o Brasil";
  const prompt = `Você está ajudando uma equipe pública a ampliar uma pesquisa de fornecedores para a fase interna de uma contratação.
ITEM PESQUISADO: ${query}
UF: ${filtroUf}
PERÍODO: ${filtroAno}

Pesquise na web por processos de compras públicas em que empresas tenham apresentado proposta, lance, classificação ou participação efetiva para ESTE ITEM ou uma descrição claramente equivalente. Priorize páginas oficiais de órgãos, portais de compras, atas, resultados, documentos de licitação e páginas públicas de processos.

IMPORTANTE:
- Não liste empresas apenas porque o CNAE é compatível.
- Não liste empresas apenas porque aparecem como vencedoras de outro objeto.
- Só inclua uma empresa se encontrar evidência pública relacionada à participação/proposta/classificação naquele item ou processo.
- Para cada empresa, informe CNPJ quando estiver publicamente disponível, razão social, tipo de evidência (proposta|participante|classificado|homologado), uma frase curta da evidência e a URL da fonte.
- Se a fonte não permitir afirmar proposta/participação, não use esse tipo; pode usar homologado somente quando houver resultado vencedor explícito.
- Não invente CNPJ, preço, processo ou URL.
- Retorne no máximo 30 empresas.

Responda SOMENTE um JSON array: [{"cnpj":"...","nome":"...","tipo":"proposta|participante|classificado|homologado","evidencia":"...","fonte":"https://...","processo":"...","item":"..."}]`;
  try {
    const data = await fetchJson("https://api.openai.com/v1/responses", {
      method:"POST", cache:false, timeoutMs:45000, retries:0,
      headers:{"Authorization":`Bearer ${OPENAI_API_KEY}`,"Content-Type":"application/json"},
      body:JSON.stringify({model:OPENAI_CONTACT_MODEL, tools:[{type:"web_search"}], input:prompt, store:false})
    });
    return extractJsonArray(data?.output_text);
  } catch (_) { return []; }
}

async function validateSupplierEvidence(candidate, query) {
  const cnpj = onlyDigits(candidate?.cnpj || "");
  const fonte = String(candidate?.fonte || "").trim();
  if (cnpj.length !== 14 || !/^https?:\/\//i.test(fonte)) return false;
  try {
    const html = await fetchText(fonte, { cacheTtl: 12*60*60*1000, timeoutMs:12000, retries:0, headers:{"User-Agent":"Mozilla/5.0"} });
    const normalized = normalizeText(decodeHtmlEntities(String(html || "")));
    const hasCnpj = onlyDigits(html).includes(cnpj);
    const terms = smartQueryVariants(query, 3).some(v => normalizeText(html).includes(normalizeText(v).slice(0, Math.min(50, normalizeText(v).length))));
    const explicit = /(proposta|proponente|participante|classificad|licitante|lance|homologad|vencedor|fornecedor)/i.test(normalized);
    return hasCnpj && explicit && (terms || normalized.includes(normalizeText(candidate?.item || query).slice(0, 30)));
  } catch (_) { return false; }
}


function extractCnpjsFromText(text) {
  const raw = String(text || "");
  const out = new Set();
  const re = /\b\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}\b/g;
  for (const m of raw.match(re) || []) {
    const d = onlyDigits(m);
    if (d.length === 14) out.add(d);
  }
  return [...out];
}

function classifyWebEvidence(text) {
  const t = normalizeText(text);
  if (/(homologad|adjudicad|vencedor|ganhador)/i.test(t)) return "homologado";
  if (/(classificad|ordem de classificacao|ranking)/i.test(t)) return "classificado";
  if (/(proposta|proponente|lance)/i.test(t)) return "proposta";
  if (/(participante|licitante|participou|participacao)/i.test(t)) return "participante";
  return "participante";
}

async function googleCseDiscoverParticipants(query, uf, ano, suppliers, emit) {
  if (!GOOGLE_CSE_API_KEY || !GOOGLE_CSE_ID) return 0;
  emit?.("status", {fase:"google", mensagem:"Ampliando a pesquisa com Google CSE para localizar fornecedores que apresentaram proposta, participaram ou foram classificados em processos relacionados..."});

  const base = String(query || "").replace(/["\n\r]+/g, " ").trim();
  const ufPart = uf ? ` ${uf}` : "";
  const yearPart = ano ? ` ${ano}` : "";
  const queries = [
    `"${base}"${ufPart}${yearPart} licitação fornecedor CNPJ proposta`,
    `"${base}"${ufPart}${yearPart} pregão participante CNPJ`,
    `"${base}"${ufPart}${yearPart} licitante proposta CNPJ`,
    `"${base}"${ufPart}${yearPart} resultado licitação fornecedor CNPJ`,
    `"${base}"${ufPart}${yearPart} classificação fornecedor CNPJ`,
    `"${base}"${ufPart}${yearPart} "CNPJ" "participante"`
  ];
  const results = [];
  for (const q of queries) {
    try {
      const u = new URL("https://www.googleapis.com/customsearch/v1");
      u.searchParams.set("key", GOOGLE_CSE_API_KEY);
      u.searchParams.set("cx", GOOGLE_CSE_ID);
      u.searchParams.set("q", q);
      u.searchParams.set("num", "10");
      u.searchParams.set("hl", "pt-BR");
      u.searchParams.set("gl", "br");
      const data = await fetchJson(u.toString(), {cacheTtl: 6*60*60*1000, timeoutMs:12000, retries:0});
      for (const item of (data?.items || [])) results.push(item);
    } catch (_) {}
  }

  const unique = new Map();
  for (const r of results) if (r?.link) unique.set(String(r.link), r);
  let accepted = 0;
  const candidates = [...unique.values()].slice(0, 60);
  for (const r of candidates) {
    if (accepted >= 40) break;
    const quickText = `${r.title || ""} ${r.snippet || ""}`;
    let cnpjs = extractCnpjsFromText(quickText);
    let html = "";
    if (!cnpjs.length) {
      try { html = await fetchText(r.link, {cacheTtl: 6*60*60*1000, timeoutMs:10000, retries:0, headers:{"User-Agent":"Mozilla/5.0"}}); } catch (_) { html = ""; }
      cnpjs = extractCnpjsFromText(html);
    }
    if (!cnpjs.length) continue;
    const evidenceText = `${quickText} ${html}`;
    const normalized = normalizeText(decodeHtmlEntities(evidenceText));
    const hasProcurementTerm = /(licitacao|pregao|processo licitatorio|edital|proposta|proponente|participante|licitante|lance|classificad|homologad|adjudicad|vencedor)/i.test(normalized);
    if (!hasProcurementTerm) continue;
    const variants = smartQueryVariants(base, 4);
    const hasItemTerm = variants.some(v => {
      const n = normalizeText(v);
      return n.length >= 4 && normalized.includes(n.slice(0, Math.min(60, n.length)));
    });
    if (!hasItemTerm) continue;
    const tipo = classifyWebEvidence(normalized);
    const nome = String(r.title || "Fornecedor identificado em página pública").replace(/\s*[-|–—].*$/, "").trim().slice(0, 180) || "Fornecedor identificado em página pública";
    for (const cnpj of cnpjs) {
      if (suppliers.has(cnpj)) continue;
      const evidencia = `Google CSE localizou página pública com CNPJ e evidência de ${tipo} relacionada ao item pesquisado.`;
      await mapSupplierRecord(suppliers, {cnpj, nome, data:null}, {
        tipo,
        fonte:"Google CSE / página pública",
        descricao:base,
        uf,
        link:r.link,
        evidencia,
        orgao:""
      });
      accepted++;
      if (accepted >= 40) break;
    }
  }
  return accepted;
}

async function discoverWebParticipants(query, uf, ano, suppliers, emit) {
  if (!OPENAI_API_KEY) return 0;
  emit?.("status", {fase:"participacao", mensagem:"Ampliando a pesquisa em fontes públicas para localizar propostas e participantes identificados por CNPJ..."});
  const candidates = await aiDiscoverParticipatingSuppliers(query, {uf, ano});
  let accepted = 0;
  for (const c of candidates.slice(0, 30)) {
    const cnpj = onlyDigits(c?.cnpj || "");
    if (cnpj.length !== 14 || suppliers.has(cnpj)) continue;
    if (!(await validateSupplierEvidence(c, query))) continue;
    const tipo = ["proposta","participante","classificado","homologado"].includes(String(c.tipo||"").toLowerCase()) ? String(c.tipo).toLowerCase() : "participante";
    await mapSupplierRecord(suppliers, {cnpj, nome:c.nome || "Fornecedor não informado", data:null}, {
      tipo, fonte:"Pesquisa pública web / evidência do processo", descricao:c.item || query,
      uf, link:c.fonte, evidencia:c.evidencia || `Evidência pública localizada para ${tipo}.`, orgao:""
    });
    accepted++;
  }
  return accepted;
}

async function comprasGovCatalogSearch(q, uf, suppliers, ano = "") {
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

  const maxCatalogCodes = Math.min(Math.max(Number(process.env.CATALOG_MAX_CODES || 12), 1), 20);
  if (catalogMatches.length > maxCatalogCodes) catalogMatches.length = maxCatalogCodes;

  let registros = 0;
  const priceJobs = catalogMatches.slice(0,18).map(async match => {
    try {
      const url = match.tipo === "material" ? priceMaterialUrl : priceServiceUrl;
      const maxPricePages = Math.min(Math.max(Number(process.env.CATALOG_PRICE_PAGES || 3), 1), 6);
      const dateParams = ano ? { dataCompraInicio: `${ano}-01-01`, dataCompraFim: `${ano}-12-31` } : {};
      const pages = await Promise.all(Array.from({length:maxPricePages}, (_,pi) => catalog(url, { pagina:pi+1, tamanhoPagina:500, codigoItemCatalogo:match.codigo, ...(uf ? {estado:uf} : {}), dataResultado:1, ...dateParams }).catch(() => null)));
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
          tipo:"preco_publico",
          descricao:desc, orgao:r?.nomeOrgao || "", uf:String(r?.estado || "").toUpperCase()
        });
      }
    } catch (_) {}
  });
  await Promise.all(priceJobs);
  return { registros, codigosCatalogo: catalogMatches.map(x=>({tipo:x.tipo,codigo:x.codigo,descricao:x.descricao})), fornecedoresCatalogo: suppliers.size };
}

async function comprasGovSearch(q, uf, suppliers, ano = "") {
  return comprasGovCatalogSearch(q, uf, suppliers, ano);
}

async function comprasGovRecentSearch(q, uf, suppliers, ano = "") {
  // Fast secondary source: recent PNCP items already indexed by Compras.gov.br.
  // We inspect a small number of 500-row pages in parallel and filter locally.
  const endpoint = cleanBase(COMPRAS_BASE) + "/modulo-contratacoes/2_consultarItensContratacoes_PNCP_14133";
  const end = ano ? new Date(`${ano}-12-31T23:59:59`) : new Date();
  const begin = ano ? new Date(`${ano}-01-01T00:00:00`) : new Date(end.getTime() - 180*86400000);
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
  const maxPages = 6;
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
  const ano = /^20\d{2}$/.test(String(req.query.ano || "")) ? String(req.query.ano) : "";
  const maxCompras = Math.min(Math.max(Number(req.query.maxCompras || 100), 40), 120);
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
    emit("status", {fase:"busca", mensagem:"Localizando fornecedores em PNCP e Compras.gov.br, incluindo resultados, referências de preço e processos relacionados..."});
    req.on("close", () => { req.__streamClosed = true; });
  }

  const suppliers = new Map();
  const matchedItems = [];
  const purchasesSeen = new Set();
  const analyzedPurchases = new Map();
  let purchasesProcessed = 0;
  let searchPages = [];

  const variants = smartQueryVariants(q, 5);
  try {
    const jobs = [];
    for (const variant of variants) {
      for (let i = 1; i <= 5; i++) {
        jobs.push(pncpSearch(variant, { uf, ano, pagina:i, tamPagina:50 }).catch(err => { console.warn("PNCP busca", variant, i, err.message); return null; }));
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
    if (ano && String(purchase.ano) !== ano) continue;
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
                fonte: "PNCP", tipo: classifyPublicResult(r), descricao:item.descricao, orgao:result?.orgao_nome || "", uf:recordUf || uf || "",
                link:detail.link, evidencia:r?.situacaoCompraItemResultadoNome || r?.motivoCancelamento || (r?.ordemClassificacaoSrp ? `Classificação ${r.ordemClassificacaoSrp}` : "Registro de resultado do item")
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
  await Promise.all(Array.from({length:20}, worker));

  let comprasRows = 0;
  const secondary = await Promise.allSettled([
    comprasGovCatalogSearch(q, uf, suppliers, ano),
    comprasGovRecentSearch(q, uf, suppliers, ano),
    comprasGovArpSearch(q, uf, ano)
  ]);
  if (secondary[0].status === "fulfilled") comprasRows += Number(secondary[0].value?.registros || 0);
  else console.warn("Compras.gov catálogo/preços", secondary[0].reason?.message || secondary[0].reason);
  if (secondary[1].status === "fulfilled") comprasRows += Number(secondary[1].value || 0);
  else console.warn("Compras.gov recente", secondary[1].reason?.message || secondary[1].reason);
  if (secondary[2].status === "fulfilled") {
    const arpRows = secondary[2].value || [];
    for (const r of arpRows.slice(0, 1200)) {
      if (ano) {
        const rawYear = String(r?.dataVigenciaInicial || r?.dataInclusao || r?.dataResultado || r?.ano || "").slice(0,4);
        if (rawYear && rawYear !== ano) continue;
      }
      const cnpj = onlyDigits(r?.cnpjFornecedor || r?.niFornecedor || r?.codFornecedor || "");
      const nome = r?.nomeFornecedor || r?.fornecedorNome || "Fornecedor não informado";
      if (!cnpj && !nome) continue;
      await mapSupplierRecord(suppliers, {
        niFornecedor: cnpj, nomeFornecedor: nome,
        valorUnitarioResultado: r?.valorUnitario || r?.valorUnitarioResultado,
        dataResultado: r?.dataVigenciaInicial || r?.dataInclusao
      }, { fonte: "Compras.gov.br - ARP", tipo:"homologado", descricao: r?.descricaoItem || r?.descricao || "", uf: String(r?.estado || r?.uf || uf || "").toUpperCase(), orgao: r?.nomeOrgao || r?.orgao || "" });
    }
    comprasRows += arpRows.length;
  } else console.warn("Compras.gov ARP", secondary[2].reason?.message || secondary[2].reason);

  // Camada adicional: procura pública por evidências de proposta/participação.
  // Só entra no resultado quando a fonte pública contém CNPJ + indicação de participação/proposta.
  let fornecedoresParticipantes = 0;
  try { fornecedoresParticipantes += await discoverWebParticipants(q, uf, ano, suppliers, emit); } catch (_) {}
  let fornecedoresGoogle = 0;
  try { fornecedoresGoogle = await googleCseDiscoverParticipants(q, uf, ano, suppliers, emit); fornecedoresParticipantes += fornecedoresGoogle; } catch (_) {}

  const list = [...suppliers.values()].map(s => {
    s.razaoSocial = s.nome;
    s.precoMedio = s._priceCount ? s._sum / s._priceCount : null;
    s.fontes = [...s.fontes];
    s.tipos = [...s.tipos];
    s.evidencias = s.evidencias || [];
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
  const usedPhones = new Set();
  for (let i = 0; i < list.length; i += batchSize) {
    const batch = list.slice(i, i + batchSize);
    await Promise.all(batch.map(async s => {
      const shouldUseAi = aiUsed < aiMax;
      if (shouldUseAi) aiUsed++;
      const c = await enrichCompanyContacts(s.cnpj, s.nome, { allowAi: shouldUseAi, allowPublicSearch: true, blockedPhones: usedPhones });
      s.telefone = c.telefone || "SEM TELEFONE PUBLICO";
      if (c.telefone && c.telefone !== "SEM TELEFONE PUBLICO") usedPhones.add(onlyDigits(c.telefone));
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
  adminSearchHistory.unshift({at:Date.now(),query:q,uf,ano,fornecedores:list.length,ms:null,replay:false});
  if (adminSearchHistory.length > 500) adminSearchHistory.length = 500;
  const finalPayload = {
    participacaoWebConfigurada: Boolean(OPENAI_API_KEY || (GOOGLE_CSE_API_KEY && GOOGLE_CSE_ID)),
    fonte: "PNCP + Compras.gov.br (CATMAT/CATSER + preços públicos + cadastro de fornecedor) + dados cadastrais públicos de CNPJ + pesquisa web/IA + Google CSE",
    aviso: "Mapa próprio baseado em dados públicos. A cobertura depende dos registros disponíveis e da resposta das fontes no momento da pesquisa. O Google CSE amplia a descoberta, mas uma empresa só é classificada como participante/proposta/classificada/homologada quando há evidência pública compatível.",
    consulta:q, uf:uf||"TODAS", ano:ano||"TODOS", comprasAnalisadas:purchasesProcessed,
    totalResultadosBusca: searchPages.reduce((n,d)=>n+Number(d?.total||0),0), itensCorrespondentes:matchedItems.length,
    registrosComprasGov:comprasRows, fornecedoresParticipantes, totalFornecedores:list.length, totalMeEpp:list.filter(s=>s.meEpp).length,
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

async function pncpAtaSearch(q, { ano = "", pagina = 1, tamPagina = 50 } = {}) {
  const url = new URL(PNCP_SEARCH_BASE + "/");
  // Para anos históricos, o PNCP precisa ser consultado com status=todos.
  // Não acrescentamos o ano ao texto da busca porque isso pode eliminar ATAs
  // cujo objeto não contém o ano; o ano é conferido depois pelo número de
  // controle PNCP e pelos campos anoAta/data.
  url.searchParams.set("q", q);
  url.searchParams.set("tipos_documento", "ata");
  url.searchParams.set("status", ano ? "todos" : "vigente");
  if (ano) url.searchParams.set("ano", String(ano));
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
  const base = cleanBase(PNCP_API_BASE);
  const url = `${base}/orgaos/${ata.orgao}/compras/${ata.ano}/${ata.compra}/atas/${ata.ata}`;
  try {
    return await fetchJson(url, { timeoutMs: 12000, retries: 2, cacheTtl: 15 * 60 * 1000 });
  } catch (directError) {
    // Fallback oficial: o PNCP também permite consultar todas as atas da compra.
    // Em alguns momentos a rota da ata individual pode responder 404/5xx mesmo
    // com a ATA visível no portal. Recuperamos a ATA pela compra e selecionamos
    // o sequencial correto antes de declarar indisponibilidade.
    const listUrl = `${base}/orgaos/${ata.orgao}/compras/${ata.ano}/${ata.compra}/atas`;
    try {
      const data = await fetchJson(listUrl, { timeoutMs: 12000, retries: 2, cacheTtl: 10 * 60 * 1000 });
      const rows = pncpRows(data);
      const found = rows.find(r => Number(r?.sequencialAta ?? r?.sequencial ?? r?.numeroSequencialAta) === Number(ata.ata));
      if (found) return found;
      if (rows.length === 1 && Number(ata.ata) === 1) return rows[0];
    } catch (_) {}
    throw directError;
  }
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

async function comprasGovArpSearch(q, uf, ano = "") {
  const endpoint = cleanBase(COMPRAS_BASE) + "/modulo-arp/2_consultarARPItem";
  const end = ano ? new Date(`${ano}-12-31T23:59:59`) : new Date();
  const begin = ano ? new Date(`${ano}-01-01T00:00:00`) : new Date(end.getTime() - 730 * 86400000);
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
      error:"O detalhamento automático da ATA não foi recuperado pela API do PNCP neste momento. A ATA continua disponível no portal oficial.",
      validacao:{status:"DETALHAMENTO INDISPONÍVEL", mensagem:e.message || "Falha na consulta detalhada; use o acesso direto ao PNCP."},
      controlePncp:control, link:buildPncpAtaLink({numero_controle_pncp:control})
    });
  }
}

async function ataMap(req, res) {
  await ensureJwt(req);
  const q = String(req.query.q || "").trim();
  if (q.length < 3) return res.status(400).json({error:"Informe pelo menos 3 caracteres para pesquisar a ata."});
  const uf = String(req.query.uf || "").trim().toUpperCase();
  const ano = /^20\d{2}$/.test(String(req.query.ano || "")) ? String(req.query.ano) : "";
  const adesaoOnly = String(req.query.adesao || "true").toLowerCase() !== "false";
  const paginas = Math.min(Math.max(Number(req.query.paginas || (ano ? 12 : 6)),1),20);
  const variants = smartQueryVariants(q, ano ? 4 : 2);
  const atas = new Map();
  const warnings = [];

  const jobs = [];
  for (const variant of variants) for (let i=1;i<=paginas;i++) {
    jobs.push(pncpAtaSearch(variant,{ano,pagina:i,tamPagina:50}).catch(e=>{warnings.push(`PNCP: ${e.message}`);return null;}));
  }
  const pages = await Promise.all(jobs);
  for(const data of pages){
    for(const r of pncpRows(data)){
      const desc = r?.description || r?.descricao || r?.objeto || r?.title || r?.objetoCompra || "";
      if(!descriptionMatchesAny(desc, variants)) continue;
      const control = r?.numero_controle_pncp || r?.numeroControlePNCP || r?.numeroControle || r?.id || "";
      const controlMatch = String(control).match(/\/(20\d{2})-\d+$/);
      const ataYear = String(r?.anoAta || r?.ano || (controlMatch ? controlMatch[1] : "") || r?.dataVigenciaInicial || r?.data_vigencia_inicial || r?.dataAssinatura || r?.data_assinatura || r?.dataPublicacaoPncp || "").slice(0,4);
      if (ano && ataYear && ataYear !== ano) continue;
      const rowUf=String(r?.uf||r?.ufSigla||r?.estado||r?.unidade_federativa||r?.localCompraUf||"").toUpperCase();
      if(uf && rowUf && rowUf!==uf) continue;
      const permite = r?.permiteAdesao ?? r?.possibilidadeAdesao ?? r?.permite_adesao ?? r?.permiteAdesaoAta ?? r?.adesao;
      if(adesaoOnly && permite === false) continue;
      if(adesaoOnly && permite == null) continue;
      const key=String(control || r?.item_url || `${r?.numero||""}-${r?.ano||""}-${r?.orgao_cnpj||""}`);
      const parsed=parseAtaControl(control);
      atas.set(key,{
        fonte:"PNCP", numero:r?.numero||r?.numeroAta||r?.numero_ata||r?.numeroAtaRegistroPreco||"—", ano:r?.ano||r?.anoAta||ataYear||"",
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
          a.validacao={status:"DETALHAMENTO INDISPONÍVEL", mensagem:"O detalhamento automático não respondeu pela API, mas a ATA está disponível no portal oficial do PNCP."};
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
    const arpRows=await comprasGovArpSearch(q,uf,ano);
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

  const list=[...atas.values()]
    .filter(a=>!uf||!a.uf||a.uf===uf)
    .filter(a=>!ano||String(a.ano||a.vigenciaInicio||a.dataPublicacao||"").slice(0,4)===ano)
    // Para anos históricos, não esconda uma ATA apenas porque o PNCP não
    // informou explicitamente possibilidadeAdesao. Ela aparece como
    // "NÃO INFORMADO" e deve ser conferida no documento. Para 2026/vigentes,
    // mantém-se o filtro de adesão solicitado.
    .filter(a=>!adesaoOnly || !!ano || a.permiteAdesao===true);
  list.sort((a,b)=>String(b.vigenciaFim||b.dataPublicacao||"").localeCompare(String(a.vigenciaFim||a.dataPublicacao||"")));
  res.json({consulta:q,uf:uf||"TODAS", ano:ano||"TODOS", somenteComAdesao:adesaoOnly,totalAtas:list.length,atas:list,warnings,
    fonte:"PNCP + Compras.gov.br", observacao:"A indicação de adesão e a vigência vêm dos registros públicos consultados. A disponibilidade efetiva de saldo, limites e autorização para adesão deve ser confirmada no documento da ata e com o órgão gerenciador."});
}

app.post("/api/auth/login", asyncRoute(async (req, res) => {
  const body = req.body || {};
  const usuarioApiToken = String(body.usuarioApiToken ?? body.token ?? "").trim();
  const senha = String(body.senha ?? body.password ?? "");
  if (!usuarioApiToken) return res.status(400).json({ error: "Informe o Token de Acesso API-Banco de Preços." });
  // A senha é opcional para usuários comuns. Se uma senha for informada,
  // ela precisa ser exatamente a senha de administrador configurada no Render.
  // Assim, token sozinho = usuário comum; token + senha correta = administrador.
  if (senha && (!ADMIN_PASSWORD || senha !== ADMIN_PASSWORD)) {
    const sec={at:Date.now(),ip:clientIp(req),tipo:"LOGIN_ADMIN_NEGADO",detalhes:"Senha administrativa incorreta."}; adminSecurityEvents.unshift(sec); if(adminSecurityEvents.length>200)adminSecurityEvents.length=200; adminAlert("Tentativa de login administrativo recusada.","warning",{ip:sec.ip});
    return res.status(403).json({ error: "Senha de administrador incorreta." });
  }
  // Um novo login com token válido libera o IP que havia sido deslogado pelo administrador.
  // As sessões antigas desse IP já foram destruídas pelo endpoint de deslogar.
  revokedIps.delete(clientIp(req));
  req.session.apiToken = usuarioApiToken;
  req.session.jwt = null;
  req.session.jwtExpiresAt = 0;
  try {
    await ensureJwt(req);
    req.session.isAdmin = !!senha && !!ADMIN_PASSWORD && senha === ADMIN_PASSWORD;
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
  res.json({ authenticated: !!req.session.apiToken && !!req.session.jwt, jwtValidUntil: req.session.jwtExpiresAt || null, isAdmin: sessionIsAdmin(req), maintenance: adminState.maintenance, maintenanceMessage: adminState.maintenanceMessage, banner: adminState.banner });
}));
function sessionIsAdmin(req) {
  return req.session?.isAdmin === true;
}

app.get("/api/painel/acessos", asyncRoute(async (req, res) => {
  await ensureJwt(req);
  if (!sessionIsAdmin(req)) return res.status(403).json({ error: "Somente o administrador pode acessar o painel." });
  const ownIp = clientIp(req);
  res.json({ acessos: accessRows(), meuIp: ownIp, souAdmin: sessionIsAdmin(req), inatividadeMs: ACCESS_INACTIVE_MS });
}));

app.post("/api/painel/deslogar-ip", asyncRoute(async (req, res) => {
  await ensureJwt(req);
  if (!sessionIsAdmin(req)) return res.status(403).json({ error: "Somente o administrador pode deslogar acessos." });
  const targetIp = String(req.body?.ip || "").trim();
  const ownIp = clientIp(req);
  if (!targetIp) return res.status(400).json({ error: "Informe o IP que será deslogado." });
  if (targetIp === ownIp) return res.status(400).json({ error: "O seu próprio IP não pode ser deslogado por esta ação." });

  const now = Date.now();
  // O bloqueio por IP é a garantia principal: mesmo que o armazenamento de sessão
  // demore a destruir uma sessão, o próximo heartbeat/API desse IP recebe 401.
  revokedIps.set(targetIp, now + 8 * 60 * 60 * 1000);
  const targets = [...accessLog.values()].filter(row => row.ip === targetIp && row.sessionId !== req.sessionID);
  await Promise.all(targets.map(row => new Promise(resolve => {
    req.sessionStore.destroy(row.sessionId, () => resolve());
  })));
  for (const row of targets) { row.logoutAt = now; row.lastSeenAt = now; row.status = "DESLOGADO PELO PAINEL"; }
  res.json({ ok: true, ip: targetIp, sessoesDeslogadas: targets.length });
}));

app.get("/api/cotacoes", asyncRoute(async (req, res) => res.json(await authenticatedCall(req, "/api/bp4/Cotacoes/GetCotacoes"))));
app.get("/api/cotacoes/completa", asyncRoute(async (req, res) => { const id = Number(req.query.IdCotacao); if (!Number.isInteger(id)) return res.status(400).json({ error: "IdCotacao é obrigatório." }); res.json(await authenticatedCall(req, `/api/bp4/Cotacoes/GetCotacaoCompleta?IdCotacao=${encodeURIComponent(id)}`)); }));
app.get("/api/cotacoes/lotes", asyncRoute(async (req, res) => { const id = Number(req.query.IdCotacao); if (!Number.isInteger(id)) return res.status(400).json({ error: "IdCotacao é obrigatório." }); res.json(await authenticatedCall(req, `/api/bp4/Cotacoes/GetCotacoesLotes?IdCotacao=${encodeURIComponent(id)}`)); }));
app.get("/api/cotacoes/itens", asyncRoute(async (req, res) => { const id = Number(req.query.IdCotacao); if (!Number.isInteger(id)) return res.status(400).json({ error: "IdCotacao é obrigatório." }); res.json(await authenticatedCall(req, `/api/bp4/Cotacoes/GetCotacoesItens?IdCotacao=${encodeURIComponent(id)}`)); }));
app.get("/api/cotacoes/precos", asyncRoute(async (req, res) => { const id = Number(req.query.IdItem); if (!Number.isInteger(id)) return res.status(400).json({ error: "IdItem é obrigatório." }); res.json(await authenticatedCall(req, `/api/bp4/Cotacoes/GetCotacoesPrecosItens?IdItem=${encodeURIComponent(id)}`)); }));
app.post("/api/export/fornecedores", asyncRoute(async (req, res) => {
  if (!req.session?.apiToken) return res.status(401).json({ error: "Não autenticado." });
  if (req.session.revoked) return res.status(401).json({ error: "Sessão encerrada." });
  const fornecedores = Array.isArray(req.body?.fornecedores) ? req.body.fornecedores : [];
  if (!fornecedores.length) return res.status(400).json({ error: "Nenhum fornecedor para exportar." });

  const workbook = new ExcelJS.Workbook();
  workbook.creator = "ST Cotações 1.0";
  workbook.created = new Date();
  const ws = workbook.addWorksheet("Fornecedores", {
    pageSetup: { paperSize: 9, orientation: "portrait", fitToPage: true, fitToWidth: 1, fitToHeight: 0, horizontalDpi: 300, verticalDpi: 300 },
    properties: { defaultRowHeight: 24 },
    views: [{ state: "frozen", ySplit: 1 }]
  });

  ws.columns = [
    { header: "FORNECEDOR", key: "fornecedor", width: 48 },
    { header: "CNPJ", key: "cnpj", width: 24 },
    { header: "E-MAIL", key: "email", width: 48 }
  ];

  const border = { style: "thin", color: { argb: "FF808080" } };
  const baseAlignment = { horizontal: "center", vertical: "center", wrapText: true };
  const headerFill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFC000" } };

  const header = ws.getRow(1);
  header.height = 34;
  header.eachCell(cell => {
    cell.font = { name: "Arial", size: 11, bold: true };
    cell.fill = headerFill;
    cell.alignment = baseAlignment;
    cell.border = { top: border, left: border, bottom: border, right: border };
  });

  for (const item of fornecedores) {
    const row = ws.addRow({
      fornecedor: String(item.fornecedor ?? item.razaoSocial ?? item.nome ?? ""),
      cnpj: String(item.cnpj ?? ""),
      email: String(item.email ?? "")
    });
    row.height = 30;
    row.eachCell(cell => {
      cell.font = { name: "Arial", size: 10 };
      cell.alignment = baseAlignment;
      cell.border = { top: border, left: border, bottom: border, right: border };
      cell.numFmt = "@";
    });
  }

  ws.autoFilter = { from: "A1", to: `C${Math.max(1, ws.rowCount)}` };
  ws.pageSetup.horizontalCentered = true;
  ws.pageSetup.fitToWidth = 1;
  ws.pageSetup.fitToHeight = 0;
  ws.pageSetup.margins = { left: 0.25, right: 0.25, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 };
  ws.headerFooter.oddFooter = "Página &P de &N";
  ws.printTitlesRow = "1:1";

  const buffer = await workbook.xlsx.writeBuffer();
  const filename = `fornecedores-${new Date().toISOString().slice(0,10)}.xlsx`;
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.send(Buffer.from(buffer));
}));

app.post("/api/cotacoes", asyncRoute(async (req, res) => res.json(await authenticatedCall(req, "/api/bp4/Cotacoes/CriarCotacoes", { method: "POST", body: req.body || {} }))));
app.post("/api/cotacoes/itens", asyncRoute(async (req, res) => res.json(await authenticatedCall(req, "/api/bp4/Cotacoes/CriarItens", { method: "POST", body: req.body || {} }))));
app.get("/api/catalogos/unidades", asyncRoute(async (req, res) => res.json(await authenticatedCall(req, "/api/bp4/Cotacoes/GetTodasUnidadeMedida"))));
app.get("/api/catalogos/cidades", asyncRoute(async (req, res) => res.json(await authenticatedCall(req, "/api/bp4/Cotacoes/GetTodasCidades"))));
app.get("/api/fornecedores/mapa", asyncRoute(supplierMap));
app.get("/api/atas/mapa", asyncRoute(ataMap));
app.get("/api/admin/central", asyncRoute(async (req,res)=>{
  await ensureJwt(req); if (!sessionIsAdmin(req)) return res.status(403).json({error:"Acesso exclusivo do administrador."});
  const now=Date.now(); const rows=accessRows();
  const recent=adminEvents.slice(0,80).map(x=>({...x, when:new Date(x.at).toISOString()}));
  const online=rows.filter(x=>x.status==="CONECTADO").length;
  const searches=adminSearchHistory.filter(x=>now-x.at<24*60*60*1000);
  const rank={}; for(const x of adminSearchHistory){ const key=x.ip||"—"; rank[key]=(rank[key]||0)+1; }
  const ranking=Object.entries(rank).sort((a,b)=>b[1]-a[1]).slice(0,10).map(([ip,pesquisas])=>({ip,pesquisas}));
  const total=adminSearchHistory.length; const achievements=[{nome:"Explorador",desc:"10 pesquisas realizadas",ok:total>=10},{nome:"Caçador de fornecedores",desc:"100 fornecedores encontrados",ok:adminSearchHistory.reduce((n,x)=>n+(x.fornecedores||0),0)>=100},{nome:"Pesquisador",desc:"25 pesquisas diferentes",ok:new Set(adminSearchHistory.map(x=>x.query)).size>=25},{nome:"Cientista",desc:"10 replays executados",ok:adminSearchHistory.filter(x=>x.replay).length>=10}];
  res.json({ok:true,online,accesses:rows.slice(0,100),events:recent,ranking,achievements,stats:{pesquisas24h:searches.length,fornecedores24h:searches.reduce((n,x)=>n+(Number(x.fornecedores)||0),0),eventos24h:adminEvents.filter(x=>now-x.at<86400000).length},maintenance:adminState.maintenance,banner:adminState.banner});
}));
app.get("/api/admin/inteligencia", asyncRoute(async (req,res)=>{
  await ensureJwt(req); if (!sessionIsAdmin(req)) return res.status(403).json({error:"Acesso exclusivo do administrador."});
  const now=Date.now(); const history=adminSearchHistory.slice(0,150);
  const byQuery={}; for(const x of history){const k=x.query||"—"; byQuery[k]=(byQuery[k]||0)+1;}
  const topQueries=Object.entries(byQuery).sort((a,b)=>b[1]-a[1]).slice(0,15).map(([query,total])=>({query,total}));
  const sources=[...adminSourceStats.values()].map(x=>({...x,mediaMs:x.chamadas?Math.round(x.totalMs/x.chamadas):0})).sort((a,b)=>b.chamadas-a.chamadas);
  res.json({history,topQueries,sources,totais:{pesquisas:history.length,ultimas24h:history.filter(x=>now-x.at<86400000).length}});
}));
app.get("/api/admin/alertas", asyncRoute(async (req,res)=>{ await ensureJwt(req); if(!sessionIsAdmin(req)) return res.status(403).json({error:"Acesso exclusivo do administrador."}); res.json({alerts:adminAlerts.slice(0,100),maintenance:adminState.maintenance,banner:adminState.banner}); }));
app.post("/api/admin/alertas/ler", asyncRoute(async (req,res)=>{ await ensureJwt(req); if(!sessionIsAdmin(req)) return res.status(403).json({error:"Acesso exclusivo do administrador."}); adminAlerts.forEach(x=>x.read=true); res.json({ok:true}); }));
app.post("/api/admin/cache/clear", asyncRoute(async (req,res)=>{ await ensureJwt(req); if(!sessionIsAdmin(req)) return res.status(403).json({error:"Acesso exclusivo do administrador."}); const size=httpCache.size; httpCache.clear(); adminEvent("CACHE_LIMPO",{itens:size},req); res.json({ok:true,limpos:size}); }));
app.post("/api/admin/maintenance", asyncRoute(async (req,res)=>{ await ensureJwt(req); if(!sessionIsAdmin(req)) return res.status(403).json({error:"Acesso exclusivo do administrador."}); adminState.maintenance=!!req.body?.enabled; const suppliedMessage=String(req.body?.message||"").trim(); if(suppliedMessage) adminState.maintenanceMessage=suppliedMessage; adminEvent("MANUTENCAO",{enabled:adminState.maintenance,message:adminState.maintenanceMessage},req); res.json({ok:true,...adminState}); }));
app.post("/api/admin/banner", asyncRoute(async (req,res)=>{ await ensureJwt(req); if(!sessionIsAdmin(req)) return res.status(403).json({error:"Acesso exclusivo do administrador."}); adminState.banner=String(req.body?.message||"").trim().slice(0,500); adminState.bannerAt=adminState.banner?Date.now():null; adminEvent("AVISO_PUBLICADO",{message:adminState.banner},req); res.json({ok:true,banner:adminState.banner}); }));
app.get("/api/admin/config", asyncRoute(async (req,res)=>{ await ensureJwt(req); if(!sessionIsAdmin(req)) return res.status(403).json({error:"Acesso exclusivo do administrador."}); res.json({ok:true,config:{node:process.version,env:process.env.NODE_ENV||"development",port:PORT,cacheItens:httpCache.size,cacheTtl:DEFAULT_CACHE_TTL,sessionHours:8,contactSearchMax:CONTACT_SEARCH_MAX,hasOpenAI:!!OPENAI_API_KEY,hasGoogle:!!GOOGLE_CSE_API_KEY&&!!GOOGLE_CSE_ID,hasSerper:!!SERPER_API_KEY,hasTransparency:!!process.env.TRANSPARENCIA_API_KEY,hasAdminPassword:!!ADMIN_PASSWORD},securityEvents:adminSecurityEvents.slice(0,50),maintenance:adminState.maintenance,banner:adminState.banner}); }));
app.post("/api/admin/laboratorio", asyncRoute(async (req,res)=>{
  await ensureJwt(req); if(!sessionIsAdmin(req)) return res.status(403).json({error:"Acesso exclusivo do administrador."});
  const source=String(req.body?.source||"").trim().toLowerCase(); const q=String(req.body?.q||"").trim(); const started=Date.now(); let url="";
  if(source==="pncp") { url=`${cleanBase(PNCP_SEARCH_BASE)}/?q=${encodeURIComponent(q||"teste")}&tipos_documento=edital&status=encerradas&ordenacao=-data&pagina=1&tam_pagina=10`; }
  else if(source==="compras") { url=`${cleanBase(COMPRAS_BASE)}/modulo-contratacoes/2_consultarItensContratacoes_PNCP_14133?pagina=1&tamanhoPagina=10&temResultado=true`; }
  else if(source==="brasilapi") { const c=onlyDigits(q); url=`${BRASIL_API_BASE}/${c}`; }
  else if(source==="transparencia") { const c=onlyDigits(q); url=`${cleanBase(process.env.TRANSPARENCIA_API_URL||"https://api.portaldatransparencia.gov.br")}/api-de-dados/ceis?pagina=1&tamanhoPagina=1&codigoSancionado=${c}`; }
  else return res.status(400).json({error:"Fonte de teste inválida."});
  try { const data=await fetchJson(url,{timeoutMs:15000,retries:0,cache:false,headers: source==="transparencia" && process.env.TRANSPARENCIA_API_KEY ? {"chave-api-dados":process.env.TRANSPARENCIA_API_KEY}:undefined}); adminEvent("TESTE_FONTE",{source,url,ms:Date.now()-started,ok:true},req); res.json({ok:true,source,url,ms:Date.now()-started,preview:Array.isArray(data)?data.slice(0,3):data}); } catch(e) { adminAlert(`${source.toUpperCase()} falhou no teste do laboratório.`,"error",{erro:e.message}); adminEvent("TESTE_FONTE",{source,url,ms:Date.now()-started,ok:false,error:e.message},req); res.status(502).json({error:e.message,source,url,ms:Date.now()-started}); }
}));
app.post("/api/admin/replay", asyncRoute(async(req,res)=>{
  await ensureJwt(req); if(!sessionIsAdmin(req)) return res.status(403).json({error:"Acesso exclusivo do administrador."});
  const q=String(req.body?.q||"").trim(); const uf=String(req.body?.uf||"").trim().toUpperCase(); const ano=String(req.body?.ano||"").trim(); if(q.length<3)return res.status(400).json({error:"Informe uma pesquisa com pelo menos 3 caracteres."});
  const suppliers=new Map(); const started=Date.now(); try { await comprasGovCatalogSearch(q,uf,suppliers,ano); await comprasGovRecentSearch(q,uf,suppliers,ano); const total=suppliers.size; adminSearchHistory.unshift({at:Date.now(),query:q,uf,ano,fornecedores:total,replay:true,ms:Date.now()-started}); adminEvent("REPLAY_PESQUISA",{q,uf,ano,total,ms:Date.now()-started},req); res.json({ok:true,total,ms:Date.now()-started,fornecedores:[...suppliers.values()].slice(0,200)}); } catch(e){res.status(502).json({error:e.message});}
}));
app.get("/api/admin/experimental", asyncRoute(async(req,res)=>{ await ensureJwt(req); if(!sessionIsAdmin(req)) return res.status(403).json({error:"Acesso exclusivo do administrador."}); res.json({ok:true,features:[{id:"replay",nome:"Replay de pesquisa",status:"ATIVO"},{id:"sourceHealth",nome:"Saúde das fontes",status:"ATIVO"},{id:"participantEvidence",nome:"Evidência de participação",status:"ATIVO"},{id:"smartExpansion",nome:"Expansão inteligente de termos",status:"ATIVO"}],note:"Recursos experimentais podem mudar sem aviso e não substituem os dados oficiais das fontes."}); }));

app.listen(PORT, () => console.log(`BP4 Site rodando em http://localhost:${PORT}`));
