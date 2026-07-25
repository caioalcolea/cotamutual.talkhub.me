/**
 * Motor de cotacao.
 *
 * Pares ATIVO/BRL sao cotados nos DOIS lados (compra e venda) na mesma
 * mensagem, cada lado com a sua fee do merchant. Cada tick da fila faz
 * requisicao NOVA a Mutual (precos variam a cada segundo) — a resposta ticker
 * ja traz bid e ask, entao um request cobre os dois lados.
 *
 * Blindagem: um lado so vira numero quando (a) existe fee EXATA cadastrada,
 * (b) o preco resultante e finito e positivo. Caso contrario o lado sai como
 * indisponivel ("sob consulta") — nunca um valor errado.
 */

import type { MutualClients } from "../mutual/client.js";
import { fetchTickerBRL, fetchUnitPriceBRL } from "../mutual/quote.js";
import type { MerchantCache, FeeCache } from "../cache/caches.js";
import type { GroupMatcher } from "./group-matcher.js";
import { resolveOperation, UnsupportedOperationError } from "./operations.js";
import { feeRate, selectFee } from "./fees.js";
import {
  calculateAssetPurchase,
  calculateBRLToAsset,
  calculateReceiveSide,
  type QuoteCalculation,
} from "./pricing.js";
import { MESSAGES } from "./format.js";
import type { MutualFee, MutualMerchant, MutualQuoteData, OperationType } from "../types.js";
import type { ParsedCommand, SizeKind, TradeSide } from "./parser.js";
import { logger } from "../logger.js";

/** Erro com mensagem pronta para o grupo. */
export class QuoteUserError extends Error {
  constructor(public readonly userMessage: string) {
    super(userMessage);
    this.name = "QuoteUserError";
  }
}

export interface SideFee {
  operation: OperationType;
  fee: MutualFee;
}

interface BaseContext {
  channel: string;
  groupId: string;
  merchant: MutualMerchant;
  command: string;
  amount: number;
  amountRaw: string;
}

/** Par ATIVO/BRL: dois lados (compra e venda). */
export interface PairContext extends BaseContext {
  mode: "pair";
  asset: string;
  sizeKind: SizeKind;
  buy: SideFee | null;
  sell: SideFee | null;
}

/** Cripto -> cripto: uma direcao so. */
export interface CrossContext extends BaseContext {
  mode: "cross";
  sourceAsset: string;
  destinationAsset: string;
  operation: OperationType;
  fee: MutualFee;
}

export type QuoteContext = PairContext | CrossContext;

/** Rotulos para log/painel, independentes do modo. */
export function contextSummary(ctx: QuoteContext): {
  operation: string;
  sourceAsset: string;
  destinationAsset: string;
} {
  if (ctx.mode === "cross") {
    return {
      operation: ctx.operation,
      sourceAsset: ctx.sourceAsset,
      destinationAsset: ctx.destinationAsset,
    };
  }
  return { operation: "pair", sourceAsset: ctx.asset, destinationAsset: "BRL" };
}

export interface SideQuote {
  side: TradeSide;
  operation: OperationType;
  feeId: string | null;
  /** Pontos percentuais, como cadastrado na Mutual. */
  feeFixed: number;
  feePercentage: number;
  /** Fracao aplicada: (fixa + percentual) / 100. */
  feeRate: number;
  /** Preco de mercado sem fee. */
  basePrice: number;
  /** Preco unitario final, com fee. */
  unitPrice: number;
  /** Quantidade do ativo envolvida. */
  quantity: number;
  /** Total em BRL. */
  totalBRL: number;
}

export type QuoteTick =
  | {
      mode: "pair";
      asset: string;
      sizeKind: SizeKind;
      amount: number;
      buy: SideQuote | null;
      sell: SideQuote | null;
      rawTickers: MutualQuoteData[];
      priceSources: string[];
      usdRateBRL: number | null;
    }
  | {
      mode: "cross";
      result: QuoteCalculation;
      basePrice: number;
      rawTickers: MutualQuoteData[];
      priceSources: string[];
      usdRateBRL: number | null;
    };

