# Manual Técnico — `mcpcotacaomutual`

Servidor **MCP (Model Context Protocol)** para **cotação e compra de criptoativos via Mutual API v2**, publicado em produção em:

```
https://mcpcotacaomutual.talkhub.me
```

Este manual leva você do `mkdir` até o servidor MCP rodando em produção na sua VPS (Docker Swarm + Traefik + Portainer + rede `talkhub`), sem conflitar com os serviços que já estão de pé.

> **Diretório base usado em todo o manual:** `/root/mcpcotacaomutual.talkhub.me`
> Você está logado como `root@talkhub:~#`, então `~` = `/root`.

---

## Índice

1. [Visão geral e arquitetura](#1-visão-geral-e-arquitetura)
2. [O que o servidor expõe (as 4 tools)](#2-o-que-o-servidor-expõe-as-4-tools)
3. [Pré-requisitos e verificações na VPS](#3-pré-requisitos-e-verificações-na-vps)
4. [Estrutura de arquivos do projeto](#4-estrutura-de-arquivos-do-projeto)
5. [Implantação passo a passo (do mkdir ao deploy)](#5-implantação-passo-a-passo-do-mkdir-ao-deploy)
6. [Validação end-to-end](#6-validação-end-to-end)
7. [Como consumir o MCP (Claude, agentes, n8n)](#7-como-consumir-o-mcp-claude-agentes-n8n)
8. [Gerenciamento via Portainer](#8-gerenciamento-via-portainer)
9. [Operação: logs, update, rollback, scale, remoção](#9-operação-logs-update-rollback-scale-remoção)
10. [Segurança](#10-segurança)
11. [Troubleshooting](#11-troubleshooting)
12. [Mapa Mutual ↔ tools](#12-mapa-mutual--tools)
13. [Pontos em aberto do projeto](#13-pontos-em-aberto-do-projeto)
14. [Cheat sheet (comandos rápidos)](#14-cheat-sheet-comandos-rápidos)

---

## 1. Visão geral e arquitetura

O `mcpcotacaomutual` é um **servidor MCP HTTP** (transporte *Streamable HTTP*, stateless). Ele expõe a Mutual API v2 como **ferramentas (tools)** que qualquer cliente MCP (Claude, seus agentes evo-ai/clawdbot, n8n, etc.) pode chamar para: listar merchants, consultar fees, **cotar** e **comprar** criptoativos.

Ele **guarda as chaves da Mutual no servidor** (nunca no chatbot/frontend), aplica autenticação Bearer no endpoint, mascara segredos em log, e roteia cada operação para o ambiente correto da Mutual:

* **Produção** (`apis.mutual.app.br`): `merchants`, `fees` — validados em prod.
* **Homologação** (`apis-hml.mutual.app.br`): `crypto/quote`, `crypto/orders` — validados em HML.

```
Internet (HTTPS :443)
        │
        ▼
   ┌──────────┐     rede overlay externa "talkhub"
   │ Traefik  │──────────────────────────────────────┐
   │  v3.4    │                                       │
   └──────────┘                                       ▼
 Host(`mcpcotacaomutual.talkhub.me`)        ┌─────────────────────────────┐
 TLS Let's Encrypt (certresolver)           │  mcpcotacaomutual            │
                                            │  container Node 22 (:3000)   │
                                            │  Express + MCP SDK           │
                                            │  Streamable HTTP  ->  /mcp   │
                                            │  health           ->  /health│
                                            └──────────────┬──────────────┘
                                                           │ Authorization: Bearer ak_...
                                                           │ x-service-token: ...
                                                           ▼
                                            ┌─────────────────────────────┐
                                            │        Mutual API v2         │
                                            │  prod -> merchants / fees    │
                                            │  hml  -> quote / orders      │
                                            └─────────────────────────────┘
```

**Por que atrás do Traefik na rede `talkhub`:** é exatamente o padrão dos seus outros MCPs (`mcpmutual`, `mcptalkads`, `olist-mcp`, etc.). Você **não publica portas no host** — o Traefik fala com o container pela rede overlay, roteando por *hostname*. Por isso o container pode escutar na porta `3000` internamente **sem conflitar** com os outros que também usam `3000` (cada serviço tem seu próprio namespace de rede no overlay).

---

## 2. O que o servidor expõe (as 4 tools)

| Tool MCP | Tipo | Mutual (ambiente) | O que faz |
| --- | --- | --- | --- |
| `mutual_list_merchants` | leitura | `GET /api/v2/resource/merchants` (prod) | Lista merchants com paginação. |
| `mutual_get_merchant_fees` | leitura | `GET /api/v2/resource/fees/merchant/{id}` (prod) | Fees por merchant (operation + sourceAsset + destinationAsset). |
| `mutual_get_crypto_quote` | leitura | `GET /api/v2/crypto/quote` (hml) | Gera cotação com validade curta (`quote_id`, `price`, `expires_at`). |
| `mutual_create_crypto_order` | **destrutiva** | `POST /api/v2/crypto/orders` (hml) | **Cria ordem real** (movimenta valor). Idempotência por `externalId`. |

Endpoints HTTP do próprio servidor:

| Rota | Método | Auth | Uso |
| --- | --- | --- | --- |
| `/mcp` | `POST` | Bearer | Canal MCP (JSON-RPC / Streamable HTTP). |
| `/mcp` | `GET`/`DELETE` | Bearer | Retorna 405 (modo stateless usa só `POST`). |
| `/health` | `GET` | aberto | Healthcheck do Docker. |
| `/` | `GET` | aberto | Info pública (nome, versão, endpoint) — sem segredos. |

As `annotations` MCP já vêm corretas: as três primeiras são `readOnlyHint: true`; a de ordem é `destructiveHint: true` — isso faz clientes MCP exibirem confirmação antes de executar.

---

## 3. Pré-requisitos e verificações na VPS

Rode estes comandos **antes** de implantar. Eles garantem que nada vai conflitar.

### 3.1 Swarm ativo e rede `talkhub`

```bash
docker info --format 'Swarm: {{.Swarm.LocalNodeState}}'   # deve dizer: active
docker network ls | grep -i talkhub                        # deve listar a rede talkhub
```

Se a rede não existir (improvável, pois seus serviços já a usam):

```bash
docker network create --driver overlay --attachable talkhub
```

### 3.2 Descobrir o entrypoint e o certresolver corretos do Traefik

O stack deste projeto usa, por padrão, `entrypoints=websecure` e `certresolver=letsencryptresolver`. **Confirme** os nomes reais do *seu* Traefik para o TLS funcionar de primeira:

```bash
# Opção A: olhar os argumentos do próprio Traefik
docker service inspect traefik_traefik \
  --format '{{json .Spec.TaskTemplate.ContainerSpec.Args}}' \
  | tr ',' '\n' | grep -Ei 'entrypoint|websecure|certificatesresolvers|acme'

# Opção B: copiar de um serviço web que JÁ funciona com HTTPS hoje
for s in $(docker service ls --format '{{.Name}}'); do
  echo "== $s =="
  docker service inspect "$s" --format '{{range .Spec.Labels}}{{println .}}{{end}}' 2>/dev/null \
    | grep -Ei 'entrypoints|certresolver'
done
```

* Se aparecer `--entrypoints.websecure.address=:443` e `--certificatesresolvers.letsencryptresolver.acme...`, **não precisa mudar nada**.
* Se os nomes forem outros (ex.: entrypoint `https`, resolver `le`), anote e ajuste as labels do `docker-compose.yml` (passo 5.5).

### 3.3 Confirmar que a porta interna 3000 não é problema

Não é. Você **não vai publicar** a porta 3000 no host (não há `ports:` no stack). O Traefik acessa o container pela rede `talkhub`, roteando por Host header. Os outros containers em `3000` continuam isolados. Apenas confirme que o stack **não** tem bloco `ports:` (não tem).

### 3.4 DNS

Você informou que `mcpcotacaomutual.talkhub.me` já está apontado. Confirme:

```bash
dig +short mcpcotacaomutual.talkhub.me        # deve retornar o IP público da VPS
```

O Let's Encrypt só emite o certificado depois que o DNS resolve para a VPS e o stack está no ar.

---

## 4. Estrutura de arquivos do projeto

Todos os arquivos ficam em `/root/mcpcotacaomutual.talkhub.me`:

```
mcpcotacaomutual.talkhub.me/
├── docker-compose.yml        # Stack Swarm (Traefik + rede talkhub + healthcheck)
├── Dockerfile                # Build multi-stage (compila TS -> imagem enxuta)
├── .dockerignore
├── .gitignore
├── .env.example              # Modelo de variáveis (copie para .env)
├── .env                      # SEGREDOS reais (criado por você; chmod 600; não versionar)
├── package.json
├── package-lock.json
├── tsconfig.json
├── README.md                 # Este manual
└── src/
    ├── index.ts              # Bootstrap: Express + Streamable HTTP + /health + auth Bearer
    ├── server.ts             # Fábrica do McpServer (registra as tools)
    ├── tools.ts              # As 4 tools MCP (schemas Zod + annotations + erros)
    ├── config.ts             # Carrega/valida variáveis de ambiente
    ├── constants.ts          # Nome/versão/base URLs/timeout
    ├── logger.ts             # Log JSON em stderr + mascaramento de segredos
    ├── types.ts              # Tipos das respostas da Mutual
    └── mutual/
        ├── client.ts         # Clientes axios (prod + hml + "crypto")
        ├── merchants.ts      # fetchMerchants / fetchMerchantFees
        ├── quote.ts          # fetchCryptoQuote
        └── orders.ts         # createCryptoOrder
```

**Responsabilidades em resumo:**

* `mutual/client.ts` cria dois clientes axios (prod e hml) já com `Authorization: Bearer` + `x-service-token`. O cliente `crypto` aponta para prod **ou** hml conforme `MUTUAL_CRYPTO_ENV`.
* `tools.ts` é o coração: valida entradas com **Zod** (`.strict()`), chama a Mutual, formata a resposta como JSON e devolve erros **acionáveis** (404, 401/403, 429, timeout, etc.).
* `index.ts` sobe o Express, expõe `/mcp` (com guarda Bearer), `/health` e `/`. Em modo stateless, cria uma instância de `McpServer` + transport **por requisição** (evita colisão de IDs).

> **Regras de negócio (spread, comparação de fee do merchant, controle de expiração persistente, anti-duplicação por banco)** ficam **no backend consumidor**, não aqui. Este MCP é uma camada fina e fiel sobre a Mutual. A `mutual_get_crypto_quote` já retorna `valid` e `expires_in_seconds` para facilitar a decisão do agente.

---

## 5. Implantação passo a passo (do mkdir ao deploy)

### 5.1 Criar a pasta e entrar nela

```bash
cd /root
mkdir -p mcpcotacaomutual.talkhub.me
cd mcpcotacaomutual.talkhub.me
```

### 5.2 Colocar os arquivos do projeto na pasta

Suba o conteúdo do projeto para `/root/mcpcotacaomutual.talkhub.me` de uma destas formas:

* **scp** a partir da sua máquina:

  ```bash
  scp -r ./mcpcotacaomutual.talkhub.me/* root@SEU_IP:/root/mcpcotacaomutual.talkhub.me/
  ```
* **git** (se versionar): `git clone ... .` dentro da pasta.
* ou cole arquivo por arquivo com `nano`/`vim`.

Confirme a estrutura:

```bash
ls -la
ls -la src src/mutual
```

> Não é preciso enviar `node_modules/` nem `dist/` — o **Docker build** gera tudo dentro da imagem.

### 5.3 Configurar o `.env`

```bash
cp .env.example .env
nano .env
```

Preencha com as credenciais validadas do projeto:

```env
PORT=3000
TRANSPORT=http

MUTUAL_PROD_BASE_URL=https://apis.mutual.app.br
MUTUAL_HML_BASE_URL=https://apis-hml.mutual.app.br
MUTUAL_CRYPTO_ENV=hml

MUTUAL_API_KEY=ak_SUA_CHAVE_AQUI
MUTUAL_SERVICE_TOKEN=8f4c9e2d71ab3c56d0e8f1a9472b6c3d5a9e0f4b8c1d7e2f6a3b9c5d8e1f7a4

MCP_AUTH_TOKEN=COLE_O_RESULTADO_DO_COMANDO_ABAIXO
```

Gere o `MCP_AUTH_TOKEN` (protege o `/mcp`):

```bash
openssl rand -hex 32
```

Cole o valor em `MCP_AUTH_TOKEN`, salve, e proteja o arquivo:

```bash
chmod 600 .env
```

> **Evite caracteres de shell** (`$`, crase, aspas) nos valores do `.env`, pois o deploy faz `source .env`. Tokens hexadecimais e a chave `ak_...` são seguros.

### 5.4 Build da imagem local

Na sua VPS as imagens dos MCPs são **buildadas localmente** (sem registry). Faça o mesmo:

```bash
docker build -t mcpcotacaomutual:latest .
```

Confirme:

```bash
docker images | grep mcpcotacaomutual
```

### 5.5 Ajustar as labels do Traefik (se necessário)

Se a verificação 3.2 mostrou **outros** nomes, edite `docker-compose.yml` e troque:

```yaml
- traefik.http.routers.mcpcotacaomutual.entrypoints=websecure                  # <- seu entrypoint
- traefik.http.routers.mcpcotacaomutual.tls.certresolver=letsencryptresolver   # <- seu resolver
```

Se já batem (`websecure` + `letsencryptresolver`), **não mude nada**.

### 5.6 Deploy do stack

O stack lê os segredos do `.env` via substituição de variáveis. Faça:

```bash
set -a
source .env
set +a
docker stack deploy -c docker-compose.yml mcpcotacaomutual
```

> O `set -a; source .env; set +a` é necessário porque o `docker stack deploy` substitui `${VAR}` a partir do ambiente do shell — ele **ignora** `env_file`/`.env` automático (diferente do `docker compose`).

### 5.7 Verificar o serviço e os logs

```bash
docker stack services mcpcotacaomutual                          # REPLICAS deve ficar 1/1
docker service ps mcpcotacaomutual_mcpcotacaomutual --no-trunc  # estado das tasks
docker service logs -f mcpcotacaomutual_mcpcotacaomutual        # logs (Ctrl+C p/ sair)
```

Nos logs você deve ver algo como:

```json
{"ts":"...","level":"info","msg":"Clientes Mutual inicializados","meta":{"apiKey":"ak_S****a4","serviceToken":"8f4c****7a4","cryptoEnv":"hml"}}
{"ts":"...","level":"info","msg":"MCP server (HTTP) iniciado","meta":{"port":3000,"endpoint":"/mcp","authRequired":true}}
```

`REPLICAS 1/1` + status `Running` + healthcheck `healthy` = no ar. Prossiga para a validação.

---

## 6. Validação end-to-end

Defina o token no shell para facilitar (use o mesmo `MCP_AUTH_TOKEN` do `.env`):

```bash
export TOKEN="cole_aqui_o_MCP_AUTH_TOKEN"
export BASE="https://mcpcotacaomutual.talkhub.me"
```

> O endpoint MCP exige o header `Accept: application/json, text/event-stream` (negociação do transporte Streamable HTTP). Sem ele, o servidor recusa.

### 6.1 Healthcheck e info (público)

```bash
curl -s $BASE/health ; echo
curl -s $BASE/       ; echo
```

Esperado: `{"status":"ok",...}` e o JSON de info com `"authRequired":true`.

### 6.2 Auth: chamada sem token deve dar 401

```bash
curl -s -o /dev/null -w "HTTP %{http_code}\n" -X POST $BASE/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
# Esperado: HTTP 401
```

### 6.3 Handshake MCP: `initialize`

```bash
curl -s -X POST $BASE/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"1.0"}}}' | jq
```

Esperado: `result.serverInfo.name = "mutual-crypto-mcp-server"`.

### 6.4 Listar as tools

```bash
curl -s -X POST $BASE/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' | jq '.result.tools[].name'
```

Esperado: as 4 tools (`mutual_list_merchants`, `mutual_get_merchant_fees`, `mutual_get_crypto_quote`, `mutual_create_crypto_order`).

### 6.5 Chamar tools reais (contra a Mutual)

**Listar merchants:**

```bash
curl -s -X POST $BASE/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"mutual_list_merchants","arguments":{"page":1,"limit":10}}}' | jq
```

**Fees de um merchant** (use um `id` retornado acima):

```bash
curl -s -X POST $BASE/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"mutual_get_merchant_fees","arguments":{"merchantId":"org_3DXaWmcAaguU8rn2ryheTS2kRdw"}}}' | jq
```

**Cotação:**

```bash
curl -s -X POST $BASE/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"mutual_get_crypto_quote","arguments":{"amount":100,"sourceAsset":"BRL","targetAsset":"BTC","targetNetwork":"BITCOIN","symbol":"BTC-BRL"}}}' | jq
```

O texto retornado traz `quote.quote_id`, `quote.price`, `quote.expires_at`, além de `valid` e `expires_in_seconds`.

**Criar ordem (DESTRUTIVA — cria ordem real; em HML é seguro para teste):**

```bash
curl -s -X POST $BASE/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"mutual_create_crypto_order","arguments":{"walletId":"wal_LUmChNCfM3pfFDwZp2CZkkKsx4s7","amount":100,"sourceAsset":"MBC","destinationAsset":"BTC","symbol":"BTC-BRL"}}}' | jq
```

Retorna `order.id` (código da ordem), `order.status` e o `externalIdUsed`. Se omitir `externalId`, o servidor gera um único automaticamente.

> Erro `404 "Wallet not found"`? A `walletId` não existe (ex.: `wal_SXvL7TeEwISW6dKPAtCGsFmoJi0q` é inválida). Use uma wallet válida.

---

## 7. Como consumir o MCP (Claude, agentes, n8n)

O endpoint é sempre:

```
URL:    https://mcpcotacaomutual.talkhub.me/mcp
Header: Authorization: Bearer <MCP_AUTH_TOKEN>
Transporte: Streamable HTTP
```

### 7.1 Em Claude (conector personalizado)

Em **Settings → Connectors → Add custom connector**, informe a URL `https://mcpcotacaomutual.talkhub.me/mcp`. Se o cliente permitir headers customizados, adicione `Authorization: Bearer <token>`. (Se o seu cliente MCP não suportar header Bearer, veja 7.4 para alternativa via Traefik.)

### 7.2 Nos seus agentes (evo-ai / clawdbot / microotc)

Esses serviços já consomem MCPs por URL. Configure um novo *MCP server* apontando para a URL acima, com o header `Authorization: Bearer <token>`. As 4 tools aparecerão automaticamente no `tools/list`.

### 7.3 Em n8n / chamadas HTTP diretas

Qualquer fluxo que faça `POST` no `/mcp` com o corpo JSON-RPC (como nos exemplos da seção 6) funciona. O padrão de chamada é sempre `tools/call` com `params.name` + `params.arguments`.

### 7.4 Alternativa: header injetado pelo Traefik

Se algum cliente MCP **não** puder enviar `Authorization`, você pode deixar `MCP_AUTH_TOKEN` vazio e proteger no edge com Basic Auth do Traefik (veja seção 10.4). Para a maioria dos casos, o **Bearer no app** (padrão deste projeto) é o caminho mais simples e seguro.

---

## 8. Gerenciamento via Portainer

Você tem o Portainer (`portainer_portainer`). Duas formas de usar:

### 8.1 Visualizar/gerenciar o stack criado por CLI

Após o `docker stack deploy`, o stack `mcpcotacaomutual` aparece em **Stacks** no Portainer. Lá você vê o serviço, logs, réplicas, e pode reiniciar/escalar pela UI.

### 8.2 Implantar o stack PELO Portainer (alternativa ao CLI)

1. **Build da imagem primeiro** (obrigatório, pois não há registry):

   ```bash
   cd /root/mcpcotacaomutual.talkhub.me
   docker build -t mcpcotacaomutual:latest .
   ```
2. No Portainer: **Stacks → Add stack → Web editor**.
3. Cole o conteúdo do `docker-compose.yml`.
4. Em **Environment variables**, adicione (em vez de usar `.env`):

   | Name | Value |
   | --- | --- |
   | `MUTUAL_API_KEY` | `ak_...` |
   | `MUTUAL_SERVICE_TOKEN` | `8f4c...7a4` |
   | `MUTUAL_CRYPTO_ENV` | `hml` |
   | `MCP_AUTH_TOKEN` | `<openssl rand -hex 32>` |
5. **Deploy the stack**.

> No modo Portainer, as variáveis `${...}` do YAML são preenchidas pelo painel — não precisa do `source .env`.

---

## 9. Operação: logs, update, rollback, scale, remoção

**Logs em tempo real:**

```bash
docker service logs -f mcpcotacaomutual_mcpcotacaomutual
```

**Atualizar o código** (rebuild + redeploy):

```bash
cd /root/mcpcotacaomutual.talkhub.me
# 1) editar src/...
docker build -t mcpcotacaomutual:latest .
docker service update --image mcpcotacaomutual:latest \
  --force mcpcotacaomutual_mcpcotacaomutual
```

ou simplesmente reexecutar o deploy (após `source .env`):

```bash
set -a; source .env; set +a
docker stack deploy -c docker-compose.yml mcpcotacaomutual
```

**Trocar uma variável de ambiente** (ex.: virar `prod` no crypto, depois de a Mutual liberar):

```bash
docker service update \
  --env-add MUTUAL_CRYPTO_ENV=prod \
  --force mcpcotacaomutual_mcpcotacaomutual
```

**Rollback** para a versão anterior do serviço:

```bash
docker service rollback mcpcotacaomutual_mcpcotacaomutual
```

**Escalar** (mais réplicas — stateless, escala bem):

```bash
docker service scale mcpcotacaomutual_mcpcotacaomutual=2
```

**Remover o stack** (não apaga a imagem nem a rede):

```bash
docker stack rm mcpcotacaomutual
```

---

## 10. Segurança

### 10.1 Segredos nunca no cliente
`MUTUAL_API_KEY` (`ak_...`) e `x-service-token` ficam **apenas** no servidor (no `.env` / nas envs do serviço). O chatbot/agente fala só com o `/mcp` — nunca com a Mutual diretamente.

### 10.2 Mascaramento em log
O `logger.ts` mascara segredos (`ak_S****a4`). Os logs vão para **stderr** em JSON. Nunca logue payloads brutos com credenciais.

### 10.3 Bearer no `/mcp`
Com `MCP_AUTH_TOKEN` definido, toda chamada ao `/mcp` exige `Authorization: Bearer <token>`. Sem token → `401`. Gere com `openssl rand -hex 32` e rotacione periodicamente (basta `docker service update --env-add MCP_AUTH_TOKEN=novo --force ...`).

### 10.4 (Opcional) Basic Auth no Traefik como camada extra
Defesa em profundidade no edge. Gere o hash e adicione um middleware nas labels do `docker-compose.yml`:

```bash
# htpasswd: usuario "mcp"
docker run --rm httpd:2.4-alpine htpasswd -nbB mcp 'SUA_SENHA_FORTE'
```

Labels (lembre de duplicar cada `$` para `$$` em arquivo Swarm):

```yaml
- traefik.http.middlewares.mcpcotacaomutual-auth.basicauth.users=mcp:$$2y$$05$$....hash....
- traefik.http.routers.mcpcotacaomutual.middlewares=mcpcotacaomutual-auth
```

### 10.5 Ordem é operação financeira
`mutual_create_crypto_order` é **destrutiva** (`destructiveHint: true`). Garanta que o agente só a chame após confirmação explícita do cliente e com cotação válida. A idempotência por `externalId` evita ordens duplicadas — **nunca reutilize** um `externalId`.

### 10.6 Permissões de arquivo
```bash
chmod 600 .env
```

---

## 11. Troubleshooting

| Sintoma | Causa provável | O que fazer |
| --- | --- | --- |
| `404 page not found` (do Traefik) ao abrir a URL | Router não casou (host/label) ou serviço não subiu | `docker service ps mcpcotacaomutual_mcpcotacaomutual --no-trunc`; confira a label `Host(...)` e `traefik.docker.network=talkhub`. |
| `502 Bad Gateway` | Traefik achou o serviço mas a porta interna está errada/app caiu | Confirme `loadbalancer.server.port=3000` e `PORT=3000`; veja `docker service logs`. |
| HTTPS não emite / aviso de certificado | Nome de `entrypoints`/`certresolver` errado, ou DNS ainda não propagou | Refaça o passo 3.2 e ajuste as labels (5.5); cheque `dig +short mcpcotacaomutual.talkhub.me`. |
| `network talkhub not found` no deploy | Rede ausente | `docker network create --driver overlay --attachable talkhub`. |
| Serviço reinicia em loop / `task: non-zero exit` | Faltou variável obrigatória (`MUTUAL_API_KEY`/`MUTUAL_SERVICE_TOKEN`) | Veja os logs; rode `set -a; source .env; set +a` antes do deploy. |
| `401` ao chamar `/mcp` | Falta o header `Authorization: Bearer <token>` ou token errado | Use o mesmo `MCP_AUTH_TOKEN` do `.env`. |
| Resposta MCP vazia/recusada via curl | Faltou `Accept: application/json, text/event-stream` | Inclua o header `Accept` nos `POST /mcp`. |
| `401/403` da Mutual nas tools | `ak_`/`x-service-token` inválidos | Reveja o `.env`; o service token correto do projeto é `8f4c9e2d71ab3c56d0e8f1a9472b6c3d5a9e0f4b8c1d7e2f6a3b9c5d8e1f7a4`. |
| `404 "Wallet not found"` em ordem | `walletId` inexistente | Use uma wallet válida (ex.: `wal_LUmChNCfM3pfFDwZp2CZkkKsx4s7`). |
| Cotação “expira” antes de comprar | Validade curta (~30s) | O agente deve confirmar dentro de `expires_in_seconds`; senão, gerar nova cotação. |
| `crypto/quote` instável em prod | Instabilidade conhecida em produção | Mantenha `MUTUAL_CRYPTO_ENV=hml` até a Mutual confirmar prod. |

Healthcheck manual dentro do container:

```bash
CID=$(docker ps --filter name=mcpcotacaomutual_mcpcotacaomutual -q | head -1)
docker exec -it "$CID" node -e "fetch('http://127.0.0.1:3000/health').then(r=>r.text()).then(console.log)"
```

---

## 12. Mapa Mutual ↔ tools

| Mutual API v2 | Ambiente validado | Cliente axios | Tool MCP |
| --- | --- | --- | --- |
| `GET /api/v2/resource/merchants` | produção | `prod` | `mutual_list_merchants` |
| `GET /api/v2/resource/fees/merchant/{id}` | produção | `prod` | `mutual_get_merchant_fees` |
| `GET /api/v2/crypto/quote` | homologação | `crypto` (=hml) | `mutual_get_crypto_quote` |
| `POST /api/v2/crypto/orders` | homologação | `crypto` (=hml) | `mutual_create_crypto_order` |

Headers enviados em toda chamada à Mutual:

```
Authorization: Bearer ak_...
Content-Type: application/json
x-service-token: 8f4c9e2d71ab3c56d0e8f1a9472b6c3d5a9e0f4b8c1d7e2f6a3b9c5d8e1f7a4
```

---

## 13. Pontos em aberto do projeto

Itens ainda a confirmar com a Mutual (e como este servidor se comporta hoje):

1. **Status de uma ordem por ID** — endpoint ainda não documentado. Quando existir, adicione uma tool `mutual_get_order_status` em `src/tools.ts` (mesmo padrão das demais).
2. **Executar ordem por `quote_id`** — hoje a ordem é criada com o payload validado; `quote_id` não é enviado. Se a Mutual passar a aceitar, inclua no payload de `orders.ts`.
3. **Obrigatoriedade de `qty` em ordem market** — exposto como parâmetro (padrão `"0.001"`), ajustável por chamada.
4. **`cost` vs `amount`** — se omitido, `cost = amount`. Ajuste se a Mutual exigir diferença.
5. **`source.asset = MBC`** — padrão atual do fluxo de compra; alterável por parâmetro.
6. **Atualização de `destination.amount`** quando a ordem sai de `created` — depende de processamento assíncrono/webhook da Mutual.
7. **Webhook de atualização de ordem** — quando existir, exponha um endpoint próprio para recebê-lo (fora do `/mcp`).
8. **Redes aceitas por ativo** / **9. Pares aceitos além de `BTC-BRL`** — validar e refletir nas descrições das tools.
10. **`crypto/quote` em produção** — manter `hml` até a Mutual confirmar estabilidade em prod; depois, basta `MUTUAL_CRYPTO_ENV=prod`.

---

## 14. Cheat sheet (comandos rápidos)

```bash
# --- Implantar ---
cd /root && mkdir -p mcpcotacaomutual.talkhub.me && cd mcpcotacaomutual.talkhub.me
cp .env.example .env && nano .env          # preencha credenciais + MCP_AUTH_TOKEN
chmod 600 .env
docker build -t mcpcotacaomutual:latest .
set -a; source .env; set +a
docker stack deploy -c docker-compose.yml mcpcotacaomutual

# --- Observar ---
docker stack services mcpcotacaomutual
docker service ps  mcpcotacaomutual_mcpcotacaomutual --no-trunc
docker service logs -f mcpcotacaomutual_mcpcotacaomutual

# --- Atualizar / rollback / escalar ---
docker build -t mcpcotacaomutual:latest .
docker service update --image mcpcotacaomutual:latest --force mcpcotacaomutual_mcpcotacaomutual
docker service rollback mcpcotacaomutual_mcpcotacaomutual
docker service scale   mcpcotacaomutual_mcpcotacaomutual=2

# --- Testar (público) ---
curl -s https://mcpcotacaomutual.talkhub.me/health ; echo
curl -s -X POST https://mcpcotacaomutual.talkhub.me/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | jq '.result.tools[].name'

# --- Remover ---
docker stack rm mcpcotacaomutual
```

---

**Resumo:** build local da imagem `mcpcotacaomutual:latest`, segredos no `.env` (`chmod 600`), deploy via `docker stack deploy` na rede `talkhub`, exposição pelo Traefik em `https://mcpcotacaomutual.talkhub.me` com TLS, e proteção do `/mcp` por Bearer. As 4 tools cobrem o fluxo completo: merchants → fees → cotação → ordem.
