/**
 * Processador central de mensagens recebidas dos grupos.
 *
 * Fluxo:
 *   mensagem -> canal+grupo -> merchant -> toggles do painel -> comando ->
 *   fila de cotacoes (10 msgs, requisicoes separadas) OU confirmacao (/COMPRA, /VENDA).
 *
 * Regra do produto: nenhuma resposta cita "bot ligado/desligado". Quando um
 * recurso esta inativo, a resposta diz apenas que a operacao sera concluida
 * manualmente por um operador da Mutual.
 *
 * Blindagem da confirmacao:
 *   - exige cotacao ativa (nunca confirma sem preco valido);
 *   - o lado pedido precisa existir na cotacao (fee cadastrada);
 *   - argumentos precisam bater com a cotacao ativa;
 *   - a cotacao e consumida: uma confirmacao por cotacao.
 */

import { randomUUID } from "node:crypto";
import type { AppConfig } from "../config.js";
import type { MerchantCache } from "../cache/caches.js";
import type { OutboundSender } from "../channels/outbound.js";
import type { QuoteLogRepository } from "../state/quote-log.js";
import type { SettingsStore } from "../state/settings.js";
import type { LastQuoteInfo, QuoteQueue } from "../queue/quote-queue.js";
import { QuoteEngine, QuoteUserError } from "./engine.js";
import type { GroupMatcher } from "./group-matcher.js";
import { parseCommand, type ParsedCommand, type TradeSide } from "./parser.js";
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
    | "trade-manual"
    | "trade-orders-disabled"
    | "trade-need-quote"
    | "trade-side-unavailable"
    | "trade-mismatch"
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

    const reply = (message: string) => this.outbound.send({ channel, groupId, text: message });

    if (parsed.kind === "help") {
      await reply(MESSAGES.help);
      return { handled: true, action: "help" };
    }

    if (parsed.kind === "invalid") {
      const usage =
        parsed.reason === "unknown-asset" ? MESSAGES.unknownAsset : MESSAGES.usageQuote;
      await reply(usage);
      return { handled: true, action: "usage" };
    }

    const toggles = this.settings.getEffective(channel, groupId);

    if (parsed.kind === "trade") {
      return this.handleTrade({ channel, groupId, parsed, toggles, reply });
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
      logger.error("Falha inesperada ao preparar cotacao", { channel, groupId, error: detail });
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

  // --------------------- Confirmacao (/COMPRA, /VENDA) ----------------------
  private async handleTrade(params: {
    channel: string;
    groupId: string;
    parsed: Extract<ParsedCommand, { kind: "trade" }>;
    toggles: { buy: boolean };
    reply: (message: string) => Promise<boolean>;
  }): Promise<ProcessOutcome> {
    const { channel, groupId, parsed, toggles, reply } = params;
    const side: TradeSide = parsed.side;

    // Grupo precisa estar vinculado a um merchant ativo.
    const merchants = await this.merchantCache.getAll().catch(() => []);
    const merchant = await this.groupMatcher.findMerchant(merchants, channel, groupId);
    if (!merchant) {
      await reply(MESSAGES.groupNotLinked);
      return { handled: true, action: "group-not-linked" };
    }

    const pending = this.queue.peekLastQuote(channel, groupId);

    // Argumentos precisam bater com a cotacao ativa.
    if (parsed.argsPresent) {
      if (!parsed.argsValid) {
        const text = MESSAGES.tradeArgsNotUnderstood(pending?.summary ?? null);
        await reply(text);
        this.logTrade("trade-mismatch", { channel, groupId, merchant, parsed, text });
        return { handled: true, action: "trade-mismatch" };
      }

      const assetMatches = parsed.asset ? pending?.asset === parsed.asset : Boolean(pending);
      const amountMatches =
        parsed.amount !== undefined && pending
          ? Math.abs(parsed.amount - pending.amount) < 1e-9 &&
            (parsed.sizeKind ? parsed.sizeKind === pending.sizeKind : true)
          : true;

      if (!pending || !assetMatches || !amountMatches) {
        const requested = [
          parsed.amountRaw ?? (parsed.amount !== undefined ? String(parsed.amount) : null),
          parsed.sizeKind === "brl" ? "BRL" : null,
          parsed.asset ?? pending?.asset ?? "<ativo>",
        ]
          .filter(Boolean)
          .join(" ");
        const text = MESSAGES.tradeMismatch(pending?.summary ?? null, requested);
        await reply(text);
        this.logTrade("trade-mismatch", { channel, groupId, merchant, parsed, text });
        return { handled: true, action: "trade-mismatch" };
      }
    }

    // Sem cotacao valida: nunca confirmar no escuro.
    if (!pending) {
      await reply(MESSAGES.tradeNeedQuote);
      this.logTrade("trade-need-quote", {
        channel,
        groupId,
        merchant,
        parsed,
        text: MESSAGES.tradeNeedQuote,
      });
      return { handled: true, action: "trade-need-quote" };
    }

    // O lado pedido precisa ter preco valido na cotacao ativa.
    const sideQuote = side === "buy" ? pending.buy : pending.sell;
    if (pending.mode === "pair" && !sideQuote) {
      const text = MESSAGES.tradeSideUnavailable(side);
      await reply(text);
      this.logTrade("trade-side-unavailable", { channel, groupId, merchant, parsed, text });
      return { handled: true, action: "trade-side-unavailable" };
    }

    // Consome a cotacao: uma confirmacao por cotacao.
    const confirmed = this.queue.consumeForTrade(channel, groupId);
    if (!confirmed) {
      await reply(MESSAGES.tradeNeedQuote);
      this.logTrade("trade-need-quote", {
        channel,
        groupId,
        merchant,
        parsed,
        text: MESSAGES.tradeNeedQuote,
      });
      return { handled: true, action: "trade-need-quote" };
    }

    const transactionId = randomUUID();
    // Compra ativada no painel + ORDERS_ENABLED=false: NUNCA chamar
    // POST /api/v2/crypto/orders — mesma conclusao manual, com o aviso de
    // execucao automatica indisponivel.
    const closing = toggles.buy ? MESSAGES.ordersNotEnabledClosing : MESSAGES.manualClosing;

    const record = this.buildRecord(confirmed, side, groupId, transactionId);
    const text = MESSAGES.tradeWithRecord(record, closing);
    await reply(text);

    this.quoteLog.create({
      type: toggles.buy ? "trade-orders-disabled" : "trade-manual",
      channel,
      groupId,
      merchantId: merchant.id,
      merchantName: merchant.legalName ?? null,
      transactionId,
      operation: side,
      sourceAsset: side === "buy" ? "BRL" : confirmed.asset,
      destinationAsset: side === "buy" ? confirmed.asset : confirmed.counterAsset,
      result: confirmed.cross ? confirmed.cross.result : (side === "buy" ? confirmed.buy : confirmed.sell),
      detail: confirmed.summary,
      messageSent: text,
      command: parsed.raw,
    });

    return {
      handled: true,
      action: toggles.buy ? "trade-orders-disabled" : "trade-manual",
    };
  }

  private buildRecord(
    quote: LastQuoteInfo,
    side: TradeSide,
    groupId: string,
    transactionId: string,
  ): string {
    if (quote.mode === "cross" && quote.cross) {
      const result = quote.cross.result;
      const received = result.kind === "receive-side" ? result.netAmount : result.quantity;
      return formatOperationRecord({
        groupId,
        transactionId,
        date: new Date(),
        side: "conversion",
        asset: quote.asset,
        counterAsset: quote.counterAsset,
        quantity: quote.amount,
        counterTotal: received,
        unitPrice: result.finalUnitPrice,
      });
    }

    const sideQuote = side === "buy" ? quote.buy : quote.sell;
    // Nunca chega aqui sem o lado (validado antes), mas o fallback evita
    // qualquer chance de registro com numero errado.
    if (!sideQuote) {
      throw new Error(`Lado ${side} indisponível na cotação confirmada`);
    }

    return formatOperationRecord({
      groupId,
      transactionId,
      date: new Date(),
      side,
      asset: quote.asset,
      counterAsset: "BRL",
      quantity: sideQuote.quantity,
      counterTotal: sideQuote.totalBRL,
      unitPrice: sideQuote.unitPrice,
    });
  }

  private logTrade(
    type: "trade-mismatch" | "trade-need-quote" | "trade-side-unavailable",
    params: {
      channel: string;
      groupId: string;
      merchant: { id: string; legalName?: string };
      parsed: Extract<ParsedCommand, { kind: "trade" }>;
      text: string;
    },
  ): void {
    this.quoteLog.create({
      type,
      channel: params.channel,
      groupId: params.groupId,
      merchantId: params.merchant.id,
      merchantName: params.merchant.legalName ?? null,
      operation: params.parsed.side,
      messageSent: params.text,
      command: params.parsed.raw,
    });
  }
}
