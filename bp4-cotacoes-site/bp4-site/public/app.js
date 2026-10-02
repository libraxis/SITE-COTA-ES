// Estado do usuário atual
let currentUser = {
  name: 'Administrador',
  role: 'admin' // Altere para 'user' para testar visão comum
};

document.addEventListener('DOMContentLoaded', () => {
  initApp();
});

function initApp() {
  renderNavigation();
  carregarFornecedores();
  verificarModoManutencao();
}

function renderNavigation() {
  const navPainelTab = document.getElementById('tab-painel');
  if (navPainelTab) {
    // Esconde/Exibe a aba PAINEL baseado no perfil de admin
    if (currentUser.role === 'admin') {
      navPainelTab.style.display = 'block';
      carregarPainelAdmin();
    } else {
      navPainelTab.style.display = 'none';
    }
  }
}

// Correção da exibição do e-mail de fornecedores
async function carregarFornecedores() {
  try {
    const response = await fetch('/api/fornecedores', {
      headers: { 'x-user-role': currentUser.role }
    });
    const fornecedores = await response.json();

    const tabela = document.getElementById('tabela-fornecedores');
    if (!tabela) return;

    tabela.innerHTML = fornecedores.map(f => `
      <tr>
        <td>${f.id}</td>
        <td>${f.nome}</td>
        <td>${f.email && f.email !== 'NÃO ENCONTRADO' ? f.email : (f.contatoEmail || 'Não informado')}</td>
        <td>${f.telefone || '-'}</td>
      </tr>
    `).join('');
  } catch (err) {
    console.error('Erro ao carregar fornecedores:', err);
  }
}

// Carrega as configurações no Painel Admin
async function carregarPainelAdmin() {
  if (currentUser.role !== 'admin') return;

  try {
    const res = await fetch('/api/admin/settings', {
      headers: { 'x-user-role': currentUser.role }
    });
    const settings = await res.json();

    const toggleMaintenance = document.getElementById('toggle-manutencao');
    if (toggleMaintenance) {
      toggleMaintenance.checked = settings.maintenanceMode;
    }
  } catch (err) {
    console.error('Erro ao carregar configurações do painel:', err);
  }
}

// Alternar Modo de Manutenção (Somente Admin)
async function alternarManutencao(status) {
  if (currentUser.role !== 'admin') {
    alert('Apenas o Administrador pode alterar o status de manutenção do site.');
    return;
  }

  try {
    const res = await fetch('/api/admin/maintenance', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-user-role': currentUser.role
      },
      body: JSON.stringify({ maintenanceMode: status })
    });
    
    const data = await res.json();
    if (data.success) {
      alert(`Site ${data.maintenanceMode ? 'FECHADO para manutenção' : 'ABERTO normalmente'}.`);
    }
  } catch (err) {
    console.error('Erro ao alterar modo de manutenção:', err);
  }
}

function verificarModoManutencao() {
  // Lógica opcional de verificação no carregamento inicial
}
