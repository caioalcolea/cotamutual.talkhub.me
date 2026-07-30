/**
 * Testes da resolucao de grupos WhatsApp: link/codigo de convite -> JID.
 *
 * No cadastro da Mutual, linkGroups.groupId pode vir como:
 *   - link de convite (https://chat.whatsapp.com/...)
 *   - codigo de convite puro
 *   - JID interno (...@g.us)
 *   - IDs de outros canais
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { extractWhatsAppInviteCode } from "../src/channels/group-resolver.js";
import { GroupMatcher } from "../src/core/group-matcher.js";
import { MerchantStore } from "../src/state/merchant-store.js";
import type { GroupResolver } from "../src/channels/group-resolver.js";
import type { MutualMerchant } from "../src/types.js";

// ---------------------------------------------------------------------------
// Extracao do codigo de convite
// ---------------------------------------------------------------------------

test("extractWhatsAppInviteCode: formatos aceitos e rejeitados", () => {
  assert.equal(
    extractWhatsAppInviteCode("https://chat.whatsapp.com/C34dh5vXFPJ8wgOGlE9LYG"),
    "C34dh5vXFPJ8wgOGlE9LYG",
  );
  assert.equal(
    extractWhatsAppInviteCode("https://chat.whatsapp.com/invite/C34dh5vXFPJ8wgOGlE9LYG"),
    "C34dh5vXFPJ8wgOGlE9LYG",
  );
  assert.equal(
    extractWhatsAppInviteCode("  https://chat.whatsapp.com/C34dh5vXFPJ8wgOGlE9LYG?mode=ac_t  "),
    "C34dh5vXFPJ8wgOGlE9LYG",
  );
  // Codigo puro (como aparece em alguns cadastros)
  assert.equal(extractWhatsAppInviteCode("C34dh5vXFPJ8wgOGlE9LYG"), "C34dh5vXFPJ8wgOGlE9LYG");

  // JID interno nao e convite
  assert.equal(extractWhatsAppInviteCode("120363429012757266@g.us"), null);
  // URL de outro dominio (ex: backoffice colado por engano) nao e convite
  assert.equal(
    extractWhatsAppInviteCode("https://backoffice.mutual.app.br/dashboard/merchants/org_x"),
    null,
  );
  // IDs numericos (telegram) nao sao convite
  assert.equal(extractWhatsAppInviteCode("23141"), null);
  assert.equal(extractWhatsAppInviteCode(""), null);
  assert.equal(extractWhatsAppInviteCode(null), null);
});

// ---------------------------------------------------------------------------
// Match de merchant com convite resolvido
// ---------------------------------------------------------------------------

function stubResolver(map: Record<string, string>): GroupResolver {
  return {
    enabled: () => true,
    cachedJid: (code: string) => map[code] ?? null,
    jidForInviteCode: async (code: string) => map[code] ?? null,
  } as unknown as GroupResolver;
}

const MERCHANTS: MutualMerchant[] = [
  {
    id: "org_nivaldeir",
    status: "active",
    legalName: "Nivaldeir Santana da Silva",
    linkGroups: [
      {
        id: "lg_1",
        channel: "whatsapp",
        groupId: "https://chat.whatsapp.com/C34dh5vXFPJ8wgOGlE9LYG",
        name: "teste",
        active: true,
      },
    ],
  },
  {
    id: "org_qa",
    status: "active",
    legalName: "QA LTDA",
    linkGroups: [{ id: "lg_2", channel: "telegram", groupId: "23141", active: true }],
  },
  {
    id: "org_jid",
    status: "active",
    legalName: "Cliente JID Direto",
    linkGroups: [
      { id: "lg_3", channel: "whatsapp", groupId: "120363000000000001@g.us", active: true },
    ],
  },
];

test("GroupMatcher: convite cadastrado casa com JID recebido no webhook", async () => {
  const matcher = new GroupMatcher(
    stubResolver({ C34dh5vXFPJ8wgOGlE9LYG: "120363429012757266@g.us" }),
  );
  const merchant = await matcher.findMerchant(MERCHANTS, "whatsapp", "120363429012757266@g.us");
  assert.equal(merchant?.id, "org_nivaldeir");
});

test("GroupMatcher: JID direto e telegram continuam funcionando", async () => {
  const matcher = new GroupMatcher(stubResolver({}));
  assert.equal(
    (await matcher.findMerchant(MERCHANTS, "whatsapp", "120363000000000001@g.us"))?.id,
    "org_jid",
  );
  assert.equal((await matcher.findMerchant(MERCHANTS, "telegram", "23141"))?.id, "org_qa");
});

test("GroupMatcher: convite nao resolvido -> sem match (sem falso positivo)", async () => {
  const matcher = new GroupMatcher(stubResolver({}));
  const merchant = await matcher.findMerchant(MERCHANTS, "whatsapp", "120363429012757266@g.us");
  assert.equal(merchant, undefined);
});

test("GroupMatcher: canonicalGroupId resolve convite e preserva o resto", async () => {
  const matcher = new GroupMatcher(
    stubResolver({ C34dh5vXFPJ8wgOGlE9LYG: "120363429012757266@g.us" }),
  );
  assert.equal(
    await matcher.canonicalGroupId("whatsapp", "https://chat.whatsapp.com/C34dh5vXFPJ8wgOGlE9LYG"),
    "120363429012757266@g.us",
  );
  assert.equal(
    await matcher.canonicalGroupId("whatsapp", "120363000000000001@g.us"),
    "120363000000000001@g.us",
  );
  assert.equal(await matcher.canonicalGroupId("telegram", "23141"), "23141");
});

// ---------------------------------------------------------------------------
// Vinculo pelo LINK DE CONVITE (painel)
//
// O operador cola o link — o usuario final nao sabe o JID interno. O convite e
// resolvido na hora e o vinculo passa a valer pelo ID real do grupo.
// ---------------------------------------------------------------------------

/** Resolver com cache negativo real: a 1a tentativa falha, a 2a so passa com force. */
function flakyResolver(code: string, jid: string) {
  const calls = { total: 0 };
  let available = false;
  const cache = new Map<string, string | null>();
  const resolver = {
    enabled: () => true,
    cachedJid: (c: string) => cache.get(c) ?? null,
    jidForInviteCode: async (c: string, force = false) => {
      if (force) cache.delete(c);
      if (cache.has(c)) return cache.get(c) ?? null;
      calls.total += 1;
      const result = c === code && available ? jid : null;
      cache.set(c, result);
      return result;
    },
  } as unknown as GroupResolver;
  return { resolver, calls, enable: () => { available = true; } };
}

