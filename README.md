# cotacaomutual — Cotações por Grupo com Fees da Mutual

Serviço que monitora mensagens de grupos (WhatsApp via **Evolution API v2**), identifica o **merchant pelo grupo**, interpreta comandos iniciados por `/`, consulta a **cotação-base** e as **fees do merchant** na Mutual API v2, aplica fee fixa + percentual e responde no grupo — com **painel visual de controle** em `https://cotacaomutual.talkhub.me/painel`.

> 📚 **Documentação visual completa da operação** (diagramas, cURLs, variáveis da cotação, fórmulas, requisitos técnicos e runbook): `https://cotacaomutual.talkhub.me/docs` — fonte em [`public/docs.html`](./public/docs.html).

> O servidor MCP original (camada fina sobre a Mutual API) continua intacto em [`mcpcotacaomutual.talkhub.me/`](./mcpcotacaomutual.talkhub.me/) — é um serviço separado, com deploy próprio.

---

## Regras centrais desta fase

1. **Fila de cotações**: toda cotação envia **10 mensagens** em sequência (configurável), cada uma com **requisição própria** à Mutual — os preços variam de segundo a segundo, então nada de cache/reuso de ticker entre mensagens.
2. **Dois lados por cotação**: cada mensagem traz compra e venda do par, cada lado com a sua fee; lado sem fee cadastrada sai como *sob consulta*.
2. **Interrupção por confirmação**: `/COMPRA` ou `/VENDA` encerra a fila imediatamente e consome a cotação (uma confirmação por cotação).
3. **Compra sempre desligada por padrão**: o toggle "Compra (execução)" nasce **desligado** em todo canal/grupo e só é ativado **manualmente no painel**.
4. **Sem citar estado do bot**: quando um recurso não está ativo, a resposta do grupo informa apenas que *a operação será concluída manualmente por um operador da Mutual* — nunca "bot desligado" ou similar.
5. **Ordens nunca são criadas nesta fase**: `ORDERS_ENABLED=false` — o sistema **não chama** `POST /api/v2/crypto/orders` em hipótese alguma.
6. **Fee exata obrigatória**: a fee é localizada por `operation + sourceAsset + destinationAsset`. Sem fee exata, a cotação é interrompida com aviso — **sem fallback silencioso**.
7. **Só a cotação final vai ao grupo**: feePercentage, feeFixed, preço-base, merchantId e ticker cru ficam apenas no painel e no registro (`data/quote-log.jsonl`).

---

## Fluxo

```txt
Mensagem no grupo
      ↓
channel + groupId  →  merchant (linkGroups, status=active, linkGroup.active)
      ↓
Comando (/COTAR, /REF, /COMPRA, /VENDA, /AJUDA)
      ↓
Toggles do painel (cotações? compra?)
      ↓
lados do par: compra (buy/conversion) e venda (sell/conversion) → fees exatas
      ↓
FILA: 10 × [ticker novo → fees dos dois lados → card compra/venda no grupo]
      ↓                                  ↑ interrompida por /COMPRA ou /VENDA
Registro completo no painel/log
```

### Comandos aceitos

| Comando | O que faz |
| --- | --- |
| `/COTAR 50K USDT` | cotação do par USDT/BRL para 50.000 USDT (compra **e** venda) |
| `/REF 25K USDT` | idem (atalho) |
| `/COTAR 5000 BRL USDT` | mesmo par, tamanho de referência R$ 5.000 |
| `/COTAR 1 BTC BRL` | cotação do par BTC/BRL |
| `/COTAR 1 BTC USDT` | conversão cripto → cripto (direção única) |
| `/COMPRA 50K USDT` | confirma a **compra** na cotação ativa (consome a cotação) |
| `/VENDA 50K USDT` | confirma a **venda** na cotação ativa (consome a cotação) |

