import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

/**
 * Format 1 is the legacy envelope whose AAD did not persist the blind-index
 * key version. Format 2 authenticates that version as part of the envelope.
 */
export const CALL_PII_FORMAT_VERSION = 2 as const;
const LEGACY_CALL_PII_FORMAT_VERSION = 1;
const LEGACY_BLIND_INDEX_KEY_VERSION = 1;
const AES_KEY_BYTES = 32;
const GCM_NONCE_BYTES = 12;
const GCM_TAG_BYTES = 16;
const MAX_KEY_VERSIONS = 32;
const MAX_KEY_VERSION = 2_147_483_647;
const MAX_PLAINTEXT_BYTES = 65_536;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BASE64URL_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export type CallPiiField = "phone_number" | "contact_name";

export interface CallPiiContext {
  organizationId: string;
  rowId: string;
  field: CallPiiField;
}

export interface CallPiiBlindIndexContext {
  organizationId: string;
  field: CallPiiField;
}

export interface CallPiiRowIdentity {
  organizationId: string;
  source: "mobile_call_log" | "manual" | "telephony_provider" | "import";
  deviceId?: string;
  externalId: string;
}

export interface BlindIndexCandidate {
  keyVersion: number;
  blindIndex: Buffer;
}

export interface EncryptedCallPiiField {
  formatVersion: number;
  keyVersion: number;
  blindIndexKeyVersion: number;
  /** 96-bit GCM nonce. It must be stored separately from ciphertext. */
  nonce: Buffer;
  /** Ciphertext followed by the 128-bit GCM authentication tag. */
  ciphertext: Buffer;
  /** Tenant- and field-bound deterministic HMAC for exact-match lookup. */
  blindIndex: Buffer;
}

export interface CallPiiKeyringInput {
  /** Comma-separated canonical entries: `<positive-version>:<32-byte-base64url-key>`. */
  encryptionKeys?: string | undefined;
  activeKeyVersion?: string | undefined;
  /** Stable, non-rotating row-identity key, independent from all PII keyrings. */
  rowIdKey?: string | undefined;
  /** Versioned HMAC keys using the same canonical serialization as encryptionKeys. */
  blindIndexKeys?: string | undefined;
  activeBlindIndexKeyVersion?: string | undefined;
}

export class CallPiiConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CallPiiConfigurationError";
  }
}

/** A deliberately generic error so authentication failures do not become an oracle. */
export class CallPiiDecryptionError extends Error {
  constructor() {
    super("Call-log PII could not be authenticated and decrypted");
    this.name = "CallPiiDecryptionError";
  }
}

class CallPiiKeyring {
  readonly activeKeyVersion: number;
  readonly activeBlindIndexKeyVersion: number;
  readonly configuredVersions: readonly number[];
  readonly configuredBlindIndexVersions: readonly number[];
  readonly #encryptionKeys: ReadonlyMap<number, Buffer>;
  readonly #blindIndexKeys: ReadonlyMap<number, Buffer>;
  readonly #rowIdKey: Buffer;

  constructor(options: {
    encryptionKeys: ReadonlyMap<number, Buffer>;
    activeKeyVersion: number;
    blindIndexKeys: ReadonlyMap<number, Buffer>;
    activeBlindIndexKeyVersion: number;
    rowIdKey: Buffer;
  }) {
    this.#encryptionKeys = cloneKeyMap(options.encryptionKeys);
    this.#blindIndexKeys = cloneKeyMap(options.blindIndexKeys);
    this.#rowIdKey = Buffer.from(options.rowIdKey);
    this.activeKeyVersion = options.activeKeyVersion;
    this.activeBlindIndexKeyVersion = options.activeBlindIndexKeyVersion;
    this.configuredVersions = Object.freeze([...options.encryptionKeys.keys()].sort((left, right) => left - right));
    this.configuredBlindIndexVersions = Object.freeze(
      [...options.blindIndexKeys.keys()].sort((left, right) => left - right),
    );
  }