test("canonicalGroupId(force) ignora o cache de falha — novo clique em Vincular tenta de novo", async () => {
  const { resolver, calls, enable } = flakyResolver("LATERxxxxxxxxxxxxxxxxx", "120363555@g.us");
  const matcher = new GroupMatcher(resolver);
  const link = "https://chat.whatsapp.com/LATERxxxxxxxxxxxxxxxxx";

  // 1a tentativa: instancia ainda fora do grupo.
  assert.equal(await matcher.canonicalGroupId("whatsapp", link, true), link);
  // Sem force, o cache negativo responderia sozinho (sem chamar a Evolution).
  enable();
  assert.equal(await matcher.canonicalGroupId("whatsapp", link), link, "cache negativo em vigor");
  assert.equal(calls.total, 1, "a 2a chamada nem foi ate a Evolution");
  // Com force (o que o painel faz), a resolucao acontece de verdade.
  assert.equal(await matcher.canonicalGroupId("whatsapp", link, true), "120363555@g.us");
  assert.equal(calls.total, 2);
});

test("vínculo por convite: grava o JID como forma canônica e guarda o link", () => {
  const dir = mkdtempSync(join(tmpdir(), "cotamutual-invite-"));
  const store = new MerchantStore(dir);
  const link = "https://chat.whatsapp.com/C34dh5vXFPJ8wgOGlE9LYG";

  const binding = store.bindGroup("whatsapp", "120363429012757266@g.us", "org_A", "Grupo", link);
  assert.equal(binding.groupId, "120363429012757266@g.us");
  assert.equal(binding.invite, link);
  assert.equal(store.bindings().length, 1);

  // Desvincular digitando o LINK remove o vinculo gravado pelo JID.
  assert.equal(store.unbindGroup("whatsapp", link), true);
  assert.equal(store.bindings().length, 0);
});

test("vínculo por convite: ao resolver depois, substitui o registro feito pelo link (sem duplicar)", () => {
  const dir = mkdtempSync(join(tmpdir(), "cotamutual-invite2-"));
  const store = new MerchantStore(dir);
  const link = "https://chat.whatsapp.com/LATERxxxxxxxxxxxxxxxxx";

  // 1o vinculo: convite nao resolveu, gravado pelo proprio link.
  store.bindGroup("whatsapp", link, "org_A", "Grupo", link);
  assert.equal(store.bindings()[0].groupId, link);

  // 2o vinculo: convite resolvido -> grava pelo JID e limpa o registro antigo.
  store.bindGroup("whatsapp", "120363555@g.us", "org_A", "Grupo", link);
  assert.equal(store.bindings().length, 1, "não duplica o mesmo grupo");
  assert.equal(store.bindings()[0].groupId, "120363555@g.us");
});

test("desvincular pelo JID também funciona quando o vínculo veio de um link", () => {
  const dir = mkdtempSync(join(tmpdir(), "cotamutual-invite3-"));
  const store = new MerchantStore(dir);
  store.bindGroup("whatsapp", "120363555@g.us", "org_A", "Grupo", "https://chat.whatsapp.com/ABCdefGHIjklMNOpqrSTU");

  assert.equal(store.unbindGroup("whatsapp", "120363555@g.us"), true);
  assert.equal(store.bindings().length, 0);
  assert.equal(store.unbindGroup("whatsapp", "120363555@g.us"), false, "remover duas vezes não quebra");
});
