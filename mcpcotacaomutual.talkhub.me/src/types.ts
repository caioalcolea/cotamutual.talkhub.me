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

export interface MutualMerchant {
  id: string;
  organizationId?: string;
  legalName?: string;
  legalDocument?: string;
  status?: string;
  email?: string;
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

export interface MutualQuoteData {
  quote_id: string;
  type: string;
  source_asset: string;
  target_asset: string;
  source_amount: string;
  target_amount: string;
  price: string;
  fee_bps: number;
  provider: string;
  locked_at: string;
  expires_at: string;
}

export interface MutualQuoteResponse {
  error: boolean;
  message: string;
  data: MutualQuoteData;
}

export interface MutualOrderResponse {
  error: boolean;
  message: string;
  data: Record<string, unknown>;
}