export class QuoteEngine {
  constructor(
    private readonly clients: MutualClients,
    private readonly merchantCache: MerchantCache,
    private readonly feeCache: FeeCache,
    private readonly referenceBrlAmount: number,
    private readonly groupMatcher: GroupMatcher,
    private readonly tickerFallback: boolean = true,
    /** Bloco em dolar na resposta (desligado nesta fase; codigo preservado). */
    private readonly showUsd: boolean = false,
  ) {}

  /**
   * Resolve merchant do grupo, monta os lados do par (ou a conversao) e
   * localiza as fees EXATAS. Sem nenhuma fee aplicavel, a cotacao e interrompida.
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

    const fees = await this.feeCache.getByMerchantId(merchant.id);
    const base = {
      channel,
      groupId,
      merchant,
      command: parsed.raw,
      amount: parsed.amount,
      amountRaw: parsed.amountRaw,
    };

    const source = parsed.sourceAsset;
    const destination = parsed.destinationAsset;

    // ---------------- Par ATIVO/BRL: cotacao dos dois lados ----------------
    if (source === "BRL" || destination === "BRL") {
      const asset = source === "BRL" ? destination : source;
      // Tamanho em BRL somente quando o usuario informou o orcamento (ex:
      // "/COTAR 5000 BRL USDT"); caso contrario e quantidade do ativo.
      const sizeKind: SizeKind =
        source === "BRL" && parsed.amountKind === "source" ? "brl" : "asset";

      let buy: SideFee | null = null;
      let sell: SideFee | null = null;
      try {
        const buyOperation = resolveOperation("BRL", asset);
        const buyFee = selectFee(fees, buyOperation, "BRL", asset);
        if (buyFee) buy = { operation: buyOperation, fee: buyFee };
      } catch (error) {
        if (!(error instanceof UnsupportedOperationError)) throw error;
      }
      try {
        const sellOperation = resolveOperation(asset, "BRL");
        const sellFee = selectFee(fees, sellOperation, asset, "BRL");
        if (sellFee) sell = { operation: sellOperation, fee: sellFee };
      } catch (error) {
        if (!(error instanceof UnsupportedOperationError)) throw error;
      }

      // Regra obrigatoria: sem nenhuma fee exata, nao ha cotacao.
      if (!buy && !sell) {
        throw new QuoteUserError(MESSAGES.feeNotConfigured);
      }

      return { ...base, mode: "pair", asset, sizeKind, buy, sell };
    }

    // ---------------- Cripto -> cripto: direcao unica ----------------
    let operation: OperationType;
    try {
      operation = resolveOperation(source, destination);
    } catch (error) {
      if (error instanceof UnsupportedOperationError) {
        throw new QuoteUserError(MESSAGES.unsupportedOperation(source, destination));
      }
      throw error;
    }

    const fee = selectFee(fees, operation, source, destination);
    if (!fee) {
      throw new QuoteUserError(MESSAGES.feeNotConfigured);
    }

    return {
      ...base,
      mode: "cross",
      sourceAsset: source,
      destinationAsset: destination,
      operation,
      fee,
    };
  }

  /** Executa UMA cotacao completa (requisicao propria a Mutual + fees aplicadas). */
  async tick(ctx: QuoteContext): Promise<QuoteTick> {
    return ctx.mode === "pair" ? this.tickPair(ctx) : this.tickCross(ctx);
  }

