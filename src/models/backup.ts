import { getCredentials } from "./credentials";
import { Encryption } from "./encryption";
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

export class Dropbox implements BackupProvider {
  private async refreshToken(): Promise<boolean> {
    await UserSettings.updateItems();
    if (!UserSettings.items.dropboxRefreshToken) {
      UserSettings.items.dropboxRevoked = true;
      UserSettings.commitItems();
      return false;
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
        encodeURIComponent(UserSettings.items.dropboxRefreshToken) +
        "&client_id=" +
        encodeURIComponent(getCredentials().dropbox.client_id),
    });
    if (res.status === 401) {
      UserSettings.items.dropboxRefreshToken = undefined;
      UserSettings.items.dropboxRevoked = true;
      UserSettings.commitItems();
      return false;
    }
    const data = await res.json();
    if (data.error) {
      if (data.error === "invalid_grant") {
        UserSettings.items.dropboxRefreshToken = undefined;
        UserSettings.items.dropboxRevoked = true;
        UserSettings.commitItems();
      }
      console.error(data.error_description);
      return false;
    }
    UserSettings.items.dropboxToken = data.access_token;
    UserSettings.commitItems();
    return true;
  }

  private async getToken(): Promise<string> {
    await UserSettings.updateItems();
    if (!UserSettings.items.dropboxToken) {
      const refreshed = await this.refreshToken();
      if (!refreshed) {
        return "";
      }
    }
    return UserSettings.items.dropboxToken || "";
  }

  async upload(encryption: Encryption) {
    // Never let a cloud backup carry plaintext secrets: require a master
    // password (which encrypts the export) before uploading anything.
    if (!cloudBackupAllowed(encryption)) {
      return false;
    }
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
    const token = await this.getToken();
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
      UserSettings.items.dropboxToken = undefined;
      UserSettings.commitItems();
      const refreshed = await this.refreshToken();
      if (!refreshed) {
        return false;
      }
      const newToken = UserSettings.items.dropboxToken || "";
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
          UserSettings.items.dropboxToken = undefined;
          UserSettings.items.dropboxRevoked = true;
          UserSettings.commitItems();
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
    await UserSettings.updateItems();
    const url = "https://api.dropboxapi.com/2/users/get_current_account";
    const token = await this.getToken();
    if (!token) {
      return "Error: No token";
    }
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": "application/json",
      },
      body: "null",
    });
    if (res.status === 401) {
      UserSettings.items.dropboxToken = undefined;
      UserSettings.items.dropboxRevoked = true;
      UserSettings.commitItems();
      return "Error: Response was 401. You will be logged out the next time you open OTPilot.";
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
