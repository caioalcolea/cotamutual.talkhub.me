/**
 * Resolucao de grupos do WhatsApp: link/codigo de convite -> JID interno.
 *
 * No cadastro da Mutual os grupos costumam ser vinculados pelo LINK DE CONVITE
 * (ex: https://chat.whatsapp.com/C34dh5vXFPJ8wgOGlE9LYG) ou apenas pelo codigo,
 * mas o webhook entrega o JID interno (ex: 120363...@g.us). Este modulo usa a
 * Evolution API (GET /group/inviteInfo) para descobrir o JID a partir do
 * convite, com cache para nao repetir chamadas.
 */

import axios from "axios";
import type { AppConfig } from "../config.js";
import { logger } from "../logger.js";

/**
 * Extrai o codigo de convite do WhatsApp de um valor de linkGroup.groupId.
 * Aceita:
 *   - https://chat.whatsapp.com/C34dh5vXFPJ8wgOGlE9LYG
 *   - https://chat.whatsapp.com/invite/C34dh5vXFPJ8wgOGlE9LYG
 *   - C34dh5vXFPJ8wgOGlE9LYG (codigo puro, 16-32 chars alfanumericos)
 * Retorna null para JIDs (...@g.us), URLs de outros dominios e IDs numericos.
 */
export function extractWhatsAppInviteCode(raw: string | null | undefined): string | null {
  const value = String(raw || "").trim();
  if (!value || value.includes("@")) return null;

  const linkMatch = /chat\.whatsapp\.com\/(?:invite\/)?([A-Za-z0-9_-]{10,64})/i.exec(value);
  if (linkMatch) return linkMatch[1];

  // URL de outro dominio (ex: backoffice) nao e convite.
  if (value.includes("/") || value.includes(":")) return null;

  // Codigo puro: alfanumerico, tamanho tipico ~22, e nao apenas digitos.
  if (/^[A-Za-z0-9_-]{16,32}$/.test(value) && !/^\d+$/.test(value)) {
    return value;
  }

  return null;
}

interface CacheEntry {
  jid: string | null;
  at: number;
}

/** TTLs do cache: sucesso 6h (mapeamento estavel), falha 60s. */
const SUCCESS_TTL_MS = 6 * 60 * 60 * 1000;
const FAILURE_TTL_MS = 60 * 1000;

export class GroupResolver {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly pending = new Map<string, Promise<string | null>>();

  constructor(private readonly config: AppConfig) {}

  enabled(): boolean {
    return Boolean(
      this.config.evolutionBaseUrl && this.config.evolutionInstance && this.config.evolutionApiKey,
    );
  }

  /** JID em cache (sem chamada de rede); null se desconhecido/expirado. */
  cachedJid(code: string): string | null {
    const entry = this.cache.get(code);
    if (!entry) return null;
    const ttl = entry.jid ? SUCCESS_TTL_MS : FAILURE_TTL_MS;
    if (Date.now() - entry.at > ttl) return null;
    return entry.jid;
  }

  /** Resolve o codigo de convite para o JID do grupo via Evolution API. */
  async jidForInviteCode(code: string): Promise<string | null> {
    if (!this.enabled()) return null;

    const entry = this.cache.get(code);
    if (entry) {
      const ttl = entry.jid ? SUCCESS_TTL_MS : FAILURE_TTL_MS;
      if (Date.now() - entry.at < ttl) return entry.jid;
    }

    const inFlight = this.pending.get(code);
    if (inFlight) return inFlight;

    const promise = this.fetchInviteInfo(code)
      .then((jid) => {
        this.cache.set(code, { jid, at: Date.now() });
        return jid;
      })
      .finally(() => {
        this.pending.delete(code);
      });

    this.pending.set(code, promise);
    return promise;
  }

  private async fetchInviteInfo(code: string): Promise<string | null> {
    const url = `${this.config.evolutionBaseUrl}/group/inviteInfo/${encodeURIComponent(
      this.config.evolutionInstance as string,
    )}`;
    try {
      const response = await axios.get(url, {
        params: { inviteCode: code },
        timeout: 10_000,
        headers: { apikey: this.config.evolutionApiKey as string },
      });
      const body = response.data as Record<string, unknown> | null;
      const data = (body?.data ?? body) as Record<string, unknown> | null;
      const jid =
        (typeof data?.id === "string" && data.id) ||
        (typeof data?.groupJid === "string" && data.groupJid) ||
        null;
      if (jid && jid.endsWith("@g.us")) {
        logger.info("Convite de grupo resolvido para JID", { code, jid });
        return jid;
      }
      logger.warn("inviteInfo sem JID reconhecivel", { code, body: JSON.stringify(body).slice(0, 300) });
      return null;
    } catch (error) {
      const detail = axios.isAxiosError(error)
        ? `HTTP ${error.response?.status ?? "?"} ${JSON.stringify(error.response?.data ?? "").slice(0, 200)}`
        : String(error);
      logger.warn("Falha ao resolver convite de grupo na Evolution", { code, detail });
      return null;
    }
  }
}
