/**
 * Endpoints de recursos (sempre em PRODUCAO, conforme validacao do projeto):
 *   GET /api/v2/resource/merchants
 *   GET /api/v2/resource/fees/merchant/{merchantId}
 */

import type { MutualClients } from "./client.js";
import type { MutualFeesResponse, MutualMerchantsResponse } from "../types.js";

export async function fetchMerchants(
  clients: MutualClients,
  page: number,
  limit: number,
): Promise<MutualMerchantsResponse> {
  const response = await clients.prod.get<MutualMerchantsResponse>(
    "/api/v2/resource/merchants",
    { params: { page, limit } },
  );
  return response.data;
}

export async function fetchMerchantFees(
  clients: MutualClients,
  merchantId: string,
): Promise<MutualFeesResponse> {
  const response = await clients.prod.get<MutualFeesResponse>(
    `/api/v2/resource/fees/merchant/${encodeURIComponent(merchantId)}`,
  );
  return response.data;
}
