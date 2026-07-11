# =============================================================================
# cotamutual — Bot de cotacoes por grupo (Mutual API v2) + painel de controle
# Build multi-stage: compila TypeScript e gera imagem enxuta de runtime.
# =============================================================================

# ---- Estagio 1: build ----
FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- Estagio 2: runtime ----
FROM node:22-alpine AS runtime
ENV NODE_ENV=production
ENV PORT=3000
ENV DATA_DIR=/app/data
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY public ./public

# Diretorio persistente (toggles do painel + registro de cotacoes)
RUN mkdir -p /app/data && chown -R node:node /app/data

USER node

EXPOSE 3000
CMD ["node", "dist/index.js"]
