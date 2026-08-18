import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

function keyFromSecret(secret) {
  return createHash("sha256").update(secret).digest();
}

export function encryptCredential(value, secret) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyFromSecret(secret), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", iv.toString("base64url"), tag.toString("base64url"), encrypted.toString("base64url")].join(".");
}

export function decryptCredential(payload, secret) {
  const [version, iv, tag, encrypted] = String(payload).split(".");
  if (version !== "v1" || !iv || !tag || !encrypted) throw new Error("无法解密数据源凭据");
  const decipher = createDecipheriv("aes-256-gcm", keyFromSecret(secret), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(encrypted, "base64url")), decipher.final()]).toString("utf8");
}