  encryptionKey(version: number): Buffer | undefined {
    const key = this.#encryptionKeys.get(version);
    return key === undefined ? undefined : Buffer.from(key);
  }

  blindIndexKey(version: number): Buffer | undefined {
    const key = this.#blindIndexKeys.get(version);
    return key === undefined ? undefined : Buffer.from(key);
  }

  hasBlindIndexKey(version: number): boolean {
    return this.#blindIndexKeys.has(version);
  }

  rowIdKey(): Buffer {
    return Buffer.from(this.#rowIdKey);
  }
}

function cloneKeyMap(source: ReadonlyMap<number, Buffer>): ReadonlyMap<number, Buffer> {
  return new Map([...source].map(([version, key]) => [version, Buffer.from(key)]));
}

function configurationError(message: string): never {
  throw new CallPiiConfigurationError(message);
}

function parseVersion(value: string | undefined, name: string): number {
  if (value === undefined || !/^[1-9][0-9]{0,9}$/.test(value)) {
    return configurationError(`${name} must be a canonical positive integer`);
  }
  const version = Number(value);
  if (!Number.isSafeInteger(version) || version > MAX_KEY_VERSION) {
    return configurationError(`${name} is outside the supported range`);
  }
  return version;
}

function decodeKey(value: string | undefined, name: string): Buffer {
  if (value === undefined || !BASE64URL_KEY_PATTERN.test(value)) {
    return configurationError(`${name} must be an unpadded base64url-encoded 32-byte key`);
  }
  const decoded = Buffer.from(value, "base64url");
  if (decoded.length !== AES_KEY_BYTES || decoded.toString("base64url") !== value) {
    return configurationError(`${name} must be a canonical 32-byte key`);
  }
  return decoded;
}

function parseVersionedKeys(serialized: string | undefined, environmentName: string): Map<number, Buffer> {
  if (serialized === undefined || serialized.length === 0 || serialized !== serialized.trim()) {
    return configurationError(`${environmentName} is required and must not contain outer whitespace`);
  }
  const entries = serialized.split(",");
  if (entries.length === 0 || entries.length > MAX_KEY_VERSIONS) {
    return configurationError(`${environmentName} must contain between 1 and ${MAX_KEY_VERSIONS} keys`);
  }

  const keys = new Map<number, Buffer>();
  const fingerprints = new Set<string>();
  for (const entry of entries) {
    const parts = entry.split(":");
    if (parts.length !== 2) {
      return configurationError(`Each ${environmentName} entry must be \`<version>:<base64url-key>\``);
    }
    const version = parseVersion(parts[0], `${environmentName} key version`);
    if (keys.has(version)) return configurationError(`Duplicate ${environmentName} key version ${version}`);
    const key = decodeKey(parts[1], `${environmentName} key ${version}`);
    const fingerprint = key.toString("hex");
    if (fingerprints.has(fingerprint)) {
      return configurationError(`${environmentName} key material must not be reused across versions`);
    }
    keys.set(version, key);
    fingerprints.add(fingerprint);
  }
  return keys;
}

function validateActiveVersion(
  keys: ReadonlyMap<number, Buffer>,
  serializedActiveVersion: string | undefined,
  environmentName: string,
  keyringEnvironmentName: string,
): number {
  const activeVersion = parseVersion(serializedActiveVersion, environmentName);
  if (!keys.has(activeVersion)) {
    return configurationError(`${environmentName} is not present in ${keyringEnvironmentName}`);
  }
  if (activeVersion !== Math.max(...keys.keys())) {
    return configurationError(`${environmentName} must be the highest configured key version`);
  }
  return activeVersion;
}

/**
 * Parses explicit encryption, blind-index, and stable row-identity secrets.
 * There are intentionally no defaults. All key material must be unique across
 * purposes so a blind-index rotation can never change deterministic row IDs.
 */
export function parseCallPiiKeyring(input: CallPiiKeyringInput): CallPiiKeyring {
  const encryptionKeys = parseVersionedKeys(input.encryptionKeys, "CALL_PII_ENCRYPTION_KEYS");
  const activeKeyVersion = validateActiveVersion(
    encryptionKeys,
    input.activeKeyVersion,
    "CALL_PII_ACTIVE_KEY_VERSION",
    "CALL_PII_ENCRYPTION_KEYS",
  );
  const blindIndexKeys = parseVersionedKeys(input.blindIndexKeys, "CALL_PII_BLIND_INDEX_KEYS");
  const activeBlindIndexKeyVersion = validateActiveVersion(
    blindIndexKeys,
    input.activeBlindIndexKeyVersion,
    "CALL_PII_ACTIVE_BLIND_INDEX_KEY_VERSION",
    "CALL_PII_BLIND_INDEX_KEYS",
  );
  const rowIdKey = decodeKey(input.rowIdKey, "CALL_PII_ROW_ID_KEY");

  const allFingerprints = new Set<string>();
  for (const [purpose, keys] of [
    ["encryption", encryptionKeys],
    ["blind-index", blindIndexKeys],
  ] as const) {
    for (const key of keys.values()) {
      const fingerprint = key.toString("hex");
      if (allFingerprints.has(fingerprint)) {
        return configurationError(`Call-log PII ${purpose} key material must be independent across keyrings`);
      }
      allFingerprints.add(fingerprint);
    }
  }
  if (allFingerprints.has(rowIdKey.toString("hex"))) {
    return configurationError("CALL_PII_ROW_ID_KEY must be independent from every encryption and blind-index key");
  }

  return new CallPiiKeyring({
    encryptionKeys,
    activeKeyVersion,
    blindIndexKeys,
    activeBlindIndexKeyVersion,
    rowIdKey,
  });
}

function canonicalUuid(value: string, name: string): string {
  if (!UUID_PATTERN.test(value)) throw new TypeError(`${name} must be a canonical UUID`);
  return value.toLowerCase();
}

function assertField(value: string): asserts value is CallPiiField {
  if (value !== "phone_number" && value !== "contact_name") {
    throw new TypeError("Call-log PII field is unsupported");
  }
}

function lengthPrefixed(value: string): Buffer {
  return lengthPrefixedBuffer(Buffer.from(value, "utf8"));
}

function lengthPrefixedBuffer(value: Buffer): Buffer {
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(value.length);
  return Buffer.concat([length, value]);
}

function authenticatedData(
  context: CallPiiContext,
  formatVersion: number,
  keyVersion: number,
  blindIndexKeyVersion: number,
  blindIndex: Buffer,
): Buffer {
  assertField(context.field);
  const organizationId = canonicalUuid(context.organizationId, "organizationId");
  const rowId = canonicalUuid(context.rowId, "rowId");
  const common = [
    lengthPrefixed("callora:call-log-pii:aes-256-gcm"),
    lengthPrefixed(String(formatVersion)),
    lengthPrefixed(String(keyVersion)),
  ];
  if (formatVersion === CALL_PII_FORMAT_VERSION) {
    common.push(lengthPrefixed(String(blindIndexKeyVersion)));
  } else if (formatVersion !== LEGACY_CALL_PII_FORMAT_VERSION) {
    throw new Error("Unsupported encrypted envelope format");
  }
  return Buffer.concat([
    ...common,
    lengthPrefixed(organizationId),
    lengthPrefixed(rowId),
    lengthPrefixed(context.field),
    lengthPrefixedBuffer(blindIndex),
  ]);
}

function deriveFieldKey(masterKey: Buffer, field: CallPiiField, formatVersion: number): Buffer {
  return createHmac("sha256", masterKey)
    .update(`callora:call-log-pii:field-key:v${formatVersion}:${field}`)
    .digest();
}

function plaintextBuffer(value: string): Buffer {
  if (typeof value !== "string") throw new TypeError("Call-log PII plaintext must be a string");
  const encoded = Buffer.from(value, "utf8");
  if (encoded.length > MAX_PLAINTEXT_BYTES) {
    throw new TypeError(`Call-log PII plaintext exceeds ${MAX_PLAINTEXT_BYTES} bytes`);
  }
  return encoded;
}

export class CallPiiCrypto {
  constructor(private readonly keyring: CallPiiKeyring) {}

