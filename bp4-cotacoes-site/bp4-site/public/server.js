
const express = require("express");
const session = require("express-session");
const cookieParser = require("cookie-parser");
const crypto = require("crypto");
const path = require("path");

const app = express();
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
    const err = new Error(
      (data && (data.message || data.mensagem || data.title)) ||
      `Falha na autenticação BP4 (HTTP ${response.status})`
    );
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

  await ensureJwt(req);
  res.json({ ok: true, message: "Autenticado com sucesso. JWT válido por até 8 horas." });
}));

app.post("/api/auth/logout", asyncRoute(async (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
}));

app.get("/api/auth/status", asyncRoute(async (req, res) => {
  res.json({
    authenticated: !!req.session.apiToken,
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

app.get("/api/catalogos/unidades", asyncRoute(async (req, res) => {
  res.json(await authenticatedCall(req, "/api/bp4/Cotacoes/GetTodasUnidadeMedida"));
}));

app.get("/api/catalogos/cidades", asyncRoute(async (req, res) => {
  res.json(await authenticatedCall(req, "/api/bp4/Cotacoes/GetTodasCidades"));
}));

app.listen(PORT, () => {
  console.log(`BP4 Site rodando em http://localhost:${PORT}`);
});
