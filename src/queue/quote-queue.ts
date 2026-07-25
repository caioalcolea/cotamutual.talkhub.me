/**
 * Fila de cotacoes: toda cotacao envia N mensagens (padrao 10), cada uma com
 * REQUISICAO PROPRIA a Mutual (os precos variam de segundo a segundo).
 *
 * A fila e interrompida imediatamente por uma confirmacao (/COMPRA ou /VENDA).
 * Uma nova cotacao no mesmo grupo substitui a fila em andamento.
 *
 * A ultima cotacao de cada grupo fica guardada por 15 minutos e vale para UMA
 * unica confirmacao (consumida pelo /COMPRA ou /VENDA).
 */

import { randomUUID } from "node:crypto";
import type { QuoteEngine, QuoteContext, SideQuote } from "../core/engine.js";
import { contextSummary } from "../core/engine.js";
import {
  formatCrossQuoteMessage,
  formatPairQuoteMessage,
  formatPairSummary,
  formatQty,
  MESSAGES,
} from "../core/format.js";
import type { QuoteCalculation } from "../core/pricing.js";
import type { SizeKind, TradeSide } from "../core/parser.js";
import type { OutboundSender } from "../channels/outbound.js";
import type { QuoteLogRepository } from "../state/quote-log.js";
import { describeError } from "../util/errors.js";
import { logger } from "../logger.js";

function sessionKey(channel: string, groupId: string): string {
  return `${String(channel).toLowerCase()}|${String(groupId).trim()}`;
}

/** Por quanto tempo a ultima cotacao do grupo vale para confirmacao. */
const LAST_QUOTE_TTL_MS = 15 * 60 * 1000;

/** Ultima cotacao completa de um grupo (base do registro de operacao). */
export interface LastQuoteInfo {
  mode: "pair" | "cross";
  /** Ativo do par (pair) ou ativo de origem (cross). */
  asset: string;
  /** BRL (pair) ou ativo de destino (cross). */
  counterAsset: string;
  sizeKind: SizeKind;
  amount: number;
  amountRaw: string;
  buy: SideQuote | null;
  sell: SideQuote | null;
  cross: { operation: string; result: QuoteCalculation } | null;
  summary: string;
  at: number;
}

export interface QueueSessionSnapshot {
  id: string;
  channel: string;
  groupId: string;
  merchantId: string;
  merchantName: string | null;
  operation: string;
  sourceAsset: string;
  destinationAsset: string;
  command: string;
  sequence: number;
  total: number;
  status: "running" | "finished" | "interrupted" | "failed";
  startedAt: string;
  lastQuoteSummary: string | null;
}

interface QueueSession {
  id: string;
  context: QuoteContext;
  sequence: number;
  total: number;
  status: QueueSessionSnapshot["status"];
  startedAt: string;
  cancelled: boolean;
  wake: (() => void) | null;
  lastQuoteSummary: string | null;
}

export class QuoteQueue {
  private readonly sessions = new Map<string, QueueSession>();
  private readonly history: QueueSessionSnapshot[] = [];
  private readonly lastQuotes = new Map<string, LastQuoteInfo>();

  constructor(
    private readonly engine: QuoteEngine,
    private readonly outbound: OutboundSender,
    private readonly quoteLog: QuoteLogRepository,
    private readonly totalMessages: number,
    private readonly intervalMs: number,
    private readonly settlementLabel: string = "D0",
  ) {}

  /** Inicia a fila para o grupo, substituindo qualquer fila em andamento. */
  start(context: QuoteContext): QueueSessionSnapshot {
    const key = sessionKey(context.channel, context.groupId);
    this.cancel(key, "interrupted");

    const session: QueueSession = {
      id: randomUUID(),
      context,
      sequence: 0,
      total: this.totalMessages,
      status: "running",
      startedAt: new Date().toISOString(),
      cancelled: false,
      wake: null,
      lastQuoteSummary: null,
    };
    this.sessions.set(key, session);

    void this.run(key, session);
    return this.snapshotOf(session);
  }

