import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export function secretConfigurationProblem(): "secret_key_missing" | "secret_key_invalid" | null {
  const value = process.env.HOOR_SECRET_KEY;
  if (!value) return "secret_key_missing";
  return Buffer.from(value, "base64").length === 32 ? null : "secret_key_invalid";
}

function key() {
  const value = process.env.HOOR_SECRET_KEY;
  const problem = secretConfigurationProblem();
  if (problem === "secret_key_missing") throw new Error("HOOR_SECRET_KEY is required to store integration tokens");
  if (problem === "secret_key_invalid") throw new Error("HOOR_SECRET_KEY must contain 32 random bytes encoded as base64");
  const bytes = Buffer.from(value!, "base64");
  return bytes;
}

export function encryptSecret(plain: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), ciphertext].map((part) => part.toString("base64url")).join(".");
}

export function decryptSecret(value: string) {
  const [iv, tag, ciphertext] = value.split(".").map((part) => Buffer.from(part, "base64url"));
  if (!iv || !tag || !ciphertext) throw new Error("Invalid encrypted integration token");
  const decipher = createDecipheriv("aes-256-gcm", key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}
