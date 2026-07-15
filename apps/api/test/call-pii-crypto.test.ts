import { createCipheriv, createHmac, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  CallPiiCrypto,
  CallPiiDecryptionError,
  parseCallPiiKeyring,
} from "../src/call-pii-crypto.js";

const organizationId = "10000000-0000-4000-8000-000000000001";
const otherOrganizationId = "20000000-0000-4000-8000-000000000002";
const rowId = "40000000-0000-4000-8000-000000000001";
const otherRowId = "40000000-0000-4000-8000-000000000002";

function encodedKey(fill: number): string {
  return Buffer.alloc(32, fill).toString("base64url");
}

function cryptoWith(options: {
  versions?: Array<[number, string]>;
  activeVersion?: number;
  blindVersions?: Array<[number, string]>;
  activeBlindVersion?: number;
  rowIdKey?: string;
} = {}): CallPiiCrypto {
  const versions = options.versions ?? [[1, encodedKey(1)], [2, encodedKey(2)]];
  const blindVersions = options.blindVersions ?? [[1, encodedKey(9)], [2, encodedKey(8)]];
  return new CallPiiCrypto(parseCallPiiKeyring({
    encryptionKeys: versions.map(([version, key]) => `${version}:${key}`).join(","),
    activeKeyVersion: String(options.activeVersion ?? versions.at(-1)?.[0] ?? 1),
    rowIdKey: options.rowIdKey ?? encodedKey(7),
    blindIndexKeys: blindVersions.map(([version, key]) => `${version}:${key}`).join(","),
    activeBlindIndexKeyVersion: String(options.activeBlindVersion ?? blindVersions.at(-1)?.[0] ?? 1),
  }));
}

function lengthPrefixed(value: string | Buffer): Buffer {
  const encoded = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(encoded.length);
  return Buffer.concat([length, encoded]);
}

function legacyEnvelope(crypto: CallPiiCrypto, plaintext: string) {
  const context = { organizationId, rowId, field: "phone_number" as const };
  const masterKey = Buffer.from(encodedKey(1), "base64url");
  const fieldKey = createHmac("sha256", masterKey)
    .update("callora:call-log-pii:field-key:v1:phone_number")
    .digest();
  const blindIndex = crypto.computeBlindIndex(context, plaintext, 1);
  const aad = Buffer.concat([
    lengthPrefixed("callora:call-log-pii:aes-256-gcm"),
    lengthPrefixed("1"),
    lengthPrefixed("1"),
    lengthPrefixed(organizationId),
    lengthPrefixed(rowId),
    lengthPrefixed("phone_number"),
    lengthPrefixed(blindIndex),
  ]);
  const nonce = Buffer.alloc(12, 4);
  const cipher = createCipheriv("aes-256-gcm", fieldKey, nonce, { authTagLength: 16 });
  cipher.setAAD(aad, { plaintextLength: Buffer.byteLength(plaintext) });
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final(), cipher.getAuthTag()]);
  return {
    formatVersion: 1,
    keyVersion: 1,
    blindIndexKeyVersion: 1,
    nonce,
    ciphertext,
    blindIndex,
  };
}