Aliases de comando: `/COMPRAR`, `/ORDER`, `/ORDEM`, `/FECHAR` → compra · `/VENDER`, `/SELL` → venda.

Aliases: `USD`, `DÓLAR`, `DOLARES` → **USDC** · `REAL/REAIS` → BRL · `TETHER` → USDT · `BITCOIN` → BTC · `ETHEREUM` → ETH. Valores aceitam `25K`, `1,5M`, `5.000,50`.

### Direção financeira da fee

As fees da Mutual vêm em **pontos percentuais** — `feeFixed` e `feePercentage` são ambas porcentagens que se **somam** (ex: fixa 0.1 + percentual 0.65 = 0,75%):

```txt
taxa = (feeFixed + feePercentage) / 100

Quantidade do ativo (BRL→cripto):  finalTotal    = base × (1 + taxa)   (paga mais)
Orçamento BRL:                     baseAvailable = BRL / (1 + taxa)    (recebe menos)
Venda/conversão da origem:         net           = gross × (1 − taxa)  (recebe menos)
```

---

## Painel de controle (`/painel`)

* **Canais**: liga/desliga *Cotações* e *Compra (execução)* por canal.
* **Grupos**: mesmos toggles por grupo (override do canal), com merchant vinculado e status do vínculo. Grupos aparecem pelo `linkGroups` dos merchants e também na primeira mensagem recebida via webhook.
* **Fila de cotações**: progresso ao vivo (msg X/10) + filas recentes.
* **Merchants & Fees**: auditoria da matriz mínima de fees por merchant (pares ausentes em destaque).
* **Registro de operações**: todos os detalhes internos de cada cotação (fees, preço-base, preço final, ticker cru, mensagem enviada).

Proteja com `PANEL_TOKEN` (o painel pede o token e envia como Bearer).

---

## HTTP

| Rota                  | Método | Auth            | Uso                                        |
| --------------------- | ------ | --------------- | ------------------------------------------ |
| `/webhook[/:channel]` | POST   | `WEBHOOK_TOKEN` | Mensagens dos grupos                       |
| `/painel`             | GET    | aberto (HTML)   | Painel visual                              |
| `/api/panel/overview` | GET    | `PANEL_TOKEN`   | Canais, grupos, toggles, filas             |
| `/api/panel/toggle`   | POST   | `PANEL_TOKEN`   | Liga/desliga bots por canal/grupo          |
| `/api/panel/merchants`| GET    | `PANEL_TOKEN`   | Merchants + auditoria de fees              |
| `/api/panel/logs`     | GET    | `PANEL_TOKEN`   | Registro detalhado                         |
| `/health`             | GET    | aberto          | Healthcheck                                |

### Webhook de entrada

Aceita o payload nativo da **Evolution API v2** (evento `MESSAGES_UPSERT`) e um contrato genérico:

```bash
curl -X POST 'https://cotacaomutual.talkhub.me/webhook?token=SEU_WEBHOOK_TOKEN' \
  -H 'Content-Type: application/json' \
  -d '{"channel":"whatsapp","groupId":"120363...@g.us","text":"/COTAR 25K USDT"}'
```

Regras para payloads Evolution: só `messages.upsert` é processado; mensagens do próprio bot (`fromMe=true`) são ignoradas (anti-loop); só grupos (`...@g.us`) são atendidos. Texto é lido de `message.conversation` ou `message.extendedTextMessage.text`.

### Envio ao grupo (saída)

As mensagens da fila são entregues via `OUTBOUND_MODE`:

* `evolution` (produção): `POST {EVOLUTION_BASE_URL}/message/sendText/{EVOLUTION_INSTANCE}` com header `apikey` e body `{number, text}`.
* `webhook`: `POST OUTBOUND_WEBHOOK_URL` com `{channel, groupId, text}` (+ `Authorization: Bearer OUTBOUND_TOKEN` se definido).
* `log`: apenas registra (desenvolvimento).

---

## Respostas no grupo