  /** Ultima cotacao do grupo (TTL 15min) SEM consumir nem interromper a fila. */
  peekLastQuote(channel: string, groupId: string): LastQuoteInfo | null {
    const key = sessionKey(channel, groupId);
    const recent = this.lastQuotes.get(key);
    if (recent && Date.now() - recent.at < LAST_QUOTE_TTL_MS) {
      return recent;
    }
    return null;
  }

  /**
   * Interrompe a fila do grupo por uma confirmacao e CONSOME a cotacao:
   * cada cotacao confirma no maximo UMA operacao — a proxima confirmacao
   * exige uma cotacao nova.
   */
  consumeForTrade(channel: string, groupId: string): LastQuoteInfo | null {
    const key = sessionKey(channel, groupId);
    this.cancel(key, "interrupted");

    const recent = this.peekLastQuote(channel, groupId);
    this.lastQuotes.delete(key);
    return recent;
  }

  /** Snapshot das filas ativas + historico recente (painel). */
  snapshot(): { active: QueueSessionSnapshot[]; recent: QueueSessionSnapshot[] } {
    return {
      active: [...this.sessions.values()].map((s) => this.snapshotOf(s)),
      recent: this.history.slice(-20).reverse(),
    };
  }

  private snapshotOf(session: QueueSession): QueueSessionSnapshot {
    const summary = contextSummary(session.context);
    return {
      id: session.id,
      channel: session.context.channel,
      groupId: session.context.groupId,
      merchantId: session.context.merchant.id,
      merchantName: session.context.merchant.legalName ?? null,
      operation: summary.operation,
      sourceAsset: summary.sourceAsset,
      destinationAsset: summary.destinationAsset,
      command: session.context.command,
      sequence: session.sequence,
      total: session.total,
      status: session.status,
      startedAt: session.startedAt,
      lastQuoteSummary: session.lastQuoteSummary,
    };
  }

  private cancel(key: string, status: QueueSessionSnapshot["status"]): void {
    const session = this.sessions.get(key);
    if (!session) return;
    session.cancelled = true;
    session.status = status;
    session.wake?.();
    this.sessions.delete(key);
    this.history.push(this.snapshotOf(session));
    if (this.history.length > 50) this.history.splice(0, this.history.length - 50);
  }

