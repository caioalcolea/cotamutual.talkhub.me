/**
 * Cache de merchants e fees (secao 17 do descritivo).
 *
 * - Merchants: TTL padrao 60s.
 * - Fees:      TTL padrao 60s, por merchant.
 * - Cotacoes:  NUNCA passam por aqui — cada mensagem da fila faz requisicao nova.
 */

import type { AppConfig } from "../config.js";
import type { MutualClients } from "../mutual/client.js";
import { fetchAllMerchants, fetchMerchantFees } from "../mutual/merchants.js";
import type { MutualFee, MutualMerchant } from "../types.js";
import { logger } from "../logger.js";

interface CacheEntry<T> {
  value: T;
  fetchedAt: number;
}

export class MerchantCache {
  private entry: CacheEntry<MutualMerchant[]> | null = null;
  private pending: Promise<MutualMerchant[]> | null = null;

  constructor(
    private readonly clients: MutualClients,
    private readonly ttlMs: number,
  ) {}

  async getAll(): Promise<MutualMerchant[]> {
    const now = Date.now();
    if (this.entry && now - this.entry.fetchedAt < this.ttlMs) {
      return this.entry.value;
    }
    if (this.pending) return this.pending;

    this.pending = fetchAllMerchants(this.clients)
      .then((merchants) => {
        this.entry = { value: merchants, fetchedAt: Date.now() };
        return merchants;
      })
      .catch((error) => {
        // Falha na atualizacao: mantem o cache antigo se existir.
        if (this.entry) {
          logger.warn("Falha ao atualizar merchants; usando cache anterior", {
            error: String(error),
          });
          return this.entry.value;
        }
        throw error;
      })
      .finally(() => {
        this.pending = null;
      });

    return this.pending;
  }

  /** Estado para o painel (sem forcar atualizacao). */
  snapshot(): { merchants: MutualMerchant[]; fetchedAt: number | null } {
    return {
      merchants: this.entry?.value ?? [],
      fetchedAt: this.entry?.fetchedAt ?? null,
    };
  }
}

export class FeeCache {
  private readonly entries = new Map<string, CacheEntry<MutualFee[]>>();
  private readonly pending = new Map<string, Promise<MutualFee[]>>();

  constructor(
    private readonly clients: MutualClients,
    private readonly ttlMs: number,
  ) {}

  async getByMerchantId(merchantId: string): Promise<MutualFee[]> {
    const now = Date.now();
    const cached = this.entries.get(merchantId);
    if (cached && now - cached.fetchedAt < this.ttlMs) {
      return cached.value;
    }

    const inFlight = this.pending.get(merchantId);
    if (inFlight) return inFlight;

    const promise = fetchMerchantFees(this.clients, merchantId)
      .then((fees) => {
        this.entries.set(merchantId, { value: fees, fetchedAt: Date.now() });
        return fees;
      })
      .catch((error) => {
        if (cached) {
          logger.warn("Falha ao atualizar fees; usando cache anterior", {
            merchantId,
            error: String(error),
          });
          return cached.value;
        }
        throw error;
      })
      .finally(() => {
        this.pending.delete(merchantId);
      });

    this.pending.set(merchantId, promise);
    return promise;
  }
}
