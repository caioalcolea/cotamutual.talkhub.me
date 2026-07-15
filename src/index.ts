#!/usr/bin/env node
/**
 * cotamutual — Bot de cotacoes por grupo (Mutual API v2) + painel de controle.
 *
 * Endpoints:
 *   POST /webhook[/:channel]  -> mensagens dos grupos (comandos /COTAR, /COMPRAR...)
 *   GET  /painel              -> painel visual (toggles, filas, merchants, logs)
 *   /api/panel/*              -> API do painel
 *   GET  /health              -> healthcheck (aberto)
 *
 * Fase atual: ORDERS_ENABLED=false — o sistema NUNCA cria ordens; compras sao
 * encerradas com aviso de conclusao manual por um operador da Mutual.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import express, { type NextFunction, type Request, type Response } from "express";

import { loadConfig } from "./config.js";
import { createMutualClients } from "./mutual/client.js";
import { MerchantCache, FeeCache } from "./cache/caches.js";
import { SettingsStore } from "./state/settings.js";
import { QuoteLogRepository } from "./state/quote-log.js";
import { OutboundSender } from "./channels/outbound.js";
import { GroupResolver } from "./channels/group-resolver.js";
import { GroupMatcher } from "./core/group-matcher.js";
import { QuoteEngine } from "./core/engine.js";
import { QuoteQueue } from "./queue/quote-queue.js";
import { MessageProcessor } from "./core/processor.js";
import { createWebhookRouter } from "./http/webhook.js";
import { createPanelRouter } from "./http/panel-api.js";
import { SERVICE_NAME, SERVICE_VERSION } from "./constants.js";
import { logger } from "./logger.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  const config = loadConfig();
  const clients = createMutualClients(config);

  const merchantCache = new MerchantCache(clients, config.merchantCacheTtlMs);
  const feeCache = new FeeCache(clients, config.feeCacheTtlMs);
  const settings = new SettingsStore(config.dataDir);
  const quoteLog = new QuoteLogRepository(config.dataDir);
  const outbound = new OutboundSender(config);
  const groupResolver = new GroupResolver(config);
  const groupMatcher = new GroupMatcher(groupResolver);
  const engine = new QuoteEngine(
    clients,
    merchantCache,
    feeCache,
    config.quoteReferenceBrlAmount,
    groupMatcher,
    config.quoteTickerFallback,
  );
  const queue = new QuoteQueue(
    engine,
    outbound,
    quoteLog,
    config.quoteQueueMessages,
    config.quoteQueueIntervalMs,
  );
  const processor = new MessageProcessor(
    config,
    engine,
    queue,
    settings,
    outbound,
    quoteLog,
    merchantCache,
    groupMatcher,
  );

  // Aquecimento do cache de merchants (nao-fatal).
  merchantCache
    .getAll()
    .then((m) => logger.info("Cache de merchants aquecido", { count: m.length }))
    .catch((error) =>
      logger.warn("Falha ao aquecer cache de merchants (segue on-demand)", {
        error: String(error),
      }),
    );

  const app = express();
  app.use(express.json({ limit: "1mb" }));

  app.use((req: Request, res: Response, next: NextFunction) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
    if (req.method === "OPTIONS") {
      res.sendStatus(204);
      return;
    }
    next();
  });

  app.get("/health", (_req: Request, res: Response) => {
    res.status(200).json({ status: "ok", service: SERVICE_NAME, version: SERVICE_VERSION });
  });

  app.get("/", (_req: Request, res: Response) => {
    res.redirect("/painel");
  });

  // Painel visual (HTML estatico; a API exige PANEL_TOKEN se definido).
  const publicDir = join(__dirname, "..", "public");
  app.get("/painel", (_req: Request, res: Response) => {
    res.sendFile(join(publicDir, "index.html"));
  });

  // Documentacao da operacao (diagramas, cURLs, variaveis, requisitos).
  app.get("/docs", (_req: Request, res: Response) => {
    res.sendFile(join(publicDir, "docs.html"));
  });

  app.use(createWebhookRouter(config, processor));
  app.use(
    "/api/panel",
    createPanelRouter({
      config,
      settings,
      merchantCache,
      feeCache,
      quoteLog,
      queue,
      groupMatcher,
      clients,
    }),
  );

  app.listen(config.port, () => {
    logger.info("cotamutual iniciado", {
      port: config.port,
      ordersEnabled: config.ordersEnabled,
      quoteQueueMessages: config.quoteQueueMessages,
      quoteQueueIntervalMs: config.quoteQueueIntervalMs,
      cryptoEnv: config.cryptoEnv,
      outboundMode: config.outboundMode,
      panelAuth: Boolean(config.panelToken),
      webhookAuth: Boolean(config.webhookToken),
    });
    if (config.ordersEnabled) {
      logger.warn(
        "ORDERS_ENABLED=true, porem esta fase NAO executa ordens: compras seguem para conclusao manual.",
      );
    }
  });
}

main().catch((error) => {
  logger.error("Erro fatal ao iniciar o servidor", { error: String(error) });
  process.exit(1);
});
