/**
 * API do painel de controle.
 *
 * Endpoints (protegidos por PANEL_TOKEN, se definido):
 *   GET  /api/panel/overview   -> config, canais, grupos, toggles e filas
 *   POST /api/panel/toggle     -> liga/desliga bots por canal ou por grupo
 *   GET  /api/panel/merchants  -> merchants + auditoria da matriz de fees
 *   GET  /api/panel/logs       -> registro detalhado das cotacoes/operacoes
 */

import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import type { FeeCache, MerchantCache } from "../cache/caches.js";
import type { SettingsStore } from "../state/settings.js";
import type { QuoteLogRepository } from "../state/quote-log.js";
import type { QuoteQueue } from "../queue/quote-queue.js";
import { auditMerchantFees } from "../core/fees.js";
import type { GroupMatcher } from "../core/group-matcher.js";
import type { MutualClients } from "../mutual/client.js";
import { fetchUnitPriceBRL } from "../mutual/quote.js";
import { CRYPTO_ASSETS, normalizeAsset } from "../core/assets.js";
import { FEATURE_DEFAULTS } from "../state/settings.js";
import { describeError } from "../util/errors.js";
import { logger } from "../logger.js";

const ToggleInput = z
  .object({
    scope: z.enum(["channel", "group"]),
    channel: z.string().min(1),
    groupId: z.string().min(1).optional(),
    feature: z.enum(["quotes", "buy"]),
    enabled: z.boolean(),
  })
  .strict()
  .refine((v) => v.scope === "channel" || Boolean(v.groupId), {
    message: "groupId é obrigatório quando scope = group",
  });

