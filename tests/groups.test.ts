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

import { extractWhatsAppInviteCode } from "../src/channels/group-resolver.js";
import { GroupMatcher } from "../src/core/group-matcher.js";
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