  private async tickPair(ctx: PairContext): Promise<QuoteTick> {
    const rawTickers: MutualQuoteData[] = [];
    const priceSources: string[] = [];

    // Um request cobre os dois lados (o ticker traz bid e ask).
    const ticker = await fetchTickerBRL(
      this.clients,
      ctx.asset,
      ctx.sizeKind === "brl" ? ctx.amount : this.referenceBrlAmount,
      this.tickerFallback,
    );
    rawTickers.push(ticker.rawTicker);
    priceSources.push(ticker.source);

    const buy = this.buildSide(ctx, "buy", ctx.buy, ticker.askBRL);
    const sell = this.buildSide(ctx, "sell", ctx.sell, ticker.bidBRL);

    if (!buy && !sell) {
      throw new Error(
        `Nenhum lado calculavel para ${ctx.asset}/BRL (ask=${ticker.askBRL} bid=${ticker.bidBRL})`,
      );
    }

    const usdRateBRL = await this.fetchUsdRate(ctx.asset, rawTickers, priceSources);
    return {
      mode: "pair",
      asset: ctx.asset,
      sizeKind: ctx.sizeKind,
      amount: ctx.amount,
      buy,
      sell,
      rawTickers,
      priceSources,
      usdRateBRL,
    };
  }

  /** Aplica a fee do lado e valida o resultado; retorna null se nao for confiavel. */
  private buildSide(
    ctx: PairContext,
    side: TradeSide,
    sideFee: SideFee | null,
    basePrice: number,
  ): SideQuote | null {
    if (!sideFee) return null;
    if (!Number.isFinite(basePrice) || basePrice <= 0) return null;

    const rate = feeRate(sideFee.fee);
    // Compra: cliente paga mais. Venda: cliente recebe menos.
    const unitPrice = side === "buy" ? basePrice * (1 + rate) : basePrice * (1 - rate);
    if (!Number.isFinite(unitPrice) || unitPrice <= 0) {
      logger.warn("Lado descartado por preço inválido após fee", {
        asset: ctx.asset,
        side,
        basePrice,
        rate,
      });
      return null;
    }

    const quantity = ctx.sizeKind === "asset" ? ctx.amount : ctx.amount / unitPrice;
    const totalBRL = ctx.sizeKind === "asset" ? ctx.amount * unitPrice : ctx.amount;
    if (!Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(totalBRL) || totalBRL <= 0) {
      return null;
    }

    return {
      side,
      operation: sideFee.operation,
      feeId: sideFee.fee.id ?? null,
      feeFixed: Number(sideFee.fee.feeFixed || 0),
      feePercentage: Number(sideFee.fee.feePercentage || 0),
      feeRate: rate,
      basePrice,
      unitPrice,
      quantity,
      totalBRL,
    };
  }

  private async tickCross(ctx: CrossContext): Promise<QuoteTick> {
    const rawTickers: MutualQuoteData[] = [];
    const priceSources: string[] = [];

    // Taxa cruzada via BRL: vende a origem (bid) e compra o destino (ask).
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

    const basePrice = source.unitPriceBRL / dest.unitPriceBRL;
    const result = calculateReceiveSide({
      quantity: ctx.amount,
      baseUnitPrice: basePrice,
      fee: ctx.fee,
    });

    return {
      mode: "cross",
      result,
      basePrice,
      rawTickers,
      priceSources,
      usdRateBRL: null,
    };
  }

  /**
   * Cotacao do dolar (USD = USDC) para o bloco em dolar da resposta.
   * Desligada nesta fase (showUsd=false) — o codigo fica pronto para o futuro.
   * Falha aqui NUNCA derruba a cotacao principal.
   */
  private async fetchUsdRate(
    asset: string,
    rawTickers: MutualQuoteData[],
    priceSources: string[],
  ): Promise<number | null> {
    if (!this.showUsd) return null;
    try {
      if (asset === "USDC") return null; // o proprio par ja e o dolar
      const usd = await fetchUnitPriceBRL(
        this.clients,
        "USDC",
        this.referenceBrlAmount,
        "buy",
        this.tickerFallback,
      );
      rawTickers.push(usd.rawTicker);
      priceSources.push(`usd:${usd.source}`);
      return usd.unitPriceBRL;
    } catch {
      return null;
    }
  }
}

/** Helpers de calculo reexportados para testes de regressao. */
export { calculateAssetPurchase, calculateBRLToAsset, calculateReceiveSide };
