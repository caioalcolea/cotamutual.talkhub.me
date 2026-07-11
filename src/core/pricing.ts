/**
 * Aplicacao da fee na direcao financeira correta (secoes 11 e 12).
 *
 * Compra/conversao: cliente paga mais ou recebe menos.
 * Venda:            cliente recebe o valor bruto menos a fee.
 */

import { calculateFee } from "./fees.js";
import type { MutualFee } from "../types.js";

export interface QuoteResultBase {
  kind: "asset-purchase" | "brl-budget" | "receive-side";
  feePercentage: number;
  feeFixed: number;
  feePercentageValue: number;
  feeTotalValue: number;
  finalUnitPrice: number;
}

/**
 * Usuario informou a QUANTIDADE do ativo desejado (ex: /REF 25K USDT).
 * finalTotal = baseTotal + fee (cliente paga mais, em BRL).
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
    feeTotalValue: calculatedFee.feeTotalValue,
    finalTotal,
    finalUnitPrice: finalTotal / quantity,
  };
}

/**
 * Usuario informou o ORCAMENTO em BRL (ex: /COTAR 5000 BRL USDT).
 * Parte do valor corresponde a taxa:
 *   baseAvailable = (amountBRL - feeFixed) / (1 + feePercentage)
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
  const feePercentage = Number(fee.feePercentage || 0);
  const feeFixed = Number(fee.feeFixed || 0);

  const baseAvailable = (amountBRL - feeFixed) / (1 + feePercentage);
  if (baseAvailable <= 0) {
    throw new Error("Valor insuficiente após aplicação da fee");
  }

  const feePercentageValue = baseAvailable * feePercentage;
  const feeTotalValue = feePercentageValue + feeFixed;
  const quantity = baseAvailable / baseUnitPrice;

  return {
    kind: "brl-budget",
    amountBRL,
    baseUnitPrice,
    baseAvailable,
    feePercentage,
    feeFixed,
    feePercentageValue,
    feeTotalValue,
    quantity,
    finalUnitPrice: amountBRL / quantity,
  };
}

/**
 * Usuario informou a quantidade do ativo de ORIGEM e recebe no destino
 * (venda cripto -> BRL, conversao USDC -> BRL ou cripto -> cripto).
 * A fee e somada internamente e descontada do valor recebido:
 *   net = gross - fee
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
    feeTotalValue: calculatedFee.feeTotalValue,
    netAmount,
    finalUnitPrice: netAmount / quantity,
  };
}

export type QuoteCalculation = AssetPurchaseResult | BrlBudgetResult | ReceiveSideResult;
