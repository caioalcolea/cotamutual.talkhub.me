/**
 * Processador central de mensagens recebidas dos grupos.
 *
 * Fluxo (secao 2 do descritivo):
 *   mensagem -> canal+grupo -> merchant -> toggles do painel -> comando ->
 *   fila de cotacoes (10 msgs, requisicoes separadas) OU encerramento por compra.
 *
 * Regra do produto: nenhuma resposta cita "bot ligado/desligado". Quando um
 * recurso esta inativo, a resposta diz apenas que a operacao sera concluida
 * manualmente por um operador da Mutual.
 */

import type { AppConfig } from "../config.js";
import type { MerchantCache } from "../cache/caches.js";
import type { OutboundSender } from "../channels/outbound.js";
import type { QuoteLogRepository } from "../state/quote-log.js";
import type { SettingsStore } from "../state/settings.js";
import type { QuoteQueue } from "../queue/quote-queue.js";
import { QuoteEngine, QuoteUserError } from "./engine.js";
import { findMerchantByGroup } from "./merchants.js";
import { parseCommand } from "./parser.js";
import { MESSAGES } from "./format.js";
import { logger } from "../logger.js";

export interface IncomingMessage {
  channel: string;
  groupId: string;
  text: string;
  groupName?: string;
}

export interface ProcessOutcome {
  handled: boolean;
  action:
    | "ignored"
    | "help"
    | "usage"
    | "quote-queued"
    | "quote-manual"
    | "quote-error"
    | "buy-manual"
    | "buy-orders-disabled"
    | "group-not-linked";
}

export class MessageProcessor {
  constructor(
    private readonly config: AppConfig,
    private readonly engine: QuoteEngine,
    private readonly queue: QuoteQueue,
    private readonly settings: SettingsStore,
    private readonly outbound: OutboundSender,
    private readonly quoteLog: QuoteLogRepository,
    private readonly merchantCache: MerchantCache,
  ) {}

  async handle(incoming: IncomingMessage): Promise<ProcessOutcome> {
    const channel = String(incoming.channel || "").toLowerCase().trim();
    const groupId = String(incoming.groupId || "").trim();
    const text = String(incoming.text || "");

    if (!channel || !groupId) return { handled: false, action: "ignored" };

    this.settings.touchGroup(channel, groupId, incoming.groupName);

    const parsed = parseCommand(text);
    if (!parsed) return { handled: false, action: "ignored" };

    const reply = (message: string) =>
      this.outbound.send({ channel, groupId, text: message });

    if (parsed.kind === "help") {
      await reply(MESSAGES.help);
      return { handled: true, action: "help" };
    }

    if (parsed.kind === "invalid") {
      const usage =
        parsed.reason === "usage-sell"
          ? MESSAGES.usageSell
          : parsed.reason === "unknown-asset"
            ? MESSAGES.unknownAsset
            : MESSAGES.usageQuote;
      await reply(usage);
      return { handled: true, action: "usage" };
    }

    const toggles = this.settings.getEffective(channel, groupId);

    // ----------------------- Compra (/COMPRAR, /ORDER) -----------------------
    if (parsed.kind === "buy") {
      // Grupo precisa estar vinculado a um merchant ativo.
      const merchants = await this.merchantCache.getAll().catch(() => []);
      const merchant = findMerchantByGroup(merchants, channel, groupId);
      if (!merchant) {
        await reply(MESSAGES.groupNotLinked);
        return { handled: true, action: "group-not-linked" };
      }

      // A compra SEMPRE interrompe a fila de cotacoes em andamento.
      const lastQuote = this.queue.interruptForBuy(channel, groupId);

      if (!toggles.buy) {
        // Execucao automatica inativa (padrao): operacao manual pela Mutual.
        await reply(MESSAGES.buyManual(lastQuote));
        this.quoteLog.create({
          type: "buy-manual",
          channel,
          groupId,
          merchantId: merchant.id,
          merchantName: merchant.legalName ?? null,
          detail: lastQuote,
          command: parsed.raw,
        });
        return { handled: true, action: "buy-manual" };
      }

      // Compra ativada no painel, mas nesta fase ORDERS_ENABLED=false:
      // NUNCA chamar POST /api/v2/crypto/orders (secao 16/19 do descritivo).
      await reply(MESSAGES.ordersNotEnabled(lastQuote));
      this.quoteLog.create({
        type: "buy-interrupt",
        channel,
        groupId,
        merchantId: merchant.id,
        merchantName: merchant.legalName ?? null,
        detail: lastQuote,
        command: parsed.raw,
      });
      return { handled: true, action: "buy-orders-disabled" };
    }

    // ------------------------------ Cotacao ---------------------------------
    if (!toggles.quotes) {
      // Cotacao inativa neste grupo/canal: tratamento manual pela Mutual.
      await reply(MESSAGES.quotesManual);
      this.quoteLog.create({
        type: "quote-manual",
        channel,
        groupId,
        sourceAsset: parsed.sourceAsset,
        destinationAsset: parsed.destinationAsset,
        command: parsed.raw,
      });
      return { handled: true, action: "quote-manual" };
    }

    try {
      const context = await this.engine.prepareContext({ channel, groupId, parsed });
      this.queue.start(context);
      return { handled: true, action: "quote-queued" };
    } catch (error) {
      if (error instanceof QuoteUserError) {
        await reply(error.userMessage);
        this.quoteLog.create({
          type: "error",
          channel,
          groupId,
          sourceAsset: parsed.sourceAsset,
          destinationAsset: parsed.destinationAsset,
          detail: error.userMessage,
          command: parsed.raw,
        });
        return { handled: true, action: "quote-error" };
      }
      logger.error("Falha inesperada ao preparar cotacao", {
        channel,
        groupId,
        error: String(error),
      });
      await reply(MESSAGES.quoteFailed);
      this.quoteLog.create({
        type: "error",
        channel,
        groupId,
        detail: String(error),
        command: parsed.raw,
      });
      return { handled: true, action: "quote-error" };
    }
  }
}
