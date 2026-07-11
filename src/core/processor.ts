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

import { randomUUID } from "node:crypto";
import type { AppConfig } from "../config.js";
import type { MerchantCache } from "../cache/caches.js";
import type { OutboundSender } from "../channels/outbound.js";
import type { QuoteLogRepository } from "../state/quote-log.js";
import type { SettingsStore } from "../state/settings.js";
import type { QuoteQueue } from "../queue/quote-queue.js";
import { QuoteEngine, QuoteUserError } from "./engine.js";
import type { GroupMatcher } from "./group-matcher.js";
import { parseCommand } from "./parser.js";
import { formatOperationRecord, MESSAGES } from "./format.js";
import { describeError } from "../util/errors.js";
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
    | "buy-need-quote"
    | "buy-mismatch"
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
    private readonly groupMatcher: GroupMatcher,
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
      const merchant = await this.groupMatcher.findMerchant(merchants, channel, groupId);
      if (!merchant) {
        await reply(MESSAGES.groupNotLinked);
        return { handled: true, action: "group-not-linked" };
      }

      // Argumentos do /COMPRAR (ex: /COMPRAR 1K BTC) precisam bater com a
      // cotacao ativa — nunca confirmar uma operacao diferente da cotada.
      const pending = this.queue.peekLastQuote(channel, groupId);
      if (parsed.argsPresent) {
        if (!parsed.argsValid) {
          const text = MESSAGES.buyArgsNotUnderstood(pending?.summary ?? null);
          await reply(text);
          this.quoteLog.create({
            type: "buy-mismatch",
            channel,
            groupId,
            merchantId: merchant.id,
            detail: pending?.summary ?? null,
            messageSent: text,
            command: parsed.raw,
          });
          return { handled: true, action: "buy-mismatch" };
        }

        // Ativo transacionado da cotacao ativa (perna nao-BRL).
        const pendingAsset = pending
          ? pending.destinationAsset !== "BRL"
            ? pending.destinationAsset
            : pending.sourceAsset
          : null;
        const assetMatches = parsed.asset ? parsed.asset === pendingAsset : Boolean(pending);
        const amountMatches =
          parsed.amount !== undefined && pending
            ? Math.abs(parsed.amount - pending.amount) < 1e-9
            : true;

        if (!pending || !assetMatches || !amountMatches) {
          const requested = [
            parsed.amount !== undefined ? String(parsed.amount) : null,
            parsed.asset ?? pendingAsset ?? "<ativo>",
          ]
            .filter(Boolean)
            .join(" ");
          const text = MESSAGES.buyMismatch(pending?.summary ?? null, requested);
          await reply(text);
          this.quoteLog.create({
            type: "buy-mismatch",
            channel,
            groupId,
            merchantId: merchant.id,
            detail: `pedido: ${parsed.raw} | ativa: ${pending?.summary ?? "nenhuma"}`,
            messageSent: text,
            command: parsed.raw,
          });
          return { handled: true, action: "buy-mismatch" };
        }
      }

      // A compra interrompe a fila e CONSOME a cotacao: cada cotacao confirma
      // no maximo UMA operacao — o proximo /COMPRAR exige cotacao nova.
      const lastQuote = this.queue.interruptForBuy(channel, groupId);
      if (!lastQuote) {
        await reply(MESSAGES.buyNeedQuote);
        this.quoteLog.create({
          type: "buy-need-quote",
          channel,
          groupId,
          merchantId: merchant.id,
          merchantName: merchant.legalName ?? null,
          messageSent: MESSAGES.buyNeedQuote,
          command: parsed.raw,
        });
        return { handled: true, action: "buy-need-quote" };
      }

      const transactionId = randomUUID();

      // Compra ativada no painel + ORDERS_ENABLED=false: NUNCA chamar
      // POST /api/v2/crypto/orders (secao 16/19 do descritivo) — mesma
      // conclusao manual, com o aviso de execucao automatica indisponivel.
      const closing = toggles.buy ? MESSAGES.ordersNotEnabledClosing : MESSAGES.manualClosing;
      const record = formatOperationRecord({
        groupId,
        transactionId,
        date: new Date(),
        operation: lastQuote.operation,
        sourceAsset: lastQuote.sourceAsset,
        destinationAsset: lastQuote.destinationAsset,
        result: lastQuote.result,
      });
      const text = MESSAGES.buyWithRecord(record, closing);

      await reply(text);
      this.quoteLog.create({
        type: toggles.buy ? "buy-interrupt" : "buy-manual",
        channel,
        groupId,
        merchantId: merchant.id,
        merchantName: merchant.legalName ?? null,
        transactionId,
        operation: lastQuote?.operation ?? null,
        sourceAsset: lastQuote?.sourceAsset ?? null,
        destinationAsset: lastQuote?.destinationAsset ?? null,
        result: lastQuote?.result ?? null,
        detail: lastQuote?.summary ?? null,
        messageSent: text,
        command: parsed.raw,
      });
      return { handled: true, action: toggles.buy ? "buy-orders-disabled" : "buy-manual" };
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
      const detail = describeError(error);
      logger.error("Falha inesperada ao preparar cotacao", {
        channel,
        groupId,
        error: detail,
      });
      await reply(MESSAGES.quoteFailed);
      this.quoteLog.create({
        type: "error",
        channel,
        groupId,
        sourceAsset: parsed.sourceAsset,
        destinationAsset: parsed.destinationAsset,
        detail,
        command: parsed.raw,
      });
      return { handled: true, action: "quote-error" };
    }
  }
}
