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
import { mapWithConcurrency } from "../util/concurrency.js";
import type { GroupMatcher } from "../core/group-matcher.js";
import { extractWhatsAppInviteCode } from "../channels/group-resolver.js";
import type { MutualClients } from "../mutual/client.js";
import { fetchUnitPriceBRL } from "../mutual/quote.js";
import { fetchMerchantById } from "../mutual/merchants.js";
import { DEFAULT_KNOWN_MERCHANTS, knownMerchantName } from "../mutual/known-merchants.js";
import type { MerchantStore } from "../state/merchant-store.js";
import { CRYPTO_ASSETS, normalizeAsset } from "../core/assets.js";
import { FEATURE_DEFAULTS } from "../state/settings.js";
import { describeError } from "../util/errors.js";
import { logger } from "../logger.js";

const BindInput = z
  .object({
    channel: z.string().min(1),
    groupId: z.string().min(1),
    /** Vazio remove o vínculo. */
    merchantId: z.string().optional().default(""),
    label: z.string().optional(),
  })
  .strict();

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
  merchantStore?: MerchantStore | null;
}): Router {
  const {
    config,
    settings,
    merchantCache,
    feeCache,
    quoteLog,
    queue,
    groupMatcher,
    clients,
    merchantStore,
  } = deps;
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
    // O painel nunca deve ficar mudo: se a consulta falhar, os grupos vem do
    // cache/estado local e o motivo do erro vai junto na resposta.
    let merchantsError: string | null = null;
    const merchants = await merchantCache.getAll().catch((error) => {
      merchantsError = describeError(error);
      return [];
    });
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
        /** Vinculado a mao no painel (nao veio do cadastro da Mutual). */
        manual: boolean;
        /** Link de convite usado no vinculo manual, quando houve. */
        invite: string | null;
      }
    >();

    // Vinculos manuais: chave "canal|grupo" -> convite usado (ou "").
    const manualBindings = new Map<string, string | null>();
    for (const binding of merchantStore?.bindings() ?? []) {
      manualBindings.set(`${binding.channel}|${binding.groupId}`, binding.invite ?? null);
    }

    for (const merchant of merchants) {
      for (const link of merchant.linkGroups ?? []) {
        const channel = String(link.channel || "").toLowerCase();
        const raw = String(link.groupId).trim();
        // Somente cache: o painel nao pode ficar preso resolvendo convites
        // na Evolution a cada atualizacao (a resolucao roda em background).
        const canonical = groupMatcher.canonicalGroupIdCached(channel, raw);
        const key = `${channel}|${canonical}`;
        const manualKey = `${channel}|${raw}`;
        const isManual = manualBindings.has(manualKey) || manualBindings.has(key);
        groups.set(key, {
          channel,
          groupId: canonical,
          registeredAs: canonical !== raw ? raw : null,
          name: link.name ?? null,
          merchantId: merchant.id,
          merchantName: merchant.legalName ?? null,
          linkActive: link.active === true && merchant.status === "active",
          lastSeenAt: null,
          manual: isManual,
          invite: manualBindings.get(manualKey) ?? manualBindings.get(key) ?? null,
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
          manual: false,
          invite: null,
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
      merchantsCount: merchants.length,
      merchantsSource: merchantCache.snapshot().source,
      merchantsSnapshotSavedAt: merchantCache.snapshot().snapshotSavedAt,
      // Motivo real quando a consulta de merchants falha (em vez de lista vazia).
      merchantsError: merchantsError ?? merchantCache.snapshot().lastError?.detail ?? null,
      feesError: feeCache.lastError()?.detail ?? null,
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

  /**
   * Vincula manualmente um grupo a um merchant (painel).
   *
   * O operador informa o LINK DE CONVITE do WhatsApp (o usuario final nao sabe
   * o JID interno). O convite e resolvido aqui, na hora, pela Evolution:
   * gravamos o JID como forma canonica e guardamos o link como referencia. Se
   * a resolucao falhar (instancia fora do grupo, link revogado), o vinculo e
   * gravado pelo proprio convite e passa a valer assim que a Evolution
   * responder — o GroupMatcher resolve na chegada da mensagem.
   */
  router.post("/bind-group", async (req: Request, res: Response) => {
    const parsed = BindInput.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Entrada inválida." });
      return;
    }
    const { channel, merchantId, label } = parsed.data;
    const raw = parsed.data.groupId.trim();
    if (!merchantStore) {
      res.status(503).json({ error: "Armazenamento de vínculos indisponível." });
      return;
    }

    const isWhatsApp = channel.toLowerCase() === "whatsapp";
    const inviteCode = isWhatsApp ? extractWhatsAppInviteCode(raw) : null;

    if (isWhatsApp && !inviteCode && !raw.endsWith("@g.us")) {
      res.status(400).json({
        error:
          "Informe o link de convite do grupo (https://chat.whatsapp.com/CODIGO) ou o JID interno (…@g.us).",
      });
      return;
    }

    // Convite -> JID, sempre com consulta nova (force): o operador pode estar
    // repetindo a acao justamente por ter acabado de colocar a instancia no
    // grupo, e o cache guarda a falha anterior por 60s.
    const canonical = inviteCode ? await groupMatcher.canonicalGroupId(channel, raw, true) : raw;
    const resolved = inviteCode && canonical !== raw ? canonical : null;
    const warning =
      inviteCode && !resolved
        ? "Não foi possível resolver o convite na Evolution agora (a instância precisa estar no grupo). O vínculo foi salvo pelo link e passa a valer assim que a resolução funcionar."
        : null;

    if (!merchantId) {
      // Desvincular aceita qualquer uma das formas (link ou JID).
      const removed = merchantStore.unbindGroup(channel, canonical, raw, inviteCode);
      merchantCache.invalidate();
      res.json({ ok: true, unbound: removed, groupId: canonical });
      return;
    }

    const binding = merchantStore.bindGroup(
      channel,
      canonical,
      merchantId,
      label,
      inviteCode ? raw : null,
    );
    merchantCache.invalidate();
    res.json({ ok: true, binding, resolvedJid: resolved, warning });
  });

  /** Catálogo de merchants conhecidos (para o seletor do painel). */
  router.get("/known-merchants", (_req: Request, res: Response) => {
    const known = merchantCache.snapshot().merchants.map((m) => ({
      id: m.id,
      legalName: m.legalName ?? knownMerchantName(m.id) ?? null,
    }));
    const seeds = DEFAULT_KNOWN_MERCHANTS.filter((s) => !known.some((k) => k.id === s.id));
    res.json({
      merchants: [...known, ...seeds].sort((a, b) =>
        String(a.legalName ?? a.id).localeCompare(String(b.legalName ?? b.id)),
      ),
      bindings: merchantStore?.bindings() ?? [],
    });
  });

  router.get("/merchants", async (_req: Request, res: Response) => {
    try {
      const merchants = await merchantCache.getAll();
      // Concorrencia limitada: dezenas de chamadas simultaneas de fees
      // disparam limite de requisicoes na Mutual e derrubam as cotacoes.
      const detailed = await mapWithConcurrency(merchants, 4, async (merchant) => {
        let fees: Awaited<ReturnType<typeof feeCache.getByMerchantId>> = [];
        let feesError: string | null = null;
        try {
          fees = await feeCache.getByMerchantId(merchant.id);
        } catch (error) {
          feesError = describeError(error);
        }
        return {
          id: merchant.id,
          legalName: merchant.legalName ?? null,
          legalDocument: merchant.legalDocument ?? null,
          status: merchant.status ?? null,
          linkGroups: merchant.linkGroups ?? [],
          feeCount: fees.length,
          feesError,
          feeAudit: auditMerchantFees(fees),
        };
      });
      res.json({ merchants: detailed, count: detailed.length });
    } catch (error) {
      const detail = describeError(error);
      logger.error("Falha ao montar visao de merchants", { error: detail });
      res.status(502).json({ error: `Falha ao consultar merchants na Mutual: ${detail}` });
    }
  });

  /**
   * Diagnostico: testa os DOIS caminhos (listagem e consulta individual por
   * organizacao) direto na Mutual, sem cache, mostrando status e corpo do erro.
   */
  router.get("/diag/merchants", async (req: Request, res: Response) => {
    const snap = merchantCache.snapshot();
    const testId = String(req.query.id ?? "") || snap.merchants[0]?.id || merchantCache.knownIds()[0];

    // Caminho 2: consulta individual (o fallback que mantem o sistema de pe).
    const individualStart = Date.now();
    let individual: Record<string, unknown> = { tested: false };
    if (testId) {
      try {
        const merchant = await fetchMerchantById(clients, testId, config.merchantByIdPath);
        individual = {
          tested: true,
          id: testId,
          ok: Boolean(merchant),
          elapsedMs: Date.now() - individualStart,
          legalName: merchant?.legalName ?? null,
          status: merchant?.status ?? null,
          linkGroups: merchant?.linkGroups?.length ?? 0,
        };
      } catch (error) {
        individual = {
          tested: true,
          id: testId,
          ok: false,
          elapsedMs: Date.now() - individualStart,
          error: describeError(error),
        };
      }
    }

    const cacheInfo = {
      source: snap.source,
      cachedAt: snap.fetchedAt,
      cachedCount: snap.merchants.length,
      knownIdCount: snap.knownIdCount,
      snapshotSavedAt: snap.snapshotSavedAt,
      fallbackFailedIds: snap.fallbackFailedIds.slice(0, 5),
      lastError: snap.lastError,
    };

    const startedAt = Date.now();
    try {
      const response = await clients.prod.get("/api/v2/resource/merchants", {
        params: { page: 1, limit: 100 },
      });
      const body = response.data as { data?: unknown[]; pagination?: unknown };
      const list = Array.isArray(body?.data) ? body.data : [];
      res.json({
        ok: true,
        httpStatus: response.status,
        count: list.length,
        pagination: body?.pagination ?? null,
        elapsedMs: Date.now() - startedAt,
        sample: list.slice(0, 3).map((m) => {
          const merchant = m as Record<string, unknown>;
          return {
            id: merchant.id,
            legalName: merchant.legalName,
            status: merchant.status,
            linkGroups: Array.isArray(merchant.linkGroups) ? merchant.linkGroups.length : 0,
          };
        }),
        individual,
        cache: cacheInfo,
      });
    } catch (error) {
      res.json({
        ok: false,
        listing: { ok: false, error: describeError(error), elapsedMs: Date.now() - startedAt },
        // Mesmo com a listagem fora, o sistema opera pela consulta individual.
        individual,
        cache: cacheInfo,
        hint: individual.ok
          ? "Listagem indisponível, mas a consulta individual por organização está funcionando — o sistema opera pelo fallback."
          : "Listagem e consulta individual falharam; verifique credenciais ou use MUTUAL_MERCHANT_BY_ID_PATH.",
      });
    }
  });

  router.get("/logs", (req: Request, res: Response) => {
    const limit = Math.min(Number.parseInt(String(req.query.limit ?? "100"), 10) || 100, 500);
    res.json({ logs: quoteLog.recent(limit) });
  });

  // Diagnostico: testa a cotacao-base de um ativo ao vivo contra a Mutual.
  // ?asset=USDT|BTC|ETH|USDC  ?env=hml|prod  ?side=buy|sell (padrao: buy)
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
    const side = String(req.query.side ?? "buy").toLowerCase() === "sell" ? "sell" : "buy";

    const startedAt = Date.now();
    try {
      const result = await fetchUnitPriceBRL(
        { ...clients, crypto },
        asset,
        config.quoteReferenceBrlAmount,
        side,
        config.quoteTickerFallback,
      );
      res.json({
        ok: true,
        asset,
        env,
        side,
        // Preco de mercado SEM fee — a fee do merchant e somada na cotacao do grupo.
        unitPriceBRL: result.unitPriceBRL,
        priceSource: result.source,
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