  get activeEncryptionKeyVersion(): number {
    return this.keyring.activeKeyVersion;
  }

  get activeBlindIndexKeyVersion(): number {
    return this.keyring.activeBlindIndexKeyVersion;
  }

  /**
   * Derives a stable UUIDv8-shaped row identity for concurrent inserts. Existing
   * rows keep their stored UUID; callers should prefer it when it is already known.
   */
  deriveRowId(identity: CallPiiRowIdentity): string {
    const organizationId = canonicalUuid(identity.organizationId, "organizationId");
    if (!identity.externalId || Buffer.byteLength(identity.externalId, "utf8") > MAX_PLAINTEXT_BYTES) {
      throw new TypeError("Call-log externalId must be a non-empty bounded string");
    }
    if (!["mobile_call_log", "manual", "telephony_provider", "import"].includes(identity.source)) {
      throw new TypeError("Call-log source is unsupported");
    }
    const deviceId = identity.deviceId === undefined ? "" : canonicalUuid(identity.deviceId, "deviceId");
    const masterKey = this.keyring.rowIdKey();
    const digest = createHmac("sha256", masterKey)
      .update(lengthPrefixed("callora:call-log-row-id:v1"))
      .update(lengthPrefixed(organizationId))
      .update(lengthPrefixed(identity.source))
      .update(lengthPrefixed(deviceId))
      .update(lengthPrefixed(identity.externalId))
      .digest();
    masterKey.fill(0);
    const bytes = Buffer.from(digest.subarray(0, 16));
    digest.fill(0);
    bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x80;
    bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
    const hex = bytes.toString("hex");
    bytes.fill(0);
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  encryptField(context: CallPiiContext, plaintext: string): EncryptedCallPiiField {
    assertField(context.field);
    const keyVersion = this.keyring.activeKeyVersion;
    const blindIndexKeyVersion = this.keyring.activeBlindIndexKeyVersion;
    const masterKey = this.keyring.encryptionKey(keyVersion);
    if (masterKey === undefined) throw new CallPiiConfigurationError("The active PII encryption key disappeared");
    const key = deriveFieldKey(masterKey, context.field, CALL_PII_FORMAT_VERSION);
    const nonce = randomBytes(GCM_NONCE_BYTES);
    const encoded = plaintextBuffer(plaintext);
    const blindIndex = this.computeBlindIndex(context, plaintext, blindIndexKeyVersion);
    const aad = authenticatedData(
      context,
      CALL_PII_FORMAT_VERSION,
      keyVersion,
      blindIndexKeyVersion,
      blindIndex,
    );
    const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: GCM_TAG_BYTES });
    cipher.setAAD(aad, { plaintextLength: encoded.length });
    const encrypted = Buffer.concat([cipher.update(encoded), cipher.final()]);
    const ciphertext = Buffer.concat([encrypted, cipher.getAuthTag()]);
    masterKey.fill(0);
    key.fill(0);
    return {
      formatVersion: CALL_PII_FORMAT_VERSION,
      keyVersion,
      blindIndexKeyVersion,
      nonce,
      ciphertext,
      blindIndex,
    };
  }

