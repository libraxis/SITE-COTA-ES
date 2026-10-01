
# BP4 Cotações — site completo

Este projeto implementa uma interface web para as funções descritas no `swagger.json` enviado pelo usuário.

## Funções

- Autenticação com `POST /api/bp4/Auth/CreateUserToken`
- Listagem de cotações
- Cotação completa
- Lotes
- Itens
- Preços por item
- Criação de cotação
- Criação de item
- Lista de unidades de medida
- Lista de cidades

## Requisitos

- Node.js 18 ou superior

## Instalação

```bash
npm install
npm start
```

Abra:

```text
http://localhost:3000
```

## Segurança

O `usuarioApiToken` é recebido pelo backend e guardado apenas na sessão do servidor. O navegador não chama diretamente a BP4 e não recebe o token API.

Para produção, defina uma chave forte:

```bash
SESSION_SECRET="uma-chave-longa-e-aleatoria"
```

e use HTTPS.

## Observação

O projeto foi construído a partir do OpenAPI fornecido. A API informa no Swagger que o JWT é válido por 8 horas; o backend reaproveita o JWT durante a sessão e solicita outro quando estiver perto de expirar.

O retorno real de alguns endpoints pode variar em formato; a interface tenta localizar arrays comuns (`data`, `resultado`, `itens`, `precos` etc.) e também exibe o JSON bruto para inspeção.
