#!/usr/bin/env bash
# =============================================================================
# setup.sh — Primeiro deploy do cotacaomutual na VPS (Docker Swarm + Traefik)
#
# O que faz:
#   1. Verifica Swarm ativo, rede talkhub e DNS do dominio
#   2. Cria o volume externo cotacaomutual_data
#   3. Gera o .env (tokens aleatorios + Evolution pre-configurada;
#      pergunta apenas as credenciais da Mutual)
#   4. Build local da imagem cotacaomutual:latest
#   5. Deploy do stack "cotacaomutual" (aparece no Portainer em Stacks)
#   6. Aguarda o servico subir e valida o /health
#   7. Registra o webhook MESSAGES_UPSERT na Evolution API (instancia talkbia)
#
# Uso:  cd /root/cotacaomutual.talkhub.me && bash setup.sh
# Re-executar e seguro: nao sobrescreve .env nem volume existentes.
# =============================================================================
set -euo pipefail

STACK="cotacaomutual"
DOMAIN="cotacaomutual.talkhub.me"
IMAGE="cotacaomutual:latest"
VOLUME="cotacaomutual_data"

DEFAULT_EVOLUTION_BASE_URL="https://whatsapp.talkhub.me"
DEFAULT_EVOLUTION_INSTANCE="talkbia"
DEFAULT_EVOLUTION_API_KEY="5f7b34ec-3302-4c46-9c90-76c374ca9862"
DEFAULT_MUTUAL_SERVICE_TOKEN="8f4c9e2d71ab3c56d0e8f1a9472b6c3d5a9e0f4b8c1d7e2f6a3b9c5d8e1f7a4"

ok()   { echo -e "  \033[32m✔\033[0m $*"; }
warn() { echo -e "  \033[33m⚠\033[0m $*"; }
die()  { echo -e "  \033[31m✘\033[0m $*"; exit 1; }

echo "== 1/7 Verificações =============================================="

command -v docker >/dev/null || die "docker não encontrado."
[ "$(docker info --format '{{.Swarm.LocalNodeState}}' 2>/dev/null)" = "active" ] \
  || die "Docker Swarm não está ativo neste nó."
ok "Swarm ativo"

docker network ls --format '{{.Name}}' | grep -qx "talkhub" \
  || die "Rede overlay 'talkhub' não existe. Crie com: docker network create --driver overlay --attachable talkhub"
ok "Rede talkhub presente"

if command -v dig >/dev/null; then
  IP=$(dig +short "$DOMAIN" | tail -1 || true)
  if [ -n "${IP:-}" ]; then ok "DNS $DOMAIN -> $IP"; else warn "DNS de $DOMAIN não resolveu ainda (Let's Encrypt só emite após propagar)"; fi
else
  warn "dig não instalado; pulei a checagem de DNS"
fi

# Conflitos: stack/servico com mesmo nome
if docker stack ls --format '{{.Name}}' | grep -qx "$STACK"; then
  warn "Stack '$STACK' já existe — o deploy abaixo fará UPDATE (sem conflito)."
fi

echo
echo "== 2/7 Volume externo ============================================"
if docker volume inspect "$VOLUME" >/dev/null 2>&1; then
  ok "Volume $VOLUME já existe (mantido)"
else
  docker volume create "$VOLUME" >/dev/null
  ok "Volume $VOLUME criado"
fi

echo
echo "== 3/7 Arquivo .env =============================================="
if [ -f .env ]; then
  ok ".env já existe — mantendo o atual"
else
  WEBHOOK_TOKEN=$(openssl rand -hex 32)
  PANEL_TOKEN=$(openssl rand -hex 32)

  # Credenciais Mutual (única entrada manual)
  if [ -t 0 ]; then
    read -rp "  MUTUAL_API_KEY (ak_...): " MUTUAL_API_KEY_IN
    read -rp "  MUTUAL_SERVICE_TOKEN [Enter = padrão do projeto]: " MUTUAL_SERVICE_TOKEN_IN
  else
    MUTUAL_API_KEY_IN=""
    MUTUAL_SERVICE_TOKEN_IN=""
  fi
  MUTUAL_API_KEY_IN=${MUTUAL_API_KEY_IN:-ak_PREENCHA_AQUI}
  MUTUAL_SERVICE_TOKEN_IN=${MUTUAL_SERVICE_TOKEN_IN:-$DEFAULT_MUTUAL_SERVICE_TOKEN}

  cat > .env <<EOF
# cotacaomutual — gerado por setup.sh em $(date -Iseconds)

# --- Mutual API v2 ---
MUTUAL_CRYPTO_ENV=prod
MUTUAL_API_KEY=$MUTUAL_API_KEY_IN
MUTUAL_SERVICE_TOKEN=$MUTUAL_SERVICE_TOKEN_IN

# --- Fase atual: somente cotações (NUNCA cria ordens) ---
ORDERS_ENABLED=false

# --- Fila de cotações ---
QUOTE_QUEUE_MESSAGES=10
QUOTE_QUEUE_INTERVAL_MS=3000
QUOTE_REFERENCE_BRL_AMOUNT=1000

