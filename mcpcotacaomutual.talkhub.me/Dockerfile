# =============================================================================
# mcpcotacaomutual — Servidor MCP (Mutual API v2)
# Build multi-stage: compila TypeScript e gera imagem enxuta de runtime.
# =============================================================================

# ---- Estagio 1: build ----
FROM node:22-alpine AS build
WORKDIR /app

# Instala TODAS as dependencias (inclui devDependencies para compilar)
COPY package.json package-lock.json ./
RUN npm ci

# Copia o codigo e compila
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- Estagio 2: runtime ----
FROM node:22-alpine AS runtime
ENV NODE_ENV=production
ENV TRANSPORT=http
ENV PORT=3000
WORKDIR /app

# Instala apenas dependencias de producao
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copia o build do estagio anterior
COPY --from=build /app/dist ./dist

# Roda como usuario nao-root (ja existente nas imagens node)
USER node

EXPOSE 3000
CMD ["node", "dist/index.js"]
