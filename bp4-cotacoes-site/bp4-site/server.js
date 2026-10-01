
const express = require("express");
const session = require("express-session");
const cookieParser = require("cookie-parser");
const crypto = require("crypto");
const path = require("path");

const app = express();
// Render/Reverse proxy: permite que express-session reconheça HTTPS e envie o cookie seguro.
app.set("trust proxy", 1);
const PORT = process.env.PORT || 3000;
const BP4_BASE = process.env.BP4_BASE_URL || "https://api.bancodeprecos.com.br";

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

function cleanBase() {
  return BP4_BASE.replace(/\/+$/, "");
}

async function bp4Fetch(endpoint, options = {}) {
  if (!options.skipAuth) {
    const token = reqToken(options.req);
    if (!token) {
      const err = new Error("Não autenticado");
      err.status = 401;
      throw err;
    }
  }
  const url = cleanBase() + endpoint;
  const headers = { "Accept": "application/json, text/plain, */*" };
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  if (!options.skipAuth) headers["Authorization"] = `Bearer ${reqToken(options.req)}`;

  const response = await fetch(url, {
    method: options.method || "GET",
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined
  });

  const text = await response.text();
  let data = text;
  try { data = text ? JSON.parse(text) : null; } catch (_) {}

  if (!response.ok) {
    const err = new Error(
      (data && (data.message || data.mensagem || data.title)) ||
      `BP4 respondeu HTTP ${response.status}`
    );
    err.status = response.status;
    err.data = data;
    throw err;
  }
  return data;
}

function reqToken(req) {
  return req.session && req.session.jwt;
}

async function ensureJwt(req) {
  if (!req.session.apiToken) {
    const err = new Error("Informe o Token de Acesso API-Banco de Preços.");
    err.status = 401;
    throw err;
  }

  // If we have a recent JWT, reuse it. JWT lifetime documented by BP4 is 8h.
  if (req.session.jwt && req.session.jwtExpiresAt && Date.now() < req.session.jwtExpiresAt - 60_000) {
    return req.session.jwt;
  }

  const response = await fetch(cleanBase() + "/api/bp4/Auth/CreateUserToken", {
    method: "POST",
    headers: {"Content-Type": "application/json", "Accept": "application/json, text/plain, */*"},
    body: JSON.stringify({ usuarioApiToken: req.session.apiToken })
  });

  const text = await response.text();
  let data = text;
  try { data = text ? JSON.parse(text) : null; } catch (_) {}

  if (!response.ok || !data || !data.token) {
    let message = (data && (data.message || data.mensagem || data.title)) ||
      `Falha na autenticação BP4 (HTTP ${response.status})`;
    if (response.status === 401) {
      message = "O Token de Acesso API-Banco de Preços foi rejeitado pela BP4. Confira o token em Configurações > Preferências > Token de Acesso API-Banco de Preços.";
    }
    const err = new Error(message);
    err.status = response.status || 401;
    err.data = data;
    throw err;
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
    res.status(err.status || 500).json({
      error: err.message || "Erro interno",
      details: err.data ?? null
    });
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
    req.session.apiToken = null;
    req.session.jwt = null;
    req.session.jwtExpiresAt = 0;
    await new Promise(resolve => req.session.save(() => resolve()));
    throw err;
  }
}));

app.post("/api/auth/logout", asyncRoute(async (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
}));

app.get("/api/auth/status", asyncRoute(async (req, res) => {
  if (req.session.apiToken) await ensureJwt(req);
  res.json({
    authenticated: !!req.session.apiToken && !!req.session.jwt,
    jwtValidUntil: req.session.jwtExpiresAt || null
  });
}));

app.get("/api/cotacoes", asyncRoute(async (req, res) => {
  res.json(await authenticatedCall(req, "/api/bp4/Cotacoes/GetCotacoes"));
}));

