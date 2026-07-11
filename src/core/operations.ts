/**
 * Classificacao da operacao (tabela definitiva — secao 7 do descritivo).
 *
 * | Origem | Destino         | Operacao     |
 * | ------ | --------------- | ------------ |
 * | BRL    | BTC/ETH/USDT    | buy          |
 * | BRL    | USDC como dolar | conversion   |
 * | USDC   | BRL             | conversion   |
 * | Cripto | Cripto          | conversion   |
 * | Cripto | BRL             | sell         |
 */

import { CRYPTO_ASSETS, normalizeAsset } from "./assets.js";
import type { OperationType } from "../types.js";

export class UnsupportedOperationError extends Error {
  constructor(source: string, destination: string) {
    super(`Operação não suportada: ${source} -> ${destination}`);
    this.name = "UnsupportedOperationError";
  }
}

export function resolveOperation(sourceAsset: string, destinationAsset: string): OperationType {
  const source = normalizeAsset(sourceAsset);
  const destination = normalizeAsset(destinationAsset);

  // Regra especifica do projeto: BRL -> USDC representa cambio BRL para dolar.
  if (source === "BRL" && destination === "USDC") {
    return "conversion";
  }

  // Moeda fiduciaria para cripto.
  if (source === "BRL" && CRYPTO_ASSETS.has(destination)) {
    return "buy";
  }

  // Dolar tokenizado para BRL.
  if (source === "USDC" && destination === "BRL") {
    return "conversion";
  }

  // Cripto para moeda fiduciaria.
  if (CRYPTO_ASSETS.has(source) && destination === "BRL") {
    return "sell";
  }

  // Cripto para cripto.
  if (CRYPTO_ASSETS.has(source) && CRYPTO_ASSETS.has(destination)) {
    return "conversion";
  }

  throw new UnsupportedOperationError(source, destination);
}