  decryptField(context: CallPiiContext, encrypted: EncryptedCallPiiField): string {
    let masterKey: Buffer | undefined;
    let key: Buffer | undefined;
    try {
      assertField(context.field);
      if (![LEGACY_CALL_PII_FORMAT_VERSION, CALL_PII_FORMAT_VERSION].includes(encrypted.formatVersion) ||
        !Number.isSafeInteger(encrypted.keyVersion) || encrypted.keyVersion <= 0 ||
        !Number.isSafeInteger(encrypted.blindIndexKeyVersion) || encrypted.blindIndexKeyVersion <= 0 ||
        encrypted.formatVersion === LEGACY_CALL_PII_FORMAT_VERSION &&
          encrypted.blindIndexKeyVersion !== LEGACY_BLIND_INDEX_KEY_VERSION ||
        !Buffer.isBuffer(encrypted.nonce) || encrypted.nonce.length !== GCM_NONCE_BYTES ||
        !Buffer.isBuffer(encrypted.ciphertext) || encrypted.ciphertext.length < GCM_TAG_BYTES ||
        !Buffer.isBuffer(encrypted.blindIndex) || encrypted.blindIndex.length !== 32) {
        throw new Error("Invalid encrypted envelope");
      }
      masterKey = this.keyring.encryptionKey(encrypted.keyVersion);
      if (masterKey === undefined || !this.keyring.hasBlindIndexKey(encrypted.blindIndexKeyVersion)) {
        throw new Error("Unknown key version");
      }
      key = deriveFieldKey(masterKey, context.field, encrypted.formatVersion);
      const encryptedLength = encrypted.ciphertext.length - GCM_TAG_BYTES;
      const ciphertext = encrypted.ciphertext.subarray(0, encryptedLength);
      const authTag = encrypted.ciphertext.subarray(encryptedLength);
      const decipher = createDecipheriv("aes-256-gcm", key, encrypted.nonce, { authTagLength: GCM_TAG_BYTES });
      decipher.setAAD(authenticatedData(
        context,
        encrypted.formatVersion,
        encrypted.keyVersion,
        encrypted.blindIndexKeyVersion,
        encrypted.blindIndex,
      ), { plaintextLength: encryptedLength });
      decipher.setAuthTag(authTag);
      const plaintext = new TextDecoder("utf-8", { fatal: true })
        .decode(Buffer.concat([decipher.update(ciphertext), decipher.final()]));
      const expectedBlindIndex = this.computeBlindIndex(
        context,
        plaintext,
        encrypted.blindIndexKeyVersion,
      );
      if (!timingSafeEqual(expectedBlindIndex, encrypted.blindIndex)) {
        expectedBlindIndex.fill(0);
        throw new Error("Blind index does not match authenticated plaintext");
      }
      expectedBlindIndex.fill(0);
      return plaintext;
    } catch {
      throw new CallPiiDecryptionError();
    } finally {
      masterKey?.fill(0);
      key?.fill(0);
    }
  }

