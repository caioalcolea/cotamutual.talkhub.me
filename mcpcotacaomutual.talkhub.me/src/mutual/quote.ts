/**
 * Cotacao de criptoativo:
 *   GET /api/v2/crypto/quote   (cliente "crypto" -> hml ou prod via MUTUAL_CRYPTO_ENV)
 *
 * Observacao: a rota e GET com query params (no curl validado usa-se `curl -G`
 * com --data-urlencode). Axios envia os mesmos campos via `params`.
 */

import type { MutualClients } from "./client.js";
import type { MutualQuoteResponse } from "../types.js";

export interface QuoteInput {
  symbol: string;
  amount: number;
  sourceAsset: string;
  targetAsset: string;
  targetNetwork: string;
}

export async function fetchCryptoQuote(
  clients: MutualClients,
  input: QuoteInput,
): Promise<MutualQuoteResponse> {
  const response = await clients.crypto.get<MutualQuoteResponse>(
    "/api/v2/crypto/quote",
    {
      params: {
        symbol: input.symbol,
        amount: input.amount,
        sourceAsset: input.sourceAsset,
        targetAsset: input.targetAsset,
        targetNetwork: input.targetNetwork,
      },
    },
  );
  return response.data;
}