# --- Proteção dos endpoints (gerados automaticamente) ---
WEBHOOK_TOKEN=$WEBHOOK_TOKEN
PANEL_TOKEN=$PANEL_TOKEN

# --- Evolution API v2 (envio ao grupo) ---
OUTBOUND_MODE=evolution
EVOLUTION_BASE_URL=$DEFAULT_EVOLUTION_BASE_URL
EVOLUTION_INSTANCE=$DEFAULT_EVOLUTION_INSTANCE
EVOLUTION_API_KEY=$DEFAULT_EVOLUTION_API_KEY
EOF
  chmod 600 .env
  ok ".env criado (chmod 600) — tokens do webhook e do painel gerados"
  [ "$MUTUAL_API_KEY_IN" = "ak_PREENCHA_AQUI" ] \
    && warn "MUTUAL_API_KEY ficou como placeholder — edite o .env antes de usar cotações reais!"
fi

set -a; source .env; set +a

echo
echo "== 4/7 Build da imagem ==========================================="
docker build -t "$IMAGE" .
ok "Imagem $IMAGE buildada"

echo
echo "== 5/7 Deploy do stack ==========================================="
docker stack deploy -c docker-compose.yml "$STACK"
ok "Stack $STACK implantado (visível no Portainer → Stacks)"

echo
echo "== 6/7 Aguardando serviço subir =================================="
for i in $(seq 1 30); do
  REPLICAS=$(docker service ls --filter "name=${STACK}_${STACK}" --format '{{.Replicas}}' | head -1)
  [ "${REPLICAS%% *}" = "1/1" ] && break
  sleep 2
done
if [ "${REPLICAS%% *}" = "1/1" ]; then
  ok "Serviço 1/1 rodando"
else
  warn "Serviço ainda não está 1/1 (${REPLICAS:-?}). Veja: docker service ps ${STACK}_${STACK} --no-trunc"
fi

# Health via HTTPS (o certificado pode levar ~1min na primeira emissão)
HEALTH_OK=""
for i in $(seq 1 18); do
  if curl -fsS "https://$DOMAIN/health" >/dev/null 2>&1; then HEALTH_OK=1; break; fi
  sleep 5
done
if [ -n "$HEALTH_OK" ]; then
  ok "https://$DOMAIN/health respondendo"
else
  warn "https://$DOMAIN/health ainda não responde (emissão do certificado pode demorar). Teste depois: curl https://$DOMAIN/health"
fi

echo
echo "== 7/7 Webhook na Evolution API =================================="
WEBHOOK_URL="https://$DOMAIN/webhook?token=$WEBHOOK_TOKEN"
BODY_V2=$(cat <<EOF
{"webhook":{"enabled":true,"url":"$WEBHOOK_URL","webhookByEvents":false,"webhookBase64":false,"events":["MESSAGES_UPSERT"]}}
EOF
)
BODY_FLAT=$(cat <<EOF
{"enabled":true,"url":"$WEBHOOK_URL","webhook_by_events":false,"webhook_base64":false,"events":["MESSAGES_UPSERT"]}
EOF
)

set_webhook() {
  curl -s -o /tmp/evo_webhook_resp.json -w '%{http_code}' \
    -X POST "$EVOLUTION_BASE_URL/webhook/set/$EVOLUTION_INSTANCE" \
    -H "apikey: $EVOLUTION_API_KEY" \
    -H 'Content-Type: application/json' \
    -d "$1"
}

HTTP=$(set_webhook "$BODY_V2" || echo "000")
if [ "$HTTP" != "200" ] && [ "$HTTP" != "201" ]; then
  HTTP=$(set_webhook "$BODY_FLAT" || echo "000")
fi
if [ "$HTTP" = "200" ] || [ "$HTTP" = "201" ]; then
  ok "Webhook registrado na Evolution (instância $EVOLUTION_INSTANCE, evento MESSAGES_UPSERT)"
else
  warn "Não consegui registrar o webhook automaticamente (HTTP $HTTP)."
  warn "Resposta: $(cat /tmp/evo_webhook_resp.json 2>/dev/null | head -c 300)"
  echo    "  Registre manualmente (Evolution Manager → instância $EVOLUTION_INSTANCE → Webhook):"
  echo    "    URL:     $WEBHOOK_URL"
  echo    "    Eventos: MESSAGES_UPSERT"
fi

echo
echo "=================================================================="
echo "  ✅ Deploy concluído!"
echo
echo "  Painel:   https://$DOMAIN/painel"
echo "            token do painel: $PANEL_TOKEN"
echo "  Webhook:  $WEBHOOK_URL"
echo "  Health:   https://$DOMAIN/health"
echo
echo "  Estado inicial dos bots: COTAÇÕES ligadas · COMPRA desligada (padrão)"
echo "  ORDERS_ENABLED=false — nenhuma ordem é criada nesta fase."
echo
echo "  Comandos úteis:"
echo "    docker service logs -f ${STACK}_${STACK}"
echo "    docker service ps ${STACK}_${STACK} --no-trunc"
echo "    # atualizar: docker build -t $IMAGE . && docker service update --image $IMAGE --force ${STACK}_${STACK}"
echo "=================================================================="