  computeBlindIndex(
    context: CallPiiBlindIndexContext,
    normalizedValue: string,
    keyVersion = this.keyring.activeBlindIndexKeyVersion,
  ): Buffer {
    assertField(context.field);
    const organizationId = canonicalUuid(context.organizationId, "organizationId");
    if (!Number.isSafeInteger(keyVersion) || keyVersion <= 0) {
      throw new CallPiiConfigurationError("Blind-index key version must be a positive integer");
    }
    const encoded = plaintextBuffer(normalizedValue);
    const masterKey = this.keyring.blindIndexKey(keyVersion);
    if (masterKey === undefined) throw new CallPiiConfigurationError("Blind-index key version is not configured");
    const domain = keyVersion === LEGACY_BLIND_INDEX_KEY_VERSION
      ? `callora:call-log-pii:blind-index-key:v1:${context.field}`
      : `callora:call-log-pii:blind-index-key:v2:${keyVersion}:${context.field}`;
    const fieldKey = createHmac("sha256", masterKey).update(domain).digest();
    const index = createHmac("sha256", fieldKey)
      .update(lengthPrefixed(organizationId))
      .update(lengthPrefixed(context.field))
      .update(encoded)
      .digest();
    masterKey.fill(0);
    fieldKey.fill(0);
    return index;
  }

  /**
   * Produces one tenant-bound lookup value per configured blind-index key.
   * Callers can query `(key_version, blind_index)` pairs during rolling rotation
   * without ever falling back to plaintext or an unkeyed hash.
   */
  computeBlindIndexCandidates(
    context: CallPiiBlindIndexContext,
    normalizedValue: string,
  ): readonly BlindIndexCandidate[] {
    return [...this.keyring.configuredBlindIndexVersions]
      .sort((left, right) => right - left)
      .map((keyVersion) => ({
        keyVersion,
        blindIndex: this.computeBlindIndex(context, normalizedValue, keyVersion),
      }));
  }
}
