/**
 * Fila de cotacoes: toda cotacao envia N mensagens (padrao 10), cada uma com
 * REQUISICAO PROPRIA a Mutual (os precos variam de segundo a segundo).
 *
 * A fila e interrompida imediatamente por um comando de compra (/COMPRAR).
 * Uma nova cotacao no mesmo grupo substitui a fila em andamento.
 */

import { randomUUID } from "node:crypto";
import type { QuoteEngine, QuoteContext } from "../core/engine.js";
import { formatQuoteMessage, formatQuoteSummary, MESSAGES } from "../core/format.js";
import type { OutboundSender } from "../channels/outbound.js";
import type { QuoteLogRepository } from "../state/quote-log.js";
import { describeError } from "../util/errors.js";
import { logger } from "../logger.js";

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

function sessionKey(channel: string, groupId: string): string {
  return `${String(channel).toLowerCase()}|${String(groupId).trim()}`;
}

export class QuoteQueue {
  private readonly sessions = new Map<string, QueueSession>();
  private readonly history: QueueSessionSnapshot[] = [];

  constructor(
    private readonly engine: QuoteEngine,
    private readonly outbound: OutboundSender,
    private readonly quoteLog: QuoteLogRepository,
    private readonly totalMessages: number,
    private readonly intervalMs: number,
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

  /**
   * Interrompe a fila do grupo por um comando de compra.
   * Retorna o resumo da ultima cotacao enviada (se houver).
   */
  interruptForBuy(channel: string, groupId: string): string | null {
    const key = sessionKey(channel, groupId);
    const session = this.sessions.get(key);
    const summary = session?.lastQuoteSummary ?? null;
    this.cancel(key, "interrupted");
    return summary;
  }

  /** Snapshot das filas ativas + historico recente (painel). */
  snapshot(): { active: QueueSessionSnapshot[]; recent: QueueSessionSnapshot[] } {
    return {
      active: [...this.sessions.values()].map((s) => this.snapshotOf(s)),
      recent: this.history.slice(-20).reverse(),
    };
  }

  private snapshotOf(session: QueueSession): QueueSessionSnapshot {
    return {
      id: session.id,
      channel: session.context.channel,
      groupId: session.context.groupId,
      merchantId: session.context.merchant.id,
      merchantName: session.context.merchant.legalName ?? null,
      operation: session.context.operation,
      sourceAsset: session.context.sourceAsset,
      destinationAsset: session.context.destinationAsset,
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
      // Cancelamento acorda o sleep imediatamente (interrupcao pelo /COMPRAR).
      session.wake = () => {
        clearTimeout(timer);
        session.wake = null;
        resolve();
      };
    });
  }

  private async run(key: string, session: QueueSession): Promise<void> {
    const ctx = session.context;
    let consecutiveErrors = 0;

    for (let i = 1; i <= session.total; i += 1) {
      if (session.cancelled) return;

      try {
        // Requisicao NOVA a Mutual a cada mensagem da fila.
        const tick = await this.engine.tick(ctx);
        if (session.cancelled) return;

        session.sequence = i;
        const message = formatQuoteMessage({
          sourceAsset: ctx.sourceAsset,
          destinationAsset: ctx.destinationAsset,
          sequence: i,
          total: session.total,
          result: tick.result,
        });
        session.lastQuoteSummary = formatQuoteSummary({
          sourceAsset: ctx.sourceAsset,
          destinationAsset: ctx.destinationAsset,
          result: tick.result,
        });

        await this.outbound.send({ channel: ctx.channel, groupId: ctx.groupId, text: message });

        // Painel/log com TODOS os detalhes internos.
        this.quoteLog.create({
          type: "quote-tick",
          channel: ctx.channel,
          groupId: ctx.groupId,
          merchantId: ctx.merchant.id,
          merchantName: ctx.merchant.legalName ?? null,
          operation: ctx.operation,
          sourceAsset: ctx.sourceAsset,
          destinationAsset: ctx.destinationAsset,
          feeId: ctx.fee.id ?? null,
          feeFixed: ctx.fee.feeFixed ?? null,
          feePercentage: ctx.fee.feePercentage ?? null,
          basePrice: tick.basePrice,
          sequence: i,
          totalMessages: session.total,
          result: tick.result,
          rawTickers: tick.rawTickers,
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
          operation: ctx.operation,
          sourceAsset: ctx.sourceAsset,
          destinationAsset: ctx.destinationAsset,
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
