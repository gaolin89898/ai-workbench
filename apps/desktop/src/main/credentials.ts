import { app, safeStorage } from "electron";
import fs from "node:fs";
import path from "node:path";

const credentialsPath = path.join(app.getPath("userData"), "saved-credentials.json");

interface SavedCredentials {
  email: string;
  encryptedPassword: string;
}

export function saveCredentials(email: string, password: string): void {
  try {
    const encrypted = safeStorage.encryptString(password).toString("base64");
    const data: SavedCredentials = { email, encryptedPassword: encrypted };
    fs.writeFileSync(credentialsPath, JSON.stringify(data, null, 2), "utf-8");
  } catch (e) {
    console.error("Failed to save credentials:", e);
  }
}

export function loadCredentials(): { email: string; password: string } | null {
  try {
    if (!fs.existsSync(credentialsPath)) return null;
    const raw = fs.readFileSync(credentialsPath, "utf-8");
    const data = JSON.parse(raw) as SavedCredentials;
    if (!data.email || !data.encryptedPassword) return null;
    const password = safeStorage.decryptString(Buffer.from(data.encryptedPassword, "base64"));
    return { email: data.email, password };
  } catch {
    return null;
  }
}

export function clearCredentials(): void {
  try {
    if (fs.existsSync(credentialsPath)) {
      fs.unlinkSync(credentialsPath);
    }
  } catch (e) {
    console.error("Failed to clear credentials:", e);
  }
}
