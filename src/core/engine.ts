/**
 * Motor de cotacao: prepara o contexto (merchant + operacao + fee) e executa
 * cada "tick" da fila com requisicao NOVA a Mutual (precos variam a cada
 * segundo — nunca reutilizar ticker entre mensagens).
 */

import type { MutualClients } from "../mutual/client.js";
import { fetchUnitPriceBRL } from "../mutual/quote.js";
import type { MerchantCache, FeeCache } from "../cache/caches.js";
import type { GroupMatcher } from "./group-matcher.js";
import { resolveOperation, UnsupportedOperationError } from "./operations.js";
import { selectFee } from "./fees.js";
import {
  calculateAssetPurchase,
  calculateBRLToAsset,
  calculateReceiveSide,
  type QuoteCalculation,
} from "./pricing.js";
import { MESSAGES } from "./format.js";
import type { MutualFee, MutualMerchant, MutualQuoteData, OperationType } from "../types.js";
import type { ParsedCommand } from "./parser.js";

/** Erro com mensagem pronta para o grupo. */
export class QuoteUserError extends Error {
  constructor(public readonly userMessage: string) {
    super(userMessage);
    this.name = "QuoteUserError";
  }
}

export interface QuoteContext {
  channel: string;
  groupId: string;
  merchant: MutualMerchant;
  operation: OperationType;
  sourceAsset: string;
  destinationAsset: string;
  amount: number;
  amountKind: "source" | "destination";
  fee: MutualFee;
  command: string;
}

export interface QuoteTick {
  result: QuoteCalculation;
  basePrice: number;
  rawTickers: MutualQuoteData[];
  /** Fonte do preco-base por perna: ticker | ticker-fallback | quote. */
  priceSources: string[];
}

export class QuoteEngine {
  constructor(
    private readonly clients: MutualClients,
    private readonly merchantCache: MerchantCache,
    private readonly feeCache: FeeCache,
    private readonly referenceBrlAmount: number,
    private readonly groupMatcher: GroupMatcher,
    private readonly tickerFallback: boolean = true,
  ) {}

  /**
   * Resolve merchant do grupo, classifica a operacao e localiza a fee EXATA.
   * Qualquer falha vira QuoteUserError com a mensagem padrao do descritivo.
   */
  async prepareContext(params: {
    channel: string;
    groupId: string;
    parsed: Extract<ParsedCommand, { kind: "quote" }>;
  }): Promise<QuoteContext> {
    const { channel, groupId, parsed } = params;

    const merchants = await this.merchantCache.getAll();
    const merchant = await this.groupMatcher.findMerchant(merchants, channel, groupId);
    if (!merchant) {
      throw new QuoteUserError(MESSAGES.groupNotLinked);
    }

    let operation: OperationType;
    try {
      operation = resolveOperation(parsed.sourceAsset, parsed.destinationAsset);
    } catch (error) {
      if (error instanceof UnsupportedOperationError) {
        throw new QuoteUserError(
          MESSAGES.unsupportedOperation(parsed.sourceAsset, parsed.destinationAsset),
        );
      }
      throw error;
    }

    const fees = await this.feeCache.getByMerchantId(merchant.id);
    const fee = selectFee(fees, operation, parsed.sourceAsset, parsed.destinationAsset);
    if (!fee) {
      // Regra obrigatoria: sem fee exata, a cotacao e interrompida.
      throw new QuoteUserError(MESSAGES.feeNotConfigured);
    }

    return {
      channel,
      groupId,
      merchant,
      operation,
      sourceAsset: parsed.sourceAsset,
      destinationAsset: parsed.destinationAsset,
      amount: parsed.amount,
      amountKind: parsed.amountKind,
      fee,
      command: parsed.raw,
    };
  }

  /**
   * Executa UMA cotacao completa (requisicao propria a Mutual + fee aplicada).
   * Chamada uma vez por mensagem da fila.
   */
  async tick(ctx: QuoteContext): Promise<QuoteTick> {
    const rawTickers: MutualQuoteData[] = [];
    const priceSources: string[] = [];

    // Preco-base (BRL por unidade) da perna cripto de cada lado.
    let basePrice: number;

    if (ctx.sourceAsset === "BRL") {
      // Cliente COMPRA o ativo de destino -> lado "buy" (ask no formato ticker).
      const dest = await fetchUnitPriceBRL(
        this.clients,
        ctx.destinationAsset,
        ctx.amountKind === "source" ? ctx.amount : this.referenceBrlAmount,
        "buy",
        this.tickerFallback,
      );
      rawTickers.push(dest.rawTicker);
      priceSources.push(dest.source);
      basePrice = dest.unitPriceBRL;
    } else if (ctx.destinationAsset === "BRL") {
      // Cliente VENDE o ativo de origem -> lado "sell" (bid no formato ticker).
      const source = await fetchUnitPriceBRL(
        this.clients,
        ctx.sourceAsset,
        this.referenceBrlAmount,
        "sell",
        this.tickerFallback,
      );
      rawTickers.push(source.rawTicker);
      priceSources.push(source.source);
      basePrice = source.unitPriceBRL;
    } else {
      // Cripto -> cripto: taxa cruzada via BRL (duas requisicoes separadas):
      // vende a origem (bid) e compra o destino (ask).
      const source = await fetchUnitPriceBRL(
        this.clients,
        ctx.sourceAsset,
        this.referenceBrlAmount,
        "sell",
        this.tickerFallback,
      );
      const dest = await fetchUnitPriceBRL(
        this.clients,
        ctx.destinationAsset,
        this.referenceBrlAmount,
        "buy",
        this.tickerFallback,
      );
      rawTickers.push(source.rawTicker, dest.rawTicker);
      priceSources.push(source.source, dest.source);
      basePrice = source.unitPriceBRL / dest.unitPriceBRL;
    }

    let result: QuoteCalculation;
    if (ctx.sourceAsset === "BRL" && ctx.amountKind === "source") {
      // Orcamento em BRL: fee descontada do valor disponivel.
      result = calculateBRLToAsset({
        amountBRL: ctx.amount,
        baseUnitPrice: basePrice,
        fee: ctx.fee,
      });
    } else if (ctx.sourceAsset === "BRL") {
      // Quantidade do ativo de destino: fee aumenta o total pago.
      result = calculateAssetPurchase({
        quantity: ctx.amount,
        baseUnitPrice: basePrice,
        fee: ctx.fee,
      });
    } else {
      // Quantidade do ativo de origem: fee descontada do valor recebido
      // (venda para BRL e conversoes com origem cripto/USDC).
      result = calculateReceiveSide({
        quantity: ctx.amount,
        baseUnitPrice: basePrice,
        fee: ctx.fee,
      });
    }

    return { result, basePrice, rawTickers, priceSources };
  }
}