Toda cotação sai no formato de mesa, com os **dois lados do par** e a fee do merchant já aplicada em cada um:

```txt
💱 Cotação · USDT D0 • 🇧🇷 USDT/BRL · 3/10

🟢 Compra: 1 USDT = R$ 5,0051
50k USDT = R$ 250.255,00
🔴 Venda: 1 USDT = R$ 4,9891
50k USDT = R$ 249.455,00
🧾 Digite
→ /compra 50k USDT
→ /venda 50k USDT

⚡ Valores sujeitos à confirmação no fechamento.
```

**Blindagem da resposta** (nunca um número errado):

| Situação | Resposta |
| --- | --- |
| Lado sem fee cadastrada no merchant | `🔴 Venda: sob consulta` + aviso de condução manual; o comando daquele lado **não** é oferecido |
| Preço inválido após a fee (ex.: taxa >= 100%) | mesmo tratamento: lado sai como *sob consulta* |
| Ticker com bid > ask (dado estranho) | lados normalizados — a venda **nunca** sai acima da compra |
| Nenhum dos dois lados configurado | `⚠️ Não há taxa configurada para esta operação neste cliente.` (sem cotação) |
| `/compra` ou `/venda` de um lado *sob consulta* | avisa que aquele lado será conduzido manualmente — nunca confirma |
| `/compra`/`/venda` sem cotação válida (ou já consumida) | pede uma cotação atualizada |
| Argumentos que não batem com a cotação ativa | mostra a cotação ativa e orienta a cotar o que foi pedido |

Confirmação (`/compra` · `/venda`) consome a cotação — **uma cotação vale para uma única confirmação** — e emite o registro completo da operação (ID da transação, data, tipo, cotação, montantes Total/Pendente) seguido de: *"A operação será concluída manualmente por um operador da Mutual."*

> O bloco em **dólar** está pronto no código e desligado nesta fase (`QUOTE_SHOW_USD=false`).

---

## Configuração

Veja [`.env.example`](./.env.example). Principais:

| Variável | Padrão | Descrição |
| --- | --- | --- |
| `MUTUAL_API_KEY` / `MUTUAL_SERVICE_TOKEN` | — | Credenciais Mutual (obrigatórias) |
| `MUTUAL_CRYPTO_ENV` | `prod` | Ambiente do `/crypto/quote` (cotação é somente leitura) |
| `ORDERS_ENABLED` | `false` | **Manter false nesta fase** |
| `QUOTE_QUEUE_MESSAGES` | `10` | Mensagens por fila de cotação |
| `QUOTE_QUEUE_INTERVAL_MS` | `3000` | Intervalo entre mensagens |
| `MERCHANT_CACHE_TTL_MS` / `FEE_CACHE_TTL_MS` | `60000` | Cache de merchants/fees (cotação nunca usa cache) |
| `DATA_DIR` | `./data` | Toggles do painel + registro (volume no Swarm) |
| `WEBHOOK_TOKEN` / `PANEL_TOKEN` | — | Proteção dos endpoints |
| `OUTBOUND_MODE` / `OUTBOUND_WEBHOOK_URL` / `OUTBOUND_TOKEN` | `log` | Entrega das mensagens ao grupo |

---

## Desenvolvimento

```bash
npm install
npm run build     # compila TypeScript
npm test          # regras de negócio (parser, operações, fees, toggles)
npm run dev       # tsx watch
```

## Deploy em produção (Docker Swarm + Traefik + Portainer, rede `talkhub`)

**Primeiro deploy** — o `setup.sh` faz tudo (verificações, volume externo, `.env` com tokens gerados, build, deploy e registro do webhook na Evolution):

```bash
cd /root/cotacaomutual.talkhub.me
bash setup.sh
# pergunta apenas a MUTUAL_API_KEY (ak_...); o resto vem pré-configurado
```

**Atualização rápida** (mantém o stack no ar, troca só a imagem):