describe("CallPiiCrypto", () => {
  it("round-trips format-2 AES-256-GCM with active encryption and blind-index versions", () => {
    const crypto = cryptoWith();
    const context = { organizationId, rowId, field: "phone_number" as const };
    const encrypted = crypto.encryptField(context, "+919876543210");

    expect(encrypted.formatVersion).toBe(2);
    expect(encrypted.keyVersion).toBe(2);
    expect(encrypted.blindIndexKeyVersion).toBe(2);
    expect(encrypted.nonce).toHaveLength(12);
    expect(encrypted.ciphertext.equals(Buffer.from("+919876543210"))).toBe(false);
    expect(encrypted.blindIndex).toHaveLength(32);
    expect(crypto.decryptField(context, encrypted)).toBe("+919876543210");
  });

  it("uses a fresh nonce while retaining a stable active blind index", () => {
    const crypto = cryptoWith();
    const context = { organizationId, rowId, field: "phone_number" as const };
    const first = crypto.encryptField(context, "+919876543210");
    const second = crypto.encryptField(context, "+919876543210");

    expect(first.nonce.equals(second.nonce)).toBe(false);
    expect(first.ciphertext.equals(second.ciphertext)).toBe(false);
    expect(first.blindIndex.equals(second.blindIndex)).toBe(true);
  });

  it("fails closed when ciphertext, nonce, blind index, or either key version is changed", () => {
    const crypto = cryptoWith();
    const context = { organizationId, rowId, field: "contact_name" as const };
    const encrypted = crypto.encryptField(context, "Asha Patel");
    const changedCiphertext = Buffer.from(encrypted.ciphertext);
    changedCiphertext[0] = (changedCiphertext[0] ?? 0) ^ 1;
    const changedNonce = Buffer.from(encrypted.nonce);
    changedNonce[0] = (changedNonce[0] ?? 0) ^ 1;
    const changedBlindIndex = Buffer.from(encrypted.blindIndex);
    changedBlindIndex[0] = (changedBlindIndex[0] ?? 0) ^ 1;

    for (const candidate of [
      { ...encrypted, ciphertext: changedCiphertext },
      { ...encrypted, nonce: changedNonce },
      { ...encrypted, blindIndex: changedBlindIndex },
      { ...encrypted, keyVersion: 99 },
      { ...encrypted, blindIndexKeyVersion: 1 },
      { ...encrypted, blindIndexKeyVersion: 99 },
      { ...encrypted, formatVersion: 99 },
    ]) {
      expect(() => crypto.decryptField(context, candidate)).toThrow(CallPiiDecryptionError);
    }
  });

  it("binds authenticated data to tenant, row, field, format, and key versions", () => {
    const crypto = cryptoWith();
    const context = { organizationId, rowId, field: "phone_number" as const };
    const encrypted = crypto.encryptField(context, "+919876543210");

    expect(() => crypto.decryptField({ ...context, organizationId: otherOrganizationId }, encrypted))
      .toThrow(CallPiiDecryptionError);
    expect(() => crypto.decryptField({ ...context, rowId: otherRowId }, encrypted))
      .toThrow(CallPiiDecryptionError);
    expect(() => crypto.decryptField({ ...context, field: "contact_name" }, encrypted))
      .toThrow(CallPiiDecryptionError);
  });

  it("supports dual-key exact lookup during a rolling blind-index rotation", () => {
    const crypto = cryptoWith();
    const context = { organizationId, field: "phone_number" as const };
    const candidates = crypto.computeBlindIndexCandidates(context, "+919876543210");

    expect(candidates.map(({ keyVersion }) => keyVersion)).toEqual([2, 1]);
    expect(candidates[0]?.blindIndex.equals(candidates[1]?.blindIndex ?? Buffer.alloc(0))).toBe(false);
    expect(candidates[0]?.blindIndex.equals(
      crypto.computeBlindIndex(context, "+919876543210", 2),
    )).toBe(true);
    expect(() => crypto.computeBlindIndex(context, "+919876543210", 99)).toThrow();
  });

  it("retains legacy format-1 data and old decrypt-only encryption/blind keys", () => {
    const crypto = cryptoWith();
    const legacy = legacyEnvelope(crypto, "+919876543210");
    const context = { organizationId, rowId, field: "phone_number" as const };

    expect(crypto.decryptField(context, legacy)).toBe("+919876543210");
    expect(() => crypto.decryptField(context, { ...legacy, blindIndexKeyVersion: 2 }))
      .toThrow(CallPiiDecryptionError);
  });

  it("keeps deterministic row IDs stable while the blind-index keyring rotates", () => {
    const before = cryptoWith({ blindVersions: [[1, encodedKey(9)]], activeBlindVersion: 1 });
    const rotating = cryptoWith();
    const identity = {
      organizationId,
      source: "mobile_call_log" as const,
      deviceId: "50000000-0000-4000-8000-000000000001",
      externalId: "native-call-42",
    };

    const first = before.deriveRowId(identity);
    expect(rotating.deriveRowId(identity)).toBe(first);
    expect(rotating.deriveRowId({ ...identity, organizationId: otherOrganizationId })).not.toBe(first);
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("rejects missing, duplicate, noncanonical, rolled-back, or cross-purpose key material", () => {
    const valid = {
      encryptionKeys: `1:${encodedKey(1)},2:${encodedKey(2)}`,
      activeKeyVersion: "2",
      rowIdKey: encodedKey(7),
      blindIndexKeys: `1:${encodedKey(9)},2:${encodedKey(8)}`,
      activeBlindIndexKeyVersion: "2",
    };

    for (const candidate of [
      { ...valid, encryptionKeys: undefined },
      { ...valid, activeKeyVersion: undefined },
      { ...valid, rowIdKey: undefined },
      { ...valid, blindIndexKeys: undefined },
      { ...valid, activeBlindIndexKeyVersion: undefined },
      { ...valid, encryptionKeys: `1:${Buffer.alloc(16).toString("base64url")}` },
      { ...valid, encryptionKeys: `1:${encodedKey(1)},1:${encodedKey(2)}` },
      { ...valid, encryptionKeys: `1:${encodedKey(1)},2:${encodedKey(1)}` },
      { ...valid, activeKeyVersion: "1" },
      { ...valid, activeBlindIndexKeyVersion: "1" },
      { ...valid, activeBlindIndexKeyVersion: "3" },
      { ...valid, blindIndexKeys: `1:${encodedKey(9)},2:${encodedKey(9)}` },
      { ...valid, blindIndexKeys: `1:${encodedKey(9)},2:${encodedKey(1)}` },
      { ...valid, rowIdKey: encodedKey(9) },
      { ...valid, rowIdKey: encodedKey(1) },
      { ...valid, encryptionKeys: `01:${encodedKey(1)}`, activeKeyVersion: "1" },
      { ...valid, rowIdKey: randomBytes(31).toString("base64url") },
    ]) {
      expect(() => parseCallPiiKeyring(candidate)).toThrow();
    }
  });
});