  private sleep(session: QueueSession, ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        session.wake = null;
        resolve();
      }, ms);
      // Cancelamento acorda o sleep imediatamente (interrupcao pela confirmacao).
      session.wake = () => {
        clearTimeout(timer);
        session.wake = null;
        resolve();
      };
    });
  }

  private async run(key: string, session: QueueSession): Promise<void> {
    const ctx = session.context;
    const label = contextSummary(ctx);
    let consecutiveErrors = 0;

    for (let i = 1; i <= session.total; i += 1) {
      if (session.cancelled) return;

      try {
        // Requisicao NOVA a Mutual a cada mensagem da fila.
        const tick = await this.engine.tick(ctx);
        if (session.cancelled) return;

        session.sequence = i;

        let message: string;
        let summary: string;
        let last: LastQuoteInfo;

        if (tick.mode === "pair" && ctx.mode === "pair") {
          message = formatPairQuoteMessage({
            asset: tick.asset,
            sizeKind: tick.sizeKind,
            amountRaw: ctx.amountRaw,
            amount: tick.amount,
            buy: tick.buy,
            sell: tick.sell,
            sequence: i,
            total: session.total,
            settlementLabel: this.settlementLabel,
            usdRateBRL: tick.usdRateBRL,
          });
          summary = formatPairSummary({
            asset: tick.asset,
            amountRaw: ctx.amountRaw,
            sizeKind: tick.sizeKind,
            buy: tick.buy,
            sell: tick.sell,
          });
          last = {
            mode: "pair",
            asset: tick.asset,
            counterAsset: "BRL",
            sizeKind: tick.sizeKind,
            amount: tick.amount,
            amountRaw: ctx.amountRaw,
            buy: tick.buy,
            sell: tick.sell,
            cross: null,
            summary,
            at: Date.now(),
          };
        } else if (tick.mode === "cross" && ctx.mode === "cross") {
          message = formatCrossQuoteMessage({
            sourceAsset: ctx.sourceAsset,
            destinationAsset: ctx.destinationAsset,
            amountRaw: ctx.amountRaw,
            amount: ctx.amount,
            result: tick.result,
            sequence: i,
            total: session.total,
            settlementLabel: this.settlementLabel,
          });
          const received =
            tick.result.kind === "receive-side" ? tick.result.netAmount : tick.result.quantity;
          summary = `${ctx.amountRaw} ${ctx.sourceAsset} = ${formatQty(received)} ${ctx.destinationAsset}`;
          last = {
            mode: "cross",
            asset: ctx.sourceAsset,
            counterAsset: ctx.destinationAsset,
            sizeKind: "asset",
            amount: ctx.amount,
            amountRaw: ctx.amountRaw,
            buy: null,
            sell: null,
            cross: { operation: ctx.operation, result: tick.result },
            summary,
            at: Date.now(),
          };
        } else {
          throw new Error("Modo de cotação inconsistente entre contexto e tick");
        }

        session.lastQuoteSummary = summary;
        this.lastQuotes.set(key, last);

        await this.outbound.send({ channel: ctx.channel, groupId: ctx.groupId, text: message });

        // Painel/log com TODOS os detalhes internos.
        this.quoteLog.create({
          type: "quote-tick",
          channel: ctx.channel,
          groupId: ctx.groupId,
          merchantId: ctx.merchant.id,
          merchantName: ctx.merchant.legalName ?? null,
          operation: label.operation,
          sourceAsset: label.sourceAsset,
          destinationAsset: label.destinationAsset,
          sequence: i,
          totalMessages: session.total,
          result: tick.mode === "pair" ? { buy: tick.buy, sell: tick.sell } : tick.result,
          basePrice: tick.mode === "pair" ? (tick.buy?.basePrice ?? tick.sell?.basePrice ?? null) : tick.basePrice,
          rawTickers: { sources: tick.priceSources, tickers: tick.rawTickers },
          messageSent: message,
          command: ctx.command,
        });

        consecutiveErrors = 0;
      } catch (error) {
        consecutiveErrors += 1;
        const detail = describeError(error);
        logger.error("Falha em tick da fila de cotacoes", {
          groupId: ctx.groupId,
          sequence: i,
          error: detail,
        });
        this.quoteLog.create({
          type: "error",
          channel: ctx.channel,
          groupId: ctx.groupId,
          merchantId: ctx.merchant.id,
          operation: label.operation,
          sourceAsset: label.sourceAsset,
          destinationAsset: label.destinationAsset,
          sequence: i,
          totalMessages: session.total,
          detail,
          command: ctx.command,
        });
        if (consecutiveErrors >= 3) {
          session.status = "failed";
          this.sessions.delete(key);
          this.history.push(this.snapshotOf(session));
          await this.outbound.send({
            channel: ctx.channel,
            groupId: ctx.groupId,
            text: MESSAGES.quoteFailed,
          });
          return;
        }
      }

      if (i < session.total) {
        await this.sleep(session, this.intervalMs);
      }
    }

    if (!session.cancelled) {
      session.status = "finished";
      this.sessions.delete(key);
      this.history.push(this.snapshotOf(session));
      this.quoteLog.create({
        type: "queue-finished",
        channel: ctx.channel,
        groupId: ctx.groupId,
        merchantId: ctx.merchant.id,
        totalMessages: session.total,
        command: ctx.command,
      });
      await this.outbound.send({
        channel: ctx.channel,
        groupId: ctx.groupId,
        text: MESSAGES.queueFinished(session.total),
      });
    }
  }
}

export type { SideQuote, TradeSide };