```bash
cd /root/cotacaomutual.talkhub.me
git pull   # ou copie os arquivos novos
docker build -t cotacaomutual:latest .
docker service update --image cotacaomutual:latest --force cotacaomutual_cotacaomutual
```

**Redeploy limpo** (remove o stack, limpa containers/imagens do serviço, prune de dangling, rebuild sem cache e redeploy — preserva `.env`, volume de dados e as demais stacks da VPS):

```bash
cd /root/cotacaomutual.talkhub.me
bash redeploy.sh              # com git pull automático
bash redeploy.sh --no-pull    # sem git pull
bash redeploy.sh --wipe-data  # também zera o volume (toggles/histórico) — pede confirmação
```

**Observar**:

```bash
docker service logs -f cotacaomutual_cotacaomutual
```

O stack `cotacaomutual` publica `https://cotacaomutual.talkhub.me` (entrypoint `websecure`, resolver `letsencryptresolver` — mesmo padrão das demais stacks da VPS), persiste `DATA_DIR` no volume externo `cotacaomutual_data`, não publica portas no host (sem conflito com os serviços existentes) e aparece no Portainer em **Stacks**.

### Evolution API (WhatsApp)

* Instância: `talkbia` em `https://whatsapp.talkhub.me` (v2.3.7).
* Entrada: webhook `MESSAGES_UPSERT` → `https://cotacaomutual.talkhub.me/webhook?token=<WEBHOOK_TOKEN>` (registrado pelo `setup.sh`; se falhar, registre no Evolution Manager com essa URL).
* Saída: `sendText` na mesma instância com a `apikey` do `.env`.

### Formatos aceitos no cadastro do grupo (linkGroups da Mutual)

O `groupId` do vínculo pode ser cadastrado em qualquer um destes formatos:

| Formato | Exemplo | Como é resolvido |
| --- | --- | --- |
| Link de convite | `https://chat.whatsapp.com/C34dh5vXFPJ8wgOGlE9LYG` | `GET /group/inviteInfo` na Evolution → JID (cache 6h) |
| Código de convite | `C34dh5vXFPJ8wgOGlE9LYG` | idem |
| JID interno | `120363429012757266@g.us` | match direto |
| Outros canais (telegram etc.) | `23141` | match direto por channel+groupId |

No painel, grupos cadastrados por convite aparecem já fundidos com o grupo real (JID), com o link original exibido como "cadastro".

---

## Estrutura

```
src/
├── index.ts              # bootstrap Express (webhook + painel + health)
├── config.ts             # variáveis de ambiente
├── mutual/               # clientes HTTP Mutual (merchants, fees, quote)
├── core/
│   ├── assets.ts         # normalização (USD/dólar → USDC etc.)
│   ├── operations.ts     # buy | conversion | sell (tabela definitiva)
│   ├── fees.ts           # seleção exata + cálculo + auditoria da matriz
│   ├── pricing.ts        # aplicação da fee nas 3 direções
│   ├── parser.ts         # comandos /COTAR /REF /VENDER /COMPRAR
│   ├── merchants.ts      # findMerchantByGroup (linkGroups)
│   ├── format.ts         # mensagens do grupo (só cotação final) + textos
│   ├── engine.ts         # contexto da cotação + tick (requisição nova)
│   └── processor.ts      # webhook → toggles → fila/compra
├── queue/quote-queue.ts  # fila de 10 msgs, interrompível pelo /COMPRAR
├── cache/caches.ts       # merchants/fees 60s (cotação NUNCA cacheada)
├── state/settings.ts     # toggles do painel (compra padrão OFF)
├── state/quote-log.ts    # registro JSONL + memória p/ painel
├── channels/outbound.ts  # entrega das mensagens ao grupo
└── http/                 # rotas webhook + API do painel
public/index.html         # painel visual
tests/core.test.ts        # 13 testes das regras do descritivo
```
