/**
 * Registro de operacoes e respostas (secao 14 — detalhes internos).
 *
 * O grupo ve somente a cotacao final; o painel e o log guardam TODOS os
 * detalhes: merchant, operacao, fees, preco-base, preco final, ticker cru.
 *
 * Persistencia: JSONL (DATA_DIR/quote-log.jsonl) + buffer em memoria para o painel.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { logger } from "../logger.js";

export interface QuoteLogEntry {
  ts: string;
  type:
    | "quote-tick"
    | "quote-manual"
    | "trade-manual"
    | "trade-orders-disabled"
    | "trade-need-quote"
    | "trade-side-unavailable"
    | "trade-mismatch"
    | "queue-finished"
    | "error";
  channel: string;
  groupId: string;
  merchantId?: string | null;
  merchantName?: string | null;
  /** ID da transacao gerado no /COMPRAR (registro da operacao manual). */
  transactionId?: string | null;
  operation?: string | null;
  sourceAsset?: string | null;
  destinationAsset?: string | null;
  feeId?: string | null;
  feeFixed?: number | null;
  feePercentage?: number | null;
  basePrice?: number | null;
  sequence?: number | null;
  totalMessages?: number | null;
  result?: unknown;
  rawTickers?: unknown;
  messageSent?: string | null;
  detail?: string | null;
  command?: string | null;
}

const MEMORY_LIMIT = 500;

export class QuoteLogRepository {
  private readonly filePath: string;
  private readonly memory: QuoteLogEntry[] = [];

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.filePath = join(dataDir, "quote-log.jsonl");
  }

  create(entry: Omit<QuoteLogEntry, "ts">): QuoteLogEntry {
    const full: QuoteLogEntry = { ts: new Date().toISOString(), ...entry };
    this.memory.push(full);
    if (this.memory.length > MEMORY_LIMIT) {
      this.memory.splice(0, this.memory.length - MEMORY_LIMIT);
    }
    try {
      appendFileSync(this.filePath, `${JSON.stringify(full)}\n`, "utf8");
    } catch (error) {
      logger.error("Falha ao gravar quote-log", { error: String(error) });
    }
    return full;
  }

  recent(limit = 100): QuoteLogEntry[] {
    return this.memory.slice(-limit).reverse();
  }
}
