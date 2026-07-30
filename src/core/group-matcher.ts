/**
 * Localizacao do merchant pelo grupo, entendendo os formatos usados no
 * cadastro da Mutual (linkGroups.groupId):
 *
 *   - JID interno do WhatsApp:  120363...@g.us          -> match direto
 *   - Link de convite:          https://chat.whatsapp.com/C34dh...  -> resolve p/ JID
 *   - Codigo de convite puro:   C34dh5vXFPJ8wgOGlE9LYG  -> resolve p/ JID
 *   - IDs de outros canais (telegram etc.)              -> match direto
 */

import { findMerchantByGroup } from "./merchants.js";
import { extractWhatsAppInviteCode, type GroupResolver } from "../channels/group-resolver.js";
import type { MutualMerchant } from "../types.js";

export class GroupMatcher {
  constructor(private readonly resolver: GroupResolver) {}

  /**
   * Encontra o merchant do grupo. Primeiro tenta o match direto (comportamento
   * original); para WhatsApp, tambem resolve links/codigos de convite dos
   * linkGroups para JID e compara com o JID recebido no webhook.
   */
  async findMerchant(
    merchants: MutualMerchant[],
    channel: string,
    groupId: string,
  ): Promise<MutualMerchant | undefined> {
    const direct = findMerchantByGroup(merchants, channel, groupId);
    if (direct) return direct;

    const normalizedChannel = String(channel || "").toLowerCase();
    const targetJid = String(groupId || "").trim();
    if (normalizedChannel !== "whatsapp" || !targetJid.endsWith("@g.us")) {
      return undefined;
    }
    if (!this.resolver.enabled()) return undefined;

    for (const merchant of merchants) {
      if (merchant.status !== "active") continue;
      for (const group of merchant.linkGroups || []) {
        if (group.active !== true) continue;
        if (String(group.channel || "").toLowerCase() !== "whatsapp") continue;
        const code = extractWhatsAppInviteCode(group.groupId);
        if (!code) continue;
        const jid = await this.resolver.jidForInviteCode(code);
        if (jid && jid === targetJid) return merchant;
      }
    }
    return undefined;
  }

  /**
   * Forma canonica do groupId de um linkGroup (para o painel): convites de
   * WhatsApp viram o JID resolvido; demais valores passam inalterados.
   *
   * `force` ignora o cache — use quando o operador aciona a resolucao a mao
   * (vincular grupo no painel), para que uma falha anterior nao impeca a nova
   * tentativa.
   */
  async canonicalGroupId(channel: string, rawGroupId: string, force = false): Promise<string> {
    const raw = String(rawGroupId || "").trim();
    if (String(channel || "").toLowerCase() !== "whatsapp") return raw;
    const code = extractWhatsAppInviteCode(raw);
    if (!code || !this.resolver.enabled()) return raw;
    const jid = await this.resolver.jidForInviteCode(code, force);
    return jid ?? raw;
  }

  /**
   * Versao SEM rede: usa apenas o que ja esta em cache. O painel atualiza a
   * cada poucos segundos e nao pode ficar preso resolvendo convites na
   * Evolution — a resolucao real acontece no fluxo da mensagem (e no
   * aquecimento em segundo plano).
   */
  canonicalGroupIdCached(channel: string, rawGroupId: string): string {
    const raw = String(rawGroupId || "").trim();
    if (String(channel || "").toLowerCase() !== "whatsapp") return raw;
    const code = extractWhatsAppInviteCode(raw);
    if (!code || !this.resolver.enabled()) return raw;
    return this.resolver.cachedJid(code) ?? raw;
  }

  /**
   * Resolve em segundo plano os convites ainda desconhecidos (limite por
   * rodada) para que o painel converja sem bloquear nenhuma requisicao.
   */
  async warmInviteCache(
    merchants: readonly MutualMerchant[],
    maxPerRound = 5,
  ): Promise<void> {
    if (!this.resolver.enabled()) return;
    let resolved = 0;
    for (const merchant of merchants) {
      for (const group of merchant.linkGroups || []) {
        if (resolved >= maxPerRound) return;
        if (String(group.channel || "").toLowerCase() !== "whatsapp") continue;
        const code = extractWhatsAppInviteCode(group.groupId);
        if (!code || this.resolver.cachedJid(code)) continue;
        await this.resolver.jidForInviteCode(code).catch(() => null);
        resolved += 1;
      }
    }
  }
}
