import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";
import type { ReportArtifactReader, ReportArtifactStore } from "./report-worker.js";

export interface S3ArtifactConfig { endpoint: string; bucket: string; region: string; accessKeyId: string; secretAccessKey: string; encryptionKey: Uint8Array; maximumBytes?: number; }
function hash(value: string | Uint8Array): string { return createHash("sha256").update(value).digest("hex"); }
function hmac(key: string | Uint8Array, value: string): Buffer { return createHmac("sha256", key).update(value).digest(); }
function validKey(key: string): void { if (!/^[A-Za-z0-9/_-]+\.(csv|xlsx|pdf)$/.test(key) || key.includes("..")) throw new Error("Invalid artifact object key"); }

/** S3-compatible SigV4 adapter. Objects are encrypted client-side with AES-256-GCM. */
export class EncryptedS3ReportArtifactStore implements ReportArtifactStore, ReportArtifactReader {
  private readonly endpoint: URL; private readonly maximumBytes: number;
  constructor(private readonly config: S3ArtifactConfig, private readonly fetcher: typeof fetch = fetch) {
    this.endpoint = new URL(config.endpoint); this.maximumBytes = config.maximumBytes ?? 50 * 1024 * 1024;
    if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(config.bucket)) throw new Error("Invalid S3 bucket");
    if (config.encryptionKey.length !== 32) throw new Error("S3 artifact encryption key must be 32 bytes");
  }
  private async request(method: "GET" | "PUT", objectKey: string, body = new Uint8Array()): Promise<Response> {
    validKey(objectKey); const path = `/${this.config.bucket}/${objectKey.split("/").map(encodeURIComponent).join("/")}`; const url = new URL(path, this.endpoint); const now = new Date(); const stamp = now.toISOString().replace(/[:-]|\.\d{3}/g, ""); const day = stamp.slice(0, 8); const payloadHash = hash(body);
    const canonicalHeaders = `host:${url.host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${stamp}\n`; const signedHeaders = "host;x-amz-content-sha256;x-amz-date"; const canonical = `${method}\n${url.pathname}\n\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`; const scope = `${day}/${this.config.region}/s3/aws4_request`; const toSign = `AWS4-HMAC-SHA256\n${stamp}\n${scope}\n${hash(canonical)}`;
    const signingKey = hmac(hmac(hmac(hmac(`AWS4${this.config.secretAccessKey}`, day), this.config.region), "s3"), "aws4_request"); const signature = hmac(signingKey, toSign).toString("hex");
    return this.fetcher(url, { method, headers: { authorization: `AWS4-HMAC-SHA256 Credential=${this.config.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`, "x-amz-content-sha256": payloadHash, "x-amz-date": stamp, ...(method === "PUT" ? { "content-type": "application/octet-stream" } : {}) }, ...(method === "PUT" ? { body: Buffer.from(body) } : {}), redirect: "error" });
  }
  async put(objectKey: string, plaintext: Uint8Array): Promise<void> {
    if (plaintext.length > this.maximumBytes) throw new Error("Report artifact exceeds the upload size limit"); const nonce = randomBytes(12); const cipher = createCipheriv("aes-256-gcm", this.config.encryptionKey, nonce); cipher.setAAD(Buffer.from(objectKey)); const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]); const envelope = Buffer.concat([Buffer.from("CLR1"), nonce, cipher.getAuthTag(), encrypted]); const response = await this.request("PUT", objectKey, envelope); if (!response.ok) throw new Error(`S3 artifact upload failed (${response.status})`);
  }
  async get(objectKey: string): Promise<{ body: Uint8Array; contentType: string; fileName: string } | undefined> {
    const response = await this.request("GET", objectKey); if (response.status === 404) return undefined; if (!response.ok) throw new Error(`S3 artifact download failed (${response.status})`); const envelope = new Uint8Array(await response.arrayBuffer()); if (envelope.length > this.maximumBytes + 32) throw new Error("Report artifact exceeds the download size limit"); if (Buffer.from(envelope.subarray(0, 4)).toString() !== "CLR1") throw new Error("Invalid encrypted artifact envelope");
    const decipher = createDecipheriv("aes-256-gcm", this.config.encryptionKey, envelope.subarray(4, 16)); decipher.setAAD(Buffer.from(objectKey)); decipher.setAuthTag(envelope.subarray(16, 32)); const body = Buffer.concat([decipher.update(envelope.subarray(32)), decipher.final()]); const extension = objectKey.split(".").at(-1)!; return { body, contentType: extension === "csv" ? "text/csv; charset=utf-8" : extension === "xlsx" ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" : "application/pdf", fileName: `callora-report.${extension}` };
  }
}
