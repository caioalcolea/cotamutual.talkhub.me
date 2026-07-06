/**
 * Criacao de ordem de compra cripto:
 *   POST /api/v2/crypto/orders   (cliente "crypto" -> hml ou prod via MUTUAL_CRYPTO_ENV)
 *
 * O payload reproduz EXATAMENTE a estrutura validada no projeto. Campos como
 * `qty`, `cost`, `limitPrice`, `stopPrice` e `orderType` seguem o exemplo
 * funcional; ajuste-os conforme a Mutual confirmar a semantica definitiva.
 */

import type { MutualClients } from "./client.js";
import type { MutualOrderResponse } from "../types.js";

export interface OrderInput {
  walletId: string;
  externalId: string;
  amount: number;
  sourceAsset: string;
  destinationAsset: string;
  symbol: string;
  cost: number;
  qty: string;
}

export async function createCryptoOrder(
  clients: MutualClients,
  input: OrderInput,
): Promise<MutualOrderResponse> {
  const payload = {
    walletId: input.walletId,
    type: "BUY",
    externalId: input.externalId,
    amount: input.amount,
    source: { asset: input.sourceAsset },
    destination: { asset: input.destinationAsset },
    symbol: input.symbol,
    async: true,
    cost: input.cost,
    limitPrice: 0,
    qty: input.qty,
    side: "buy",
    stopPrice: 0,
    orderType: "market",
  };

  const response = await clients.crypto.post<MutualOrderResponse>(
    "/api/v2/crypto/orders",
    payload,
  );
  return response.data;
}
