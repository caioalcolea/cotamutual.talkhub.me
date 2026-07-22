/**
 * Selecao e calculo de fees (secoes 9, 10 e 15 do descritivo).
 *
 * Regra obrigatoria: a fee e localizada pela combinacao EXATA
 * operation + sourceAsset + destinationAsset. Nunca usar fee de outro par
 * como fallback silencioso — sem fee exata, a cotacao e interrompida.
 */

import { normalizeAsset } from "./assets.js";
import type { MutualFee } from "../types.js";

export function selectFee(
  fees: MutualFee[],
  operation: string,
  sourceAsset: string,
  destinationAsset: string,
): MutualFee | null {
  const op = String(operation).toLowerCase();
  const source = normalizeAsset(sourceAsset);
  const destination = normalizeAsset(destinationAsset);

  return (
    fees.find((fee) => {
      return (
        String(fee.operation).toLowerCase() === op &&
        normalizeAsset(fee.sourceAsset) === source &&
        normalizeAsset(fee.destinationAsset) === destination
      );
    }) || null
  );
}

export interface CalculatedFee {
  baseValue: number;
  /** Como cadastrado na Mutual, em PONTOS PERCENTUAIS (0.65 = 0,65%). */
  feePercentage: number;
  /** Como cadastrado na Mutual, TAMBEM em pontos percentuais. */
  feeFixed: number;
  /** Taxa total como fracao: (feeFixed + feePercentage) / 100. */
  feeRate: number;
  feePercentageValue: number;
  feeFixedValue: number;
  feeTotalValue: number;
}

/** Taxa total (fracao) de uma fee: fixa + percentual, ambas em pontos percentuais. */
export function feeRate(fee: MutualFee): number {
  return (Number(fee.feeFixed || 0) + Number(fee.feePercentage || 0)) / 100;
}

/**
 * As fees da Mutual vem em PONTOS PERCENTUAIS — feeFixed e feePercentage sao
 * ambas porcentagens que se SOMAM (ex: fixa 0.1 + percentual 0.65 = 0,75%).
 *
 *   feeTotalValue = baseValue × (feeFixed + feePercentage) / 100
 */
export function calculateFee(baseValue: number, fee: MutualFee): CalculatedFee {
  const value = Number(baseValue);
  const feePercentage = Number(fee.feePercentage || 0);
  const feeFixed = Number(fee.feeFixed || 0);

  if (!Number.isFinite(value) || value <= 0) {
    throw new Error("Valor-base inválido");
  }

  const feePercentageValue = value * (feePercentage / 100);
  const feeFixedValue = value * (feeFixed / 100);
  const feeTotalValue = feePercentageValue + feeFixedValue;

  return {
    baseValue: value,
    feePercentage,
    feeFixed,
    feeRate: (feePercentage + feeFixed) / 100,
    feePercentageValue,
    feeFixedValue,
    feeTotalValue,
  };
}

/** Matriz minima de fees exigida por merchant (secao 15). */
export const REQUIRED_FEES: Array<[string, string, string]> = [
  ["buy", "BRL", "USDT"],
  ["buy", "BRL", "BTC"],
  ["conversion", "BRL", "USDC"],
  ["conversion", "USDC", "BRL"],
  ["conversion", "USDT", "BTC"],
  ["conversion", "BTC", "USDT"],
  ["sell", "BTC", "BRL"],
  ["sell", "USDT", "BRL"],
];

export interface FeeAuditEntry {
  operation: string;
  sourceAsset: string;
  destinationAsset: string;
  configured: boolean;
  feeFixed: number | null;
  feePercentage: number | null;
}

export function auditMerchantFees(fees: MutualFee[]): FeeAuditEntry[] {
  return REQUIRED_FEES.map(([operation, sourceAsset, destinationAsset]) => {
    const fee = selectFee(fees, operation, sourceAsset, destinationAsset);
    return {
      operation,
      sourceAsset,
      destinationAsset,
      configured: Boolean(fee),
      feeFixed: fee?.feeFixed ?? null,
      feePercentage: fee?.feePercentage ?? null,
    };
  });
}