app.get("/api/cotacoes/completa", asyncRoute(async (req, res) => {
  const id = Number(req.query.IdCotacao);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "IdCotacao é obrigatório." });
  res.json(await authenticatedCall(req, `/api/bp4/Cotacoes/GetCotacaoCompleta?IdCotacao=${encodeURIComponent(id)}`));
}));

app.get("/api/cotacoes/lotes", asyncRoute(async (req, res) => {
  const id = Number(req.query.IdCotacao);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "IdCotacao é obrigatório." });
  res.json(await authenticatedCall(req, `/api/bp4/Cotacoes/GetCotacoesLotes?IdCotacao=${encodeURIComponent(id)}`));
}));

app.get("/api/cotacoes/itens", asyncRoute(async (req, res) => {
  const id = Number(req.query.IdCotacao);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "IdCotacao é obrigatório." });
  res.json(await authenticatedCall(req, `/api/bp4/Cotacoes/GetCotacoesItens?IdCotacao=${encodeURIComponent(id)}`));
}));

app.get("/api/cotacoes/precos", asyncRoute(async (req, res) => {
  const id = Number(req.query.IdItem);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "IdItem é obrigatório." });
  res.json(await authenticatedCall(req, `/api/bp4/Cotacoes/GetCotacoesPrecosItens?IdItem=${encodeURIComponent(id)}`));
}));

app.post("/api/cotacoes", asyncRoute(async (req, res) => {
  res.json(await authenticatedCall(req, "/api/bp4/Cotacoes/CriarCotacoes", {
    method: "POST",
    body: req.body || {}
  }));
}));

app.post("/api/cotacoes/itens", asyncRoute(async (req, res) => {
  res.json(await authenticatedCall(req, "/api/bp4/Cotacoes/CriarItens", {
    method: "POST",
    body: req.body || {}
  }));
}));



function normalizeSearchText(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function normalizeCnpj(value) {
  return String(value ?? "").replace(/\D/g, "");
}

function formatCnpj(value) {
  const digits = normalizeCnpj(value);
  if (digits.length !== 14) return String(value ?? "");
  return digits.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, "$1.$2.$3/$4-$5");
}

function extractArray(data) {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== "object") return [];
  for (const key of ["data", "dados", "result", "resultado", "cotacoes", "itens", "precos", "items"]) {
    if (Array.isArray(data[key])) return data[key];
  }
  return Object.values(data).find(Array.isArray) || [];
}

async function lookupPublicSupplier(cnpj) {
  const digits = normalizeCnpj(cnpj);
  if (digits.length !== 14) return { cnpj: formatCnpj(cnpj), telefone: "SEM TELEFONE PUBLICO" };

  try {
    const response = await fetch(`https://brasilapi.com.br/cnpj/v1/${digits}`, {
      headers: { "Accept": "application/json" }
    });
    if (!response.ok) return { cnpj: formatCnpj(digits), telefone: "SEM TELEFONE PUBLICO" };
    const data = await response.json();
    const phones = [data.ddd_telefone_1, data.ddd_telefone_2]
      .map(v => String(v || "").replace(/\D/g, ""))
      .filter(Boolean);
    return {
      cnpj: formatCnpj(digits),
      telefone: phones.length ? phones.join(" / ") : "SEM TELEFONE PUBLICO",
      razaoSocial: data.razao_social || data.nome_fantasia || "",
      nomeFantasia: data.nome_fantasia || ""
    };
  } catch (_) {
    return { cnpj: formatCnpj(digits), telefone: "SEM TELEFONE PUBLICO" };
  }
}

