/**
 * Aplicacao da fee na direcao financeira correta.
 *
 * As fees da Mutual vem em PONTOS PERCENTUAIS: feeFixed e feePercentage sao
 * ambas porcentagens que se SOMAM (ex: fixa 0.1 + percentual 0.65 = 0,75%).
 *   taxa = (feeFixed + feePercentage) / 100
 *
 * Compra/conversao: cliente paga mais ou recebe menos.
 * Venda:            cliente recebe o valor bruto menos a fee.
 */

import { calculateFee, feeRate } from "./fees.js";
import type { MutualFee } from "../types.js";

export interface QuoteResultBase {
  kind: "asset-purchase" | "brl-budget" | "receive-side";
  /** Pontos percentuais, como cadastrado na Mutual. */
  feePercentage: number;
  /** Pontos percentuais, como cadastrado na Mutual. */
  feeFixed: number;
  feePercentageValue: number;
  feeFixedValue: number;
  feeTotalValue: number;
  finalUnitPrice: number;
}

/**
 * Usuario informou a QUANTIDADE do ativo desejado (ex: /REF 25K USDT).
 * finalTotal = baseTotal × (1 + taxa) — cliente paga mais, em BRL.
 */
export interface AssetPurchaseResult extends QuoteResultBase {
  kind: "asset-purchase";
  quantity: number;
  baseUnitPrice: number;
  baseTotal: number;
  finalTotal: number;
}

export function calculateAssetPurchase(params: {
  quantity: number;
  baseUnitPrice: number;
  fee: MutualFee;
}): AssetPurchaseResult {
  const { quantity, baseUnitPrice, fee } = params;
  const baseTotal = quantity * baseUnitPrice;
  const calculatedFee = calculateFee(baseTotal, fee);
  const finalTotal = baseTotal + calculatedFee.feeTotalValue;

  return {
    kind: "asset-purchase",
    quantity,
    baseUnitPrice,
    baseTotal,
    feePercentage: calculatedFee.feePercentage,
    feeFixed: calculatedFee.feeFixed,
    feePercentageValue: calculatedFee.feePercentageValue,
    feeFixedValue: calculatedFee.feeFixedValue,
    feeTotalValue: calculatedFee.feeTotalValue,
    finalTotal,
    finalUnitPrice: finalTotal / quantity,
  };
}

/**
 * Usuario informou o ORCAMENTO em BRL (ex: /COTAR 5000 BRL USDT).
 * A fee sai de dentro do orcamento:
 *   baseAvailable = amountBRL / (1 + taxa)
 */
export interface BrlBudgetResult extends QuoteResultBase {
  kind: "brl-budget";
  amountBRL: number;
  baseUnitPrice: number;
  baseAvailable: number;
  quantity: number;
}

export function calculateBRLToAsset(params: {
  amountBRL: number;
  baseUnitPrice: number;
  fee: MutualFee;
}): BrlBudgetResult {
  const { amountBRL, baseUnitPrice, fee } = params;
  const rate = feeRate(fee);

  const baseAvailable = amountBRL / (1 + rate);
  if (baseAvailable <= 0) {
    throw new Error("Valor insuficiente após aplicação da fee");
  }

  const feePercentageValue = baseAvailable * (Number(fee.feePercentage || 0) / 100);
  const feeFixedValue = baseAvailable * (Number(fee.feeFixed || 0) / 100);
  const feeTotalValue = feePercentageValue + feeFixedValue;
  const quantity = baseAvailable / baseUnitPrice;

  return {
    kind: "brl-budget",
    amountBRL,
    baseUnitPrice,
    baseAvailable,
    feePercentage: Number(fee.feePercentage || 0),
    feeFixed: Number(fee.feeFixed || 0),
    feePercentageValue,
    feeFixedValue,
    feeTotalValue,
    quantity,
    finalUnitPrice: amountBRL / quantity,
  };
}

/**
 * Usuario informou a quantidade do ativo de ORIGEM e recebe no destino
 * (venda cripto -> BRL, conversao USDC -> BRL ou cripto -> cripto).
 * A fee e descontada do valor recebido:
 *   net = gross × (1 − taxa)
 */
export interface ReceiveSideResult extends QuoteResultBase {
  kind: "receive-side";
  quantity: number;
  baseUnitPrice: number;
  grossAmount: number;
  netAmount: number;
}

export function calculateReceiveSide(params: {
  quantity: number;
  baseUnitPrice: number;
  fee: MutualFee;
}): ReceiveSideResult {
  const { quantity, baseUnitPrice, fee } = params;
  const grossAmount = quantity * baseUnitPrice;
  const calculatedFee = calculateFee(grossAmount, fee);
  const netAmount = grossAmount - calculatedFee.feeTotalValue;

  if (netAmount <= 0) {
    throw new Error("Valor líquido inválido após aplicação da fee");
  }

  return {
    kind: "receive-side",
    quantity,
    baseUnitPrice,
    grossAmount,
    feePercentage: calculatedFee.feePercentage,
    feeFixed: calculatedFee.feeFixed,
    feePercentageValue: calculatedFee.feePercentageValue,
    feeFixedValue: calculatedFee.feeFixedValue,
    feeTotalValue: calculatedFee.feeTotalValue,
    netAmount,
    finalUnitPrice: netAmount / quantity,
  };
}

export type QuoteCalculation = AssetPurchaseResult | BrlBudgetResult | ReceiveSideResult;
