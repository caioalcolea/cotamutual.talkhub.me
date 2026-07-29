/**
 * Cache de merchants e fees.
 *
 * - Merchants: TTL padrao 60s.
 * - Fees:      TTL padrao 60s, por merchant.
 * - Cotacoes:  NUNCA passam por aqui — cada mensagem da fila faz requisicao nova.
 *
 * Falhas ficam registradas (lastError) para o painel mostrar o motivo real em
 * vez de uma lista vazia sem explicacao.
 */

import type { MutualClients } from "../mutual/client.js";
import { fetchAllMerchants, fetchMerchantFees } from "../mutual/merchants.js";
import type { MutualFee, MutualMerchant } from "../types.js";
import { describeError } from "../util/errors.js";
import { logger } from "../logger.js";

interface CacheEntry<T> {
  value: T;
  fetchedAt: number;
}

export interface CacheFailure {
  detail: string;
  at: number;
}

export class MerchantCache {
  private entry: CacheEntry<MutualMerchant[]> | null = null;
  private pending: Promise<MutualMerchant[]> | null = null;
  private failure: CacheFailure | null = null;

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
        this.failure = null;
        return merchants;
      })
      .catch((error) => {
        const detail = describeError(error);
        this.failure = { detail, at: Date.now() };
        // Falha na atualizacao: mantem o cache antigo se existir.
        if (this.entry) {
          logger.warn("Falha ao atualizar merchants; usando cache anterior", { detail });
          return this.entry.value;
        }
        logger.error("Falha ao consultar merchants na Mutual", { detail });
        throw error;
      })
      .finally(() => {
        this.pending = null;
      });

    return this.pending;
  }

  /** Estado para o painel (sem forcar atualizacao). */
  snapshot(): {
    merchants: MutualMerchant[];
    fetchedAt: number | null;
    lastError: CacheFailure | null;
  } {
    return {
      merchants: this.entry?.value ?? [],
      fetchedAt: this.entry?.fetchedAt ?? null,
      lastError: this.failure,
    };
  }
}

export class FeeCache {
  private readonly entries = new Map<string, CacheEntry<MutualFee[]>>();
  private readonly pending = new Map<string, Promise<MutualFee[]>>();
  private failure: CacheFailure | null = null;

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
        const detail = describeError(error);
        this.failure = { detail, at: Date.now() };
        if (cached) {
          logger.warn("Falha ao atualizar fees; usando cache anterior", { merchantId, detail });
          return cached.value;
        }
        logger.error("Falha ao consultar fees na Mutual", { merchantId, detail });
        throw error;
      })
      .finally(() => {
        this.pending.delete(merchantId);
      });

    this.pending.set(merchantId, promise);
    return promise;
  }

  lastError(): CacheFailure | null {
    return this.failure;
  }
}
