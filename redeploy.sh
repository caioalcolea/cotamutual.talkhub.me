#!/usr/bin/env bash
# =============================================================================
# redeploy.sh — Redeploy LIMPO do cotacaomutual (Docker Swarm + Traefik)
#
# Sequencia:
#   1. Verificacoes (Swarm, rede talkhub, .env)
#   2. git pull (a menos que --no-pull)
#   3. docker stack rm cotacaomutual + espera a remocao drenar completamente
#   4. Limpeza: containers parados DESTA stack, imagem cotacaomutual e dangling
#   5. Rebuild limpo (--no-cache --pull)
#   6. Redeploy do stack + espera 1/1 + valida /health
#
# O que e PRESERVADO por padrao:
#   - .env (tokens, credenciais)
#   - volume cotacaomutual_data (toggles do painel + registro de cotacoes)
#   - as demais stacks/imagens da VPS (limpeza toda escopada neste servico)
#
# Flags:
#   --no-pull     nao roda git pull antes do build
#   --wipe-data   APAGA e recria o volume cotacaomutual_data (pede confirmacao)
#   --yes         nao pede confirmacao (para uso com --wipe-data em automacao)
#
# Uso:  cd /root/cotacaomutual.talkhub.me && bash redeploy.sh
# =============================================================================
set -euo pipefail

STACK="cotacaomutual"
SERVICE="${STACK}_${STACK}"
DOMAIN="cotacaomutual.talkhub.me"
IMAGE="cotacaomutual:latest"
VOLUME="cotacaomutual_data"

DO_PULL=1
WIPE_DATA=0
ASSUME_YES=0
for arg in "$@"; do
  case "$arg" in
    --no-pull)   DO_PULL=0 ;;
    --wipe-data) WIPE_DATA=1 ;;
    --yes)       ASSUME_YES=1 ;;
    *) echo "Flag desconhecida: $arg (use --no-pull, --wipe-data, --yes)"; exit 1 ;;
  esac
done

ok()   { echo -e "  \033[32m✔\033[0m $*"; }
warn() { echo -e "  \033[33m⚠\033[0m $*"; }
die()  { echo -e "  \033[31m✘\033[0m $*"; exit 1; }

echo "== 1/6 Verificações =============================================="
command -v docker >/dev/null || die "docker não encontrado."
[ "$(docker info --format '{{.Swarm.LocalNodeState}}' 2>/dev/null)" = "active" ] \
  || die "Docker Swarm não está ativo neste nó."
docker network ls --format '{{.Name}}' | grep -qx "talkhub" || die "Rede 'talkhub' não existe."
[ -f .env ] || die "Arquivo .env não encontrado nesta pasta. Rode primeiro: bash setup.sh"
[ -f docker-compose.yml ] || die "docker-compose.yml não encontrado. Rode dentro de /root/$DOMAIN"
ok "Swarm ativo, rede talkhub presente, .env encontrado"

echo
echo "== 2/6 Código atualizado ========================================="
if [ "$DO_PULL" = "1" ] && [ -d .git ]; then
  git pull --ff-only || warn "git pull falhou — seguindo com o código local"
  ok "git pull concluído"
else
  ok "git pull pulado"
fi

echo
echo "== 3/6 Removendo o stack ========================================="
if docker stack ls --format '{{.Name}}' | grep -qx "$STACK"; then
  docker stack rm "$STACK"
  ok "docker stack rm $STACK enviado — aguardando drenar..."
else
  warn "Stack $STACK não estava implantado (primeira vez? use setup.sh)"
fi

# A remocao de stack e assincrona: espera servicos E containers sumirem.
for i in $(seq 1 60); do
  SVC=$(docker service ls --filter "label=com.docker.stack.namespace=$STACK" -q | wc -l)
  CTR=$(docker ps -a --filter "label=com.docker.stack.namespace=$STACK" -q | wc -l)
  [ "$SVC" = "0" ] && [ "$CTR" = "0" ] && break
  sleep 2
done
if [ "${SVC:-0}" = "0" ] && [ "${CTR:-0}" = "0" ]; then
  ok "Stack totalmente removido"
else
  warn "Ainda há resíduos (services=$SVC, containers=$CTR) — seguindo mesmo assim"
fi
# Folga extra para o Swarm liberar nomes/rede do stack.
sleep 5

echo
echo "== 4/6 Limpeza (escopada neste serviço) =========================="
# Containers parados desta stack (histórico de tasks antigas)
docker container prune -f --filter "label=com.docker.stack.namespace=$STACK" >/dev/null || true
ok "Containers antigos da stack removidos"

# Imagem do serviço (todas as tags locais cotacaomutual:*)
OLD_IMGS=$(docker images --format '{{.Repository}}:{{.Tag}}' | grep '^cotacaomutual:' || true)
if [ -n "$OLD_IMGS" ]; then
  echo "$OLD_IMGS" | xargs -r docker image rm -f >/dev/null || true
  ok "Imagem(ns) removida(s): $(echo "$OLD_IMGS" | tr '\n' ' ')"
else
  ok "Nenhuma imagem cotacaomutual local para remover"
fi

# Camadas orfas (dangling) — seguro: não afeta imagens em uso de outras stacks
docker image prune -f >/dev/null || true
ok "Imagens dangling removidas"

if [ "$WIPE_DATA" = "1" ]; then
  if [ "$ASSUME_YES" != "1" ]; then
    read -rp "  ⚠ APAGAR o volume $VOLUME (toggles do painel + histórico)? [digite SIM]: " CONFIRM
    [ "$CONFIRM" = "SIM" ] || die "Cancelado — volume preservado."
  fi
  docker volume rm "$VOLUME" >/dev/null 2>&1 || true
  docker volume create "$VOLUME" >/dev/null
  warn "Volume $VOLUME apagado e recriado (compra volta ao padrão: desligada)"
else
  docker volume inspect "$VOLUME" >/dev/null 2>&1 || docker volume create "$VOLUME" >/dev/null
  ok "Volume $VOLUME preservado (toggles e histórico mantidos)"
fi

echo
echo "== 5/6 Rebuild limpo ============================================="
docker build --no-cache --pull -t "$IMAGE" .
ok "Imagem $IMAGE rebuildada do zero (sem cache, base atualizada)"

echo
echo "== 6/6 Redeploy =================================================="
set -a; source .env; set +a
docker stack deploy -c docker-compose.yml "$STACK"
ok "Stack $STACK implantado"

REPLICAS=""
for i in $(seq 1 45); do
  REPLICAS=$(docker service ls --filter "name=$SERVICE" --format '{{.Replicas}}' | head -1)
  [ "${REPLICAS%% *}" = "1/1" ] && break
  sleep 2
done
if [ "${REPLICAS%% *}" = "1/1" ]; then
  ok "Serviço 1/1 rodando"
else
  warn "Serviço não chegou a 1/1 (${REPLICAS:-?}). Diagnóstico: docker service ps $SERVICE --no-trunc"
fi

HEALTH_OK=""
for i in $(seq 1 12); do
  if curl -fsS "https://$DOMAIN/health" >/dev/null 2>&1; then HEALTH_OK=1; break; fi
  sleep 5
done
if [ -n "$HEALTH_OK" ]; then
  ok "https://$DOMAIN/health respondendo"
else
  warn "health ainda não responde — veja: docker service logs -f $SERVICE"
fi

echo
echo "=================================================================="
echo "  ✅ Redeploy limpo concluído!"
echo "  Painel:  https://$DOMAIN/painel"
echo "  Logs:    docker service logs -f $SERVICE"
echo "=================================================================="
