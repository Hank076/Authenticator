import { getCredentials } from "./credentials";
import { Encryption, isGcmCiphertext } from "./encryption";
import { UserSettings } from "./settings";
import { EntryStorage } from "./storage";
import { cloudBackupAllowed } from "../utils";

// Revoke a Dropbox grant. Dropbox's token/revoke disables the access token
// used for the call together with its refresh token, so a missing or expired
// access token is first replaced through the refresh token. Resolves true once
// Dropbox confirms the revoke.
export async function revokeDropboxTokens(
  accessToken?: string,
  refreshToken?: string,
): Promise<boolean> {
  const revoke = async (token: string) =>
    (
      await fetch("https://api.dropboxapi.com/2/auth/token/revoke", {
        method: "POST",
        headers: { Authorization: "Bearer " + token },
      })
    ).ok;

  if (accessToken && (await revoke(accessToken))) {
    return true;
  }
  if (!refreshToken) {
    return false;
  }
  const res = await fetch("https://api.dropboxapi.com/oauth2/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body:
      "grant_type=refresh_token" +
      "&refresh_token=" +
      encodeURIComponent(refreshToken) +
      "&client_id=" +
      encodeURIComponent(getCredentials().dropbox.client_id),
  });
  if (!res.ok) {
    return false;
  }
  const data = await res.json();
  return Boolean(data.access_token) && (await revoke(data.access_token));
}

interface DropboxTokens {
  accessToken?: string;
  refreshToken?: string;
}

// Dropbox tokens are stored encrypted under the master password key, like the
// entries. A value without the ciphertext prefix is a plaintext token an older
// version stored; it stays usable and is encrypted the next time a key is
// available. Without an unlocked key the encrypted tokens can't be read, so
// this returns nothing and leaves them stored.
export async function readDropboxTokens(
  encryption?: EncryptionInterface,
): Promise<DropboxTokens> {
  await UserSettings.updateItems();
  const stored = [
    UserSettings.items.dropboxToken,
    UserSettings.items.dropboxRefreshToken,
  ];
  const unlocked = Boolean(encryption?.getEncryptionStatus());
  if (!unlocked && stored.some((value) => value && isGcmCiphertext(value))) {
    return {};
  }
  const [accessToken, refreshToken] = await Promise.all(
    stored.map((value) =>
      value && isGcmCiphertext(value)
        ? (encryption as EncryptionInterface).getDecryptedString(value)
        : value,
    ),
  );
  if (accessToken === null || refreshToken === null) {
    // Encrypted under a key this vault no longer has: sign in again.
    await markDropboxRevoked();
    return {};
  }
  const tokens = {
    accessToken: accessToken || undefined,
    refreshToken: refreshToken || undefined,
  };
  if (unlocked && stored.some((value) => value && !isGcmCiphertext(value))) {
    await writeDropboxTokens(encryption as EncryptionInterface, tokens);
  }
  return tokens;
}

// Stores both tokens encrypted; getEncryptedString throws without a key, so a
// token is never written as plaintext.
export async function writeDropboxTokens(
  encryption: EncryptionInterface,
  tokens: DropboxTokens,
) {
  const [accessToken, refreshToken] = await Promise.all(
    [tokens.accessToken, tokens.refreshToken].map((token) =>
      token ? encryption.getEncryptedString(token) : undefined,
    ),
  );
  await UserSettings.updateItems();
  UserSettings.items.dropboxToken = accessToken;
  UserSettings.items.dropboxRefreshToken = refreshToken;
  await UserSettings.commitItems();
}

async function markDropboxRevoked() {
  await UserSettings.updateItems();
  delete UserSettings.items.dropboxToken;
  delete UserSettings.items.dropboxRefreshToken;
  UserSettings.items.dropboxRevoked = true;
  await UserSettings.commitItems();
}

export class Dropbox implements BackupProvider {
  constructor(private encryption?: EncryptionInterface) {}

