/**
 * Tipagens das respostas da Mutual API v2 (apenas os campos usados).
 */

export interface MutualPagination {
  page: number;
  limit: number;
  totalItems: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
}

export interface MutualLinkGroup {
  id: string;
  channel: string;
  groupId: string;
  name?: string;
  active: boolean;
}

export interface MutualMerchant {
  id: string;
  organizationId?: string;
  legalName?: string;
  legalDocument?: string;
  status?: string;
  email?: string;
  linkGroups?: MutualLinkGroup[];
  createdAt?: string;
  updatedAt?: string;
}

export interface MutualMerchantsResponse {
  error: boolean;
  message: string;
  data: MutualMerchant[];
  pagination?: MutualPagination;
}

export interface MutualFee {
  id: string;
  scopeType?: string;
  scopeId?: string;
  operation?: string;
  sourceAsset?: string;
  destinationAsset?: string;
  feeFixed?: number;
  feePercentage?: number;
  createdAt?: string;
  updatedAt?: string;
}

export interface MutualFeesResponse {
  error: boolean;
  message: string;
  data: MutualFee[];
}

/**
 * O GET /crypto/quote responde em DOIS formatos, conforme ambiente/rota:
 *
 * Formato "quote" (ex: producao):
 *   { quote_id, type, source_asset, target_asset, source_amount,
 *     target_amount, price, fee_bps, provider, locked_at, expires_at }
 *
 * Formato "ticker" (ex: homologacao):
 *   { buy, sell, last, high, low, open, vol, pair, date }
 *   (buy = melhor oferta de compra/bid; sell = melhor oferta de venda/ask)
 */
export interface MutualQuoteData {
  // formato "quote"
  quote_id?: string;
  type?: string;
  source_asset?: string;
  target_asset?: string;
  source_amount?: string;
  target_amount?: string;
  price?: string;
  fee_bps?: number;
  provider?: string;
  locked_at?: string;
  expires_at?: string;
  // formato "ticker"
  buy?: string;
  sell?: string;
  last?: string;
  high?: string;
  low?: string;
  open?: string;
  vol?: string;
  pair?: string;
  date?: number;
}

export interface MutualQuoteResponse {
  error: boolean;
  message: string;
  data: MutualQuoteData;
}

/** Tipos de operacao suportados (tabela definitiva da secao 7 do descritivo). */
export type OperationType = "buy" | "sell" | "conversion";
