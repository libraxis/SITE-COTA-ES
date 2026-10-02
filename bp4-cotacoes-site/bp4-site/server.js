const express = require('express');
const app = express();
app.use(express.json());

// Estado global do sistema
let systemSettings = {
  maintenanceMode: false
};

// Middleware para verificar modo de manutenção
app.use((req, res, next) => {
  const isAdmin = req.headers['x-user-role'] === 'admin';
  const isPanelRoute = req.path.startsWith('/api/admin');

  if (systemSettings.maintenanceMode && !isAdmin && !isPanelRoute) {
    return res.status(503).json({ 
      error: 'Sistema em Manutenção', 
      message: 'O site está temporariamente fechado para manutenção. Tente novamente mais tarde.' 
    });
  }
  next();
});

// Endpoint para buscar fornecedores com e-mail corrigido
app.get('/api/fornecedores', (req, res) => {
  const fornecedores = [
    { id: 1, nome: 'Fornecedor A', email: 'contato@fornecedora.com', telefone: '(11) 99999-0001' },
    { id: 2, nome: 'Fornecedor B', email: 'vendas@fornecedorb.com', telefone: '(11) 99999-0002' }
  ];

  const resultado = fornecedores.map(f => ({
    ...f,
    email: f.email || f.contatoEmail || 'Não informado'
  }));

  res.json(resultado);
});

// Endpoints do Painel Admin
app.get('/api/admin/settings', (req, res) => {
  if (req.headers['x-user-role'] !== 'admin') {
    return res.status(403).json({ error: 'Acesso negado. Apenas administradores.' });
  }
  res.json(systemSettings);
});

app.post('/api/admin/maintenance', (req, res) => {
  if (req.headers['x-user-role'] !== 'admin') {
    return res.status(403).json({ error: 'Acesso negado. Apenas administradores.' });
  }
  const { maintenanceMode } = req.body;
  systemSettings.maintenanceMode = Boolean(maintenanceMode);
  res.json({ success: true, maintenanceMode: systemSettings.maintenanceMode });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