app.get("/api/fornecedores", asyncRoute(async (req, res) => {
  const query = String(req.query.descricao || "").trim();
  if (query.length < 2) return res.status(400).json({ error: "Informe pelo menos 2 caracteres do descritivo do item." });

  const normalizedQuery = normalizeSearchText(query);
  const terms = normalizedQuery.split(/\s+/).filter(Boolean);
  const cotacoesData = await authenticatedCall(req, "/api/bp4/Cotacoes/GetCotacoes");
  const cotacoes = extractArray(cotacoesData);

  // A BP4 API disponibilizada neste projeto não possui um endpoint de busca global de itens.
  // Portanto, a pesquisa percorre os itens das cotações visíveis à conta autenticada e,
  // para os itens compatíveis, consulta os preços/fornecedores retornados pela BP4.
  const matches = [];
  for (const cotacao of cotacoes.slice(0, 100)) {
    const id = Number(cotacao.idCotacao ?? cotacao.IdCotacao ?? cotacao.id);
    if (!Number.isInteger(id)) continue;
    let itens = [];
    try {
      const itensData = await authenticatedCall(req, `/api/bp4/Cotacoes/GetCotacoesItens?IdCotacao=${encodeURIComponent(id)}`);
      itens = extractArray(itensData);
    } catch (_) {
      continue;
    }
    for (const item of itens) {
      const text = normalizeSearchText(`${item.nomeItem || ""} ${item.descricao || ""}`);
      if (terms.every(term => text.includes(term))) {
        matches.push({
          idCotacao: id,
          idItem: Number(item.idCotacaoItem ?? item.IdCotacaoItem ?? item.idItem ?? item.id),
          nomeItem: item.nomeItem || "",
          descricao: item.descricao || ""
        });
      }
    }
  }

  const uniqueMatches = [];
  const seenItems = new Set();
  for (const match of matches) {
    if (!Number.isInteger(match.idItem) || seenItems.has(match.idItem)) continue;
    seenItems.add(match.idItem);
    uniqueMatches.push(match);
  }

  const fornecedores = new Map();
  for (const match of uniqueMatches.slice(0, 50)) {
    let precos = [];
    try {
      const precosData = await authenticatedCall(req, `/api/bp4/Cotacoes/GetCotacoesPrecosItens?IdItem=${encodeURIComponent(match.idItem)}`);
      precos = extractArray(precosData);
    } catch (_) {
      continue;
    }
    for (const preco of precos) {
      const cnpj = normalizeCnpj(preco.cnpjFornecedor);
      if (cnpj.length !== 14) continue;
      const current = fornecedores.get(cnpj) || {
        cnpj,
        ocorrencias: 0,
        itens: new Set(),
        fontes: new Set()
      };
      current.ocorrencias += 1;
      current.itens.add(match.idItem);
      if (preco.fontePesquisa) current.fontes.add(preco.fontePesquisa);
      fornecedores.set(cnpj, current);
    }
  }

  const base = [...fornecedores.values()]
    .sort((a, b) => b.ocorrencias - a.ocorrencias)
    .slice(0, 100);

  // Consulta telefones públicos somente para os CNPJs encontrados na BP4, sem armazená-los.
  const enriched = [];
  for (const supplier of base) {
    const publicData = await lookupPublicSupplier(supplier.cnpj);
    enriched.push({
      cnpj: publicData.cnpj,
      razaoSocial: publicData.razaoSocial || "",
      nomeFantasia: publicData.nomeFantasia || "",
      telefone: publicData.telefone,
      ocorrencias: supplier.ocorrencias,
      quantidadeItens: supplier.itens.size,
      fontes: [...supplier.fontes].join(", ") || "—"
    });
  }

  res.json({
    consulta: query,
    itensEncontrados: uniqueMatches.length,
    fornecedores: enriched,
    observacao: "A pesquisa usa os itens das cotações visíveis à conta autenticada e os fornecedores presentes nos preços retornados pela BP4. O telefone, quando disponível, é consultado em cadastro público por CNPJ."
  });
}));

app.get("/api/catalogos/unidades", asyncRoute(async (req, res) => {
  res.json(await authenticatedCall(req, "/api/bp4/Cotacoes/GetTodasUnidadeMedida"));
}));

app.get("/api/catalogos/cidades", asyncRoute(async (req, res) => {
  res.json(await authenticatedCall(req, "/api/bp4/Cotacoes/GetTodasCidades"));
}));

app.listen(PORT, () => {
  console.log(`BP4 Site rodando em http://localhost:${PORT}`);
});