export function createPanelRouter(deps: {
  config: AppConfig;
  settings: SettingsStore;
  merchantCache: MerchantCache;
  feeCache: FeeCache;
  quoteLog: QuoteLogRepository;
  queue: QuoteQueue;
  groupMatcher: GroupMatcher;
  clients: MutualClients;
}): Router {
  const { config, settings, merchantCache, feeCache, quoteLog, queue, groupMatcher, clients } =
    deps;
  const router = Router();

  const guard = (req: Request, res: Response, next: NextFunction): void => {
    if (!config.panelToken) {
      next();
      return;
    }
    const header = req.headers["authorization"];
    const query = typeof req.query.token === "string" ? req.query.token : null;
    if (header === `Bearer ${config.panelToken}` || query === config.panelToken) {
      next();
      return;
    }
    res.status(401).json({ error: "Não autorizado." });
  };

  router.use(guard);

  router.get("/overview", async (_req: Request, res: Response) => {
    const merchants = await merchantCache.getAll().catch(() => []);
    const channelOverrides = settings.listChannels();
    const groupEntries = settings.listGroups();

    // Universo de grupos: linkGroups dos merchants + grupos vistos no webhook.
    // Convites de WhatsApp (link/codigo) sao resolvidos para o JID interno,
    // para que a linha se funda com o grupo real e os toggles valham para ele.
    const groups = new Map<
      string,
      {
        channel: string;
        groupId: string;
        registeredAs: string | null;
        name: string | null;
        merchantId: string | null;
        merchantName: string | null;
        linkActive: boolean | null;
        lastSeenAt: string | null;
      }
    >();

    for (const merchant of merchants) {
      for (const link of merchant.linkGroups ?? []) {
        const channel = String(link.channel || "").toLowerCase();
        const raw = String(link.groupId).trim();
        const canonical = await groupMatcher
          .canonicalGroupId(channel, raw)
          .catch(() => raw);
        const key = `${channel}|${canonical}`;
        groups.set(key, {
          channel,
          groupId: canonical,
          registeredAs: canonical !== raw ? raw : null,
          name: link.name ?? null,
          merchantId: merchant.id,
          merchantName: merchant.legalName ?? null,
          linkActive: link.active === true && merchant.status === "active",
          lastSeenAt: null,
        });
      }
    }

    for (const [key, entry] of Object.entries(groupEntries)) {
      const [channel, groupId] = key.split("|");
      if (!channel || !groupId) continue;
      const existing = groups.get(key);
      if (existing) {
        existing.lastSeenAt = entry.lastSeenAt ?? null;
        if (!existing.name && entry.label) existing.name = entry.label;
      } else {
        groups.set(key, {
          channel,
          groupId,
          registeredAs: null,
          name: entry.label ?? null,
          merchantId: null,
          merchantName: null,
          linkActive: null,
          lastSeenAt: entry.lastSeenAt ?? null,
        });
      }
    }

    const channels = new Set<string>(["whatsapp"]);
    for (const g of groups.values()) channels.add(g.channel);
    for (const c of Object.keys(channelOverrides)) channels.add(c);

    res.json({
      config: {
        ordersEnabled: config.ordersEnabled,
        quoteQueueMessages: config.quoteQueueMessages,
        quoteQueueIntervalMs: config.quoteQueueIntervalMs,
        cryptoEnv: config.cryptoEnv,
        outboundMode: config.outboundMode,
        defaults: FEATURE_DEFAULTS,
      },
      channels: [...channels].sort().map((channel) => {
        const effective = settings.getEffective(channel, "__channel__");
        return {
          channel,
          quotesEnabled: effective.quotes,
          buyEnabled: effective.buy,
        };
      }),
      groups: [...groups.values()]
        .sort((a, b) => `${a.channel}|${a.groupId}`.localeCompare(`${b.channel}|${b.groupId}`))
        .map((g) => {
          const effective = settings.getEffective(g.channel, g.groupId);
          return {
            ...g,
            quotesEnabled: effective.quotes,
            buyEnabled: effective.buy,
            quotesSource: effective.quotesSource,
            buySource: effective.buySource,
          };
        }),
      queue: queue.snapshot(),
      merchantsCachedAt: merchantCache.snapshot().fetchedAt,
    });
  });

  router.post("/toggle", (req: Request, res: Response) => {
    const parsed = ToggleInput.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Entrada inválida." });
      return;
    }
    const input = parsed.data;

    if (input.scope === "channel") {
      settings.setChannelToggle(input.channel, input.feature, input.enabled);
    } else {
      settings.setGroupToggle(input.channel, input.groupId as string, input.feature, input.enabled);
    }

    logger.info("Toggle alterado pelo painel", input as unknown as Record<string, unknown>);
    res.json({ ok: true });
  });

  router.get("/merchants", async (_req: Request, res: Response) => {
    try {
      const merchants = await merchantCache.getAll();
      const detailed = await Promise.all(
        merchants.map(async (merchant) => {
          const fees = await feeCache.getByMerchantId(merchant.id).catch(() => []);
          return {
            id: merchant.id,
            legalName: merchant.legalName ?? null,
            legalDocument: merchant.legalDocument ?? null,
            status: merchant.status ?? null,
            linkGroups: merchant.linkGroups ?? [],
            feeCount: fees.length,
            feeAudit: auditMerchantFees(fees),
          };
        }),
      );
      res.json({ merchants: detailed });
    } catch (error) {
      logger.error("Falha ao montar visao de merchants", { error: String(error) });
      res.status(502).json({ error: "Falha ao consultar merchants na Mutual." });
    }
  });

  router.get("/logs", (req: Request, res: Response) => {
    const limit = Math.min(Number.parseInt(String(req.query.limit ?? "100"), 10) || 100, 500);
    res.json({ logs: quoteLog.recent(limit) });
  });

  // Diagnostico: testa a cotacao-base de um ativo ao vivo contra a Mutual.
  // ?asset=USDT|BTC|ETH|USDC  ?env=hml|prod (padrao: ambiente configurado)
  router.get("/diag/quote", async (req: Request, res: Response) => {
    const asset = normalizeAsset(String(req.query.asset ?? "USDT"));
    if (!CRYPTO_ASSETS.has(asset)) {
      res.status(400).json({ ok: false, error: `Ativo inválido: ${asset}` });
      return;
    }
    const envParam = String(req.query.env ?? "").toLowerCase();
    const crypto =
      envParam === "prod" ? clients.prod : envParam === "hml" ? clients.hml : clients.crypto;
    const env = envParam === "prod" || envParam === "hml" ? envParam : config.cryptoEnv;

    const startedAt = Date.now();
    try {
      const result = await fetchUnitPriceBRL(
        { ...clients, crypto },
        asset,
        config.quoteReferenceBrlAmount,
      );
      res.json({
        ok: true,
        asset,
        env,
        unitPriceBRL: result.unitPriceBRL,
        elapsedMs: Date.now() - startedAt,
        rawTicker: result.rawTicker,
      });
    } catch (error) {
      res.json({
        ok: false,
        asset,
        env,
        elapsedMs: Date.now() - startedAt,
        error: describeError(error),
      });
    }
  });

  return router;
}