  // Exchanges the refresh token for a new access token and stores it.
  // Resolves "" when there is no key, no refresh token, or Dropbox refused.
  private async refreshAccessToken(): Promise<string> {
    if (!this.encryption?.getEncryptionStatus()) {
      return "";
    }
    const { refreshToken } = await readDropboxTokens(this.encryption);
    if (!refreshToken) {
      await markDropboxRevoked();
      return "";
    }
    // PKCE-upgraded flow: refresh without client_secret
    const res = await fetch("https://api.dropboxapi.com/oauth2/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body:
        "grant_type=refresh_token" +
        "&refresh_token=" +
        encodeURIComponent(refreshToken) +
        "&client_id=" +
        encodeURIComponent(getCredentials().dropbox.client_id),
    });
    if (res.status === 401) {
      await markDropboxRevoked();
      return "";
    }
    const data = await res.json();
    if (data.error) {
      if (data.error === "invalid_grant") {
        await markDropboxRevoked();
      }
      console.error(data.error_description);
      return "";
    }
    await writeDropboxTokens(this.encryption, {
      accessToken: data.access_token,
      refreshToken,
    });
    return data.access_token;
  }

  private async getAccessToken(): Promise<string> {
    if (!this.encryption?.getEncryptionStatus()) {
      return "";
    }
    const { accessToken } = await readDropboxTokens(this.encryption);
    return accessToken || (await this.refreshAccessToken());
  }

  async upload(encryption: Encryption) {
    // Never let a cloud backup carry plaintext secrets: require a master
    // password (which encrypts the export) before uploading anything.
    if (!cloudBackupAllowed(encryption)) {
      return false;
    }
    this.encryption = encryption;
    await UserSettings.updateItems();

    if (UserSettings.items.dropboxEncrypted === undefined) {
      // Encrypt by default if user hasn't set yet
      UserSettings.items.dropboxEncrypted = true;
      UserSettings.commitItems();
    }
    const exportData = await EntryStorage.backupGetExport(
      encryption,
      UserSettings.items.dropboxEncrypted === true,
    );
    const backup = JSON.stringify(exportData, null, 2);

    const url = "https://content.dropboxapi.com/2/files/upload";
    const token = await this.getAccessToken();
    if (!token) {
      return false;
    }
    const now = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    const apiArg = {
      path: `/${now}.json`,
      mode: "add",
      autorename: true,
    };
    // fetch (not XMLHttpRequest) because upload runs in the MV3 background
    // service worker, where XHR is not defined.
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": "application/octet-stream",
        "Dropbox-API-Arg": JSON.stringify(apiArg),
      },
      body: backup,
    });
    if (res.status === 401) {
      // Token expired: try refresh once, then retry
      const newToken = await this.refreshAccessToken();
      if (!newToken) {
        return false;
      }
      const retryRes = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: "Bearer " + newToken,
          "Content-Type": "application/octet-stream",
          "Dropbox-API-Arg": JSON.stringify(apiArg),
        },
        body: backup,
      });
      if (!retryRes.ok) {
        if (retryRes.status === 401) {
          await markDropboxRevoked();
        }
        return false;
      }
      const retryBody = await retryRes.json();
      return Boolean(retryBody.name);
    }
    if (!res.ok) {
      // a non-2xx (5xx, HTML error page, ...) is a failed upload, not
      // something to JSON.parse and maybe misread as success. Surface
      // Dropbox's body so the actual cause (bad path / arg / scope) is visible.
      const detail = await res.text();
      throw new Error(
        "Dropbox upload failed: HTTP " + res.status + " " + detail,
      );
    }
    const body = await res.json();
    return Boolean(body.name);
  }

  async getUser() {
    const url = "https://api.dropboxapi.com/2/users/get_current_account";
    const request = (token: string) =>
      fetch(url, {
        method: "POST",
        headers: {
          Authorization: "Bearer " + token,
          "Content-Type": "application/json",
        },
        body: "null",
      });
    const token = await this.getAccessToken();
    if (!token) {
      return "Error: No token";
    }
    let res = await request(token);
    if (res.status === 401) {
      // Access tokens expire after a few hours; refresh once, then retry.
      const newToken = await this.refreshAccessToken();
      if (!newToken) {
        return "Error: Response was 401. You will be logged out the next time you open OTPilot.";
      }
      res = await request(newToken);
      if (res.status === 401) {
        await markDropboxRevoked();
        return "Error: Response was 401. You will be logged out the next time you open OTPilot.";
      }
    }
    try {
      const data = await res.json();
      if (data.email) {
        return data.email as string;
      } else {
        console.error("Could not find email in response.", data);
        return "Error: res.email was undefined.";
      }
    } catch (e) {
      console.error(e);
      return "Error";
    }
  }
}
