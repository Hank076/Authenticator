import { getCredentials } from "./models/credentials";
import { Encryption } from "./models/encryption";
import { BrowserStorage, EntryStorage, ManagedStorage } from "./models/storage";
import {
  Dropbox,
  readDropboxTokens,
  revokeDropboxTokens,
  writeDropboxTokens,
} from "./models/backup";
import {
  getSiteNameFromTab,
  getMatchedEntries,
  getCurrentTab,
  okToInjectContentScript,
} from "./utils";
import { CodeState } from "./models/otp";

import { getOTPAuthPerLineFromOPTAuthMigration } from "./models/migration";
import { isChrome, isFirefox } from "./browser";
import { UserSettings } from "./models/settings";
import { decodeQrFromImageData, computeQrCropRegion } from "./qr-decoder";
import {
  generateDropboxOAuthState,
  isCloudProviderEnabled,
  isValidDropboxOAuthState,
} from "./cloud-providers";

// Put back data a clearLogs rewrite left half done when the worker stopped.
void BrowserStorage.restoreInterruptedClearLogs().catch((error) =>
  console.error(
    "Restoring storage after an interrupted clearLogs failed",
    error,
  ),
);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Only act on messages from our own extension pages / content scripts, never
  // another extension. (No externally_connectable is set, so web pages can't
  // reach here, but this is cheap defense-in-depth for the sensitive actions
  // below — cache passphrase, cloud backup, lock.)
  if (sender.id !== chrome.runtime.id) {
    return false;
  }
  // Content scripts run inside web pages and only ever send getCapture. Every
  // other action (cache passphrase, lock, cloud backup, ...) must come from an
  // extension page, so a compromised content script can't drive them.
  const fromExtensionPage =
    sender.url?.startsWith(chrome.runtime.getURL("")) === true;
  if (message.action !== "getCapture" && !fromExtensionPage) {
    return false;
  }

  // The popup waits for the rewrite to finish before it continues.
  if (message.action === "clearLogs") {
    BrowserStorage.clearLogs()
      .catch((error) => console.error("clearLogs failed", error))
      .finally(() => sendResponse(true));
    return true;
  }

  // None of these handlers send a response, so do the async work fire-and-forget
  // and DON'T return true. Returning true kept the message channel open waiting
  // for a sendResponse that never came, so the sender's sendMessage promise
  // rejected with "message channel closed before a response was received"
  // (e.g. when a QR capture finds no code).
  void (async () => {
    await UserSettings.updateItems();

    if (message.action === "getCapture") {
      // Use sender.tab, not a module-level tab ref: in MV3 the service worker
      // can be torn down between framing the QR region and this message
      // arriving, leaving such a ref undefined -- so the capture reply was
      // never sent back and the scan silently did nothing. sender.tab is the
      // content script that asked, so it is always the right (and live) tab.
      if (!sender.tab || sender.tab.id === undefined) {
        return;
      }
      if (!(await claimCaptureGrant(sender.tab.id))) {
        return;
      }
      // Decode the QR here in the background rather than round-tripping the PNG
      // dataURL back to the content script: captureVisibleTab already hands us
      // the image, and keeping the @zxing decoder out of the injected content
      // script keeps content.js small (it is injected for autofill too, which
      // never scans a QR).
      await decodeCapture(
        sender.tab,
        message.info,
        hostnameFromTab(sender.tab),
      );
    } else if (message.action === "cachePassphrase") {
      chrome.storage.session.set({
        cachedPassphrase: message.value,
        cachedKeyId: message.keyId,
      });
      chrome.alarms.clear("autolock");
      setAutolock();
    } else if (isCloudProviderEnabled(message.action)) {
      getBackupToken(message.action);
    } else if (message.action === "lock") {
      chrome.storage.session.set({ cachedPassphrase: null, cachedKeyId: null });
    } else if (message.action === "resetAutolock") {
      chrome.alarms.clear("autolock");
      setAutolock();
    } else if (message.action === "updateContentTab") {
      // Persist in session storage so the autolock alarm can still reach this
      // tab to dismiss the capture overlay after the MV3 worker recycles.
      chrome.storage.session.set({ captureTabId: message.data?.id });
    } else if (message.action === "updateContextMenu") {
      updateContextMenu();
    }
  })();
  return false;
});

chrome.alarms.onAlarm.addListener(() => {
  void (async () => {
    await chrome.storage.session.set({
      cachedPassphrase: null,
      cachedKeyId: null,
    });
    // captureTabId is persisted in session storage (like the cached passphrase)
    // so it survives MV3 service-worker recycling. The old module-level tab ref
    // was undefined in a fresh worker, so a QR capture overlay left open stayed
    // stuck on the page after autolock. Dismiss it if a tab is still recorded.
    const { captureTabId } = await chrome.storage.session.get("captureTabId");
    if (typeof captureTabId === "number") {
      chrome.tabs
        .sendMessage(captureTabId, { action: "stopCapture" })
        .catch(() => undefined);
      await chrome.storage.session.remove("captureTabId");
    }
    chrome.runtime.sendMessage({ action: "stopImport" }).catch(() => undefined);
  })();
});

// A QR scan the user starts (popup or scan-qr command) records its tab in
// captureTabId. Each grant allows exactly one getCapture from that tab, so a
// page can't replay the overlay to import again. Claims run one at a time:
// two getCapture messages arriving together must not both read the grant
// before either removes it.
let captureGrantQueue: Promise<unknown> = Promise.resolve();

function claimCaptureGrant(tabId: number): Promise<boolean> {
  const claim = captureGrantQueue.then(async () => {
    const { captureTabId } = await chrome.storage.session.get("captureTabId");
    if (captureTabId !== tabId) {
      return false;
    }
    await chrome.storage.session.remove("captureTabId");
    return true;
  });
  captureGrantQueue = claim.catch(() => undefined);
  return claim;
}

// The host of the tab a QR scan was initiated from, used to pre-bind a newly
// imported entry to the site the user scanned it on.
function hostnameFromTab(tab?: chrome.tabs.Tab): string | undefined {
  if (!tab || !tab.url) {
    return undefined;
  }
  try {
    return new URL(tab.url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

async function getCapture(tab: chrome.tabs.Tab) {
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
    format: "png",
  });

  return dataUrl;
}

// Turn a base64 data: URL (as captureVisibleTab returns) into a Blob without a
// network request. fetch(dataUrl) would be simpler but is blocked by the
// extension's `default-src 'none'` / narrow connect-src CSP in the service
// worker; atob is CSP-agnostic.
function dataUrlToBlob(dataUrl: string): Blob {
  const commaIdx = dataUrl.indexOf(",");
  const header = dataUrl.slice(0, commaIdx);
  const mimeMatch = header.match(/data:([^;]+)/);
  const mime = mimeMatch ? mimeMatch[1] : "image/png";
  const binary = atob(dataUrl.slice(commaIdx + 1));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: mime });
}

// Capture the visible tab, crop the user's drag-selected region, and decode the
// QR — all in the background. On success feed the decoded otpauth string into
// the existing import path; on any failure tell the content script to show the
// "no QR" alert. createImageBitmap + OffscreenCanvas 2D are supported in both
// the Chrome MV3 service worker and the Firefox MV3 event page, so no DOM canvas
// is needed.
async function decodeCapture(
  tab: chrome.tabs.Tab,
  info: {
    captureBoxLeft: number;
    captureBoxTop: number;
    captureBoxWidth: number;
    captureBoxHeight: number;
    windowInnerWidth: number;
  },
  host?: string,
) {
  const tabId = tab.id;
  if (tabId === undefined) {
    return;
  }
  // The content tab may have navigated/closed; swallow a dead-channel rejection.
  const notifyError = () =>
    chrome.tabs
      .sendMessage(tabId, { action: "errorqr" })
      .catch(() => undefined);

  try {
    const dataUrl = await getCapture(tab);
    // Decode the base64 PNG dataURL to a Blob by hand rather than fetch(dataUrl):
    // the extension CSP is `default-src 'none'` with a narrow connect-src, so
    // fetching a data: URL from the service worker throws "Failed to fetch".
    const blob = dataUrlToBlob(dataUrl);
    const bitmap = await createImageBitmap(blob);
    const region = computeQrCropRegion(
      bitmap.width,
      bitmap.height,
      info.windowInnerWidth,
      info.captureBoxLeft,
      info.captureBoxTop,
      info.captureBoxWidth,
      info.captureBoxHeight,
    );
    if (!region) {
      notifyError();
      return;
    }
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) {
      notifyError();
      return;
    }
    ctx.drawImage(bitmap, 0, 0);
    const imageData = ctx.getImageData(
      region.sx,
      region.sy,
      region.sw,
      region.sh,
    );
    const qrText = decodeQrFromImageData(imageData);
    if (!qrText) {
      notifyError();
      return;
    }
    await getTotp(qrText, tabId, false, host);
  } catch (error) {
    console.error(error);
    notifyError();
  }
}

async function getTotp(
  text: string,
  tabId?: number,
  silent = false,
  host?: string,
) {
  // tabId is the content tab that initiated the scan (sender.tab.id). Relying on
  // a module-level tab ref here broke scans whenever the MV3 service worker had
  // been recycled (it was undefined -> silent return).
  if (tabId === undefined || !text) {
    return false;
  }
  const id = tabId;

  if (text.indexOf("otpauth://") !== 0) {
    if (text.indexOf("otpauth-migration://") === 0) {
      const otpUrls = getOTPAuthPerLineFromOPTAuthMigration(text);
      if (otpUrls.length === 0) {
        !silent && chrome.tabs.sendMessage(id, { action: "errorenc" });
        return false;
      }

      const getTotpPromises: Array<Promise<boolean>> = [];
      for (const otpUrl of otpUrls) {
        getTotpPromises.push(getTotp(otpUrl, id, true, host));
      }

      const getTotpResults = await Promise.allSettled(getTotpPromises);
      // allSettled entries are always-truthy {status,value} objects, so the
      // old `!res` test was never true and every import reported success.
      const failedCount = getTotpResults.filter(
        (res) => res.status !== "fulfilled" || !res.value,
      ).length;
      if (failedCount === otpUrls.length) {
        !silent && chrome.tabs.sendMessage(id, { action: "migrationfail" });
        return false;
      }

      if (failedCount > 0) {
        !silent &&
          chrome.tabs.sendMessage(id, { action: "migrationpartlyfail" });
        return true;
      }

      !silent && chrome.tabs.sendMessage(id, { action: "migrationsuccess" });
      return true;
    } else if (text === "error decoding QR Code") {
      !silent && chrome.tabs.sendMessage(id, { action: "errorqr" });
      return false;
    } else {
      !silent &&
        chrome.tabs.sendMessage(id, {
          action: "text",
          text: chrome.i18n.getMessage("error_not_otpauth"),
        });
      return true;
    }
  } else {
    let uri = text.split("otpauth://")[1];
    let type = uri.substr(0, 4).toLowerCase();
    uri = uri.substr(5);
    let label = uri.split("?")[0];
    const parameterPart = uri.split("?")[1];
    if (!label || !parameterPart) {
      !silent && chrome.tabs.sendMessage(id, { action: "errorqr" });
      return false;
    } else {
      let secret = "";
      let account: string | undefined;
      let issuer: string | undefined;
      let algorithm: string | undefined;
      let period: number | undefined;
      let digits: number | undefined;

      try {
        label = decodeURIComponent(label);
      } catch (error) {
        console.error(error);
      }
      if (label.indexOf(":") !== -1) {
        issuer = label.split(":")[0];
        account = label.split(":")[1];
      } else {
        account = label;
      }
      const parameters = parameterPart.split("&");
      const { cachedPassphrase, cachedKeyId } =
        await chrome.storage.session.get();
      parameters.forEach((item) => {
        const parameter = item.split("=");
        if (parameter[0].toLowerCase() === "secret") {
          secret = parameter[1];
        } else if (parameter[0].toLowerCase() === "issuer") {
          try {
            issuer = decodeURIComponent(parameter[1]);
          } catch {
            issuer = parameter[1];
          }
          issuer = issuer.replace(/\+/g, " ");
        } else if (parameter[0].toLowerCase() === "counter") {
          // let counter = Number(parameter[1]);
          // counter = isNaN(counter) || counter < 0 ? 0 : counter;
        } else if (parameter[0].toLowerCase() === "period") {
          period = Number(parameter[1]);
          period =
            isNaN(period) || period < 0 || period > 60 || 60 % period !== 0
              ? undefined
              : period;
        } else if (parameter[0].toLowerCase() === "digits") {
          digits = Number(parameter[1]);
          digits = isNaN(digits) || digits === 0 ? 6 : digits;
        } else if (parameter[0].toLowerCase() === "algorithm") {
          algorithm = parameter[1];
        }
      });

      if (!secret) {
        !silent && chrome.tabs.sendMessage(id, { action: "errorqr" });
        return false;
      } else if (
        !/^[0-9a-f]+$/i.test(secret) &&
        !/^[2-7a-z]+=*$/i.test(secret)
      ) {
        !silent && chrome.tabs.sendMessage(id, { action: "secretqr", secret });
        return false;
      } else {
        const encryption = new Encryption(
          cachedPassphrase as string,
          cachedKeyId as string,
        );
        const hash = crypto.randomUUID();
        if (
          !/^[2-7a-z]+=*$/i.test(secret) &&
          /^[0-9a-f]+$/i.test(secret) &&
          type === "totp"
        ) {
          type = "hex";
        } else if (
          !/^[2-7a-z]+=*$/i.test(secret) &&
          /^[0-9a-f]+$/i.test(secret) &&
          type === "hotp"
        ) {
          type = "hhex";
        }
        const entryData: { [hash: string]: RawOTPStorage } = {};
        entryData[hash] = {
          account,
          hash,
          issuer,
          host,
          secret,
          type,
          encrypted: false,
          index: 0,
          counter: 0,
          pinned: false,
        };
        if (period) {
          entryData[hash].period = period;
        }
        if (digits) {
          entryData[hash].digits = digits;
        }
        if (algorithm) {
          entryData[hash].algorithm = algorithm;
        }
        if (
          // If the entries are encrypted and we aren't unlocked, error.
          (await EntryStorage.hasEncryptionKey()) !==
          encryption.getEncryptionStatus()
        ) {
          !silent && chrome.tabs.sendMessage(id, { action: "errorenc" });
          return false;
        }
        if (await EntryStorage.isPasswordRequiredByPolicy()) {
          !silent &&
            chrome.tabs.sendMessage(id, {
              action: "text",
              text: chrome.i18n.getMessage("import_requires_password"),
            });
          return false;
        }
        await EntryStorage.import(encryption, entryData);
        !silent && chrome.tabs.sendMessage(id, { action: "added", account });
        return true;
      }
    }
  }
}

// Generate a PKCE code_verifier (43+ random URL-safe chars) and its
// code_challenge (base64url-encoded SHA-256 of the verifier).
async function generatePkce(): Promise<{
  codeVerifier: string;
  codeChallenge: string;
}> {
  const array = new Uint8Array(48);
  crypto.getRandomValues(array);
  // base64url-encode the random bytes for the verifier
  const codeVerifier = btoa(String.fromCharCode(...array))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");

  const encoder = new TextEncoder();
  const data = encoder.encode(codeVerifier);
  const digest = await crypto.subtle.digest("SHA-256", data);
  const codeChallenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");

  return { codeVerifier, codeChallenge };
}

function getBackupToken(service: string) {
  if (!isCloudProviderEnabled(service)) {
    return;
  }

  if (service === "dropbox") {
    // Upgrade from implicit flow to Authorization Code + PKCE (no secret).
    void (async () => {
      const { codeVerifier, codeChallenge } = await generatePkce();
      const redirUrl = chrome.identity.getRedirectURL();
      const state = generateDropboxOAuthState();
      const authUrl =
        "https://www.dropbox.com/oauth2/authorize" +
        "?response_type=code" +
        "&client_id=" +
        encodeURIComponent(getCredentials().dropbox.client_id) +
        "&redirect_uri=" +
        encodeURIComponent(redirUrl) +
        "&code_challenge=" +
        encodeURIComponent(codeChallenge) +
        "&code_challenge_method=S256" +
        "&token_access_type=offline" +
        "&state=" +
        encodeURIComponent(state);

      chrome.identity.launchWebAuthFlow(
        { url: authUrl, interactive: true },
        async (redirectedTo) => {
          if (!redirectedTo) {
            chrome.runtime
              .sendMessage({ action: "dropboxauthdone" })
              .catch(() => undefined);
            return;
          }
          // callback 必須帶回同一次授權請求的 state，否則不交換 token。
          let code: string | undefined;
          let callbackState: string | null = null;
          try {
            const parsedUrl = new URL(redirectedTo);
            code = parsedUrl.searchParams.get("code") ?? undefined;
            callbackState = parsedUrl.searchParams.get("state");
          } catch {
            /* invalid URL — fall through */
          }
          if (!code || !isValidDropboxOAuthState(state, callbackState)) {
            chrome.runtime
              .sendMessage({ action: "dropboxauthdone" })
              .catch(() => undefined);
            return;
          }

          // Exchange code for tokens (PKCE — no client_secret)
          try {
            const response = await fetch(
              "https://api.dropboxapi.com/oauth2/token",
              {
                method: "POST",
                headers: {
                  "Content-Type": "application/x-www-form-urlencoded",
                },
                body:
                  "code=" +
                  encodeURIComponent(code) +
                  "&code_verifier=" +
                  encodeURIComponent(codeVerifier) +
                  "&client_id=" +
                  encodeURIComponent(getCredentials().dropbox.client_id) +
                  "&redirect_uri=" +
                  encodeURIComponent(redirUrl) +
                  "&grant_type=authorization_code",
              },
            );
            if (!response.ok) {
              console.error(
                "Dropbox token exchange failed: HTTP " + response.status,
              );
              return;
            }
            const res = await response.json();
            if (!res.access_token) {
              console.error("Dropbox token exchange failed");
              return;
            }
            // Tokens are stored encrypted under the master password key. The
            // sign-in can take minutes; if the vault locked meanwhile, drop
            // the tokens rather than store them as plaintext.
            const { cachedPassphrase, cachedKeyId } =
              await chrome.storage.session.get();
            const encryption = new Encryption(
              cachedPassphrase as string,
              cachedKeyId as string,
            );
            if (!encryption.getEncryptionStatus()) {
              revokeDropboxTokens(res.access_token).catch(() => undefined);
              // caught below, which still reports dropboxauthdone
              throw new Error("Dropbox sign-in finished while locked");
            }
            const {
              accessToken: oldAccessToken,
              refreshToken: oldRefreshToken,
            } = await readDropboxTokens(encryption);
            await writeDropboxTokens(encryption, {
              accessToken: res.access_token,
              refreshToken: res.refresh_token,
            });
            await UserSettings.updateItems();
            UserSettings.items.dropboxRevoked = false;
            await UserSettings.commitItems();
            // Signing in again replaces the stored grant; revoke the old one
            // so it doesn't stay valid unseen. Skip it if Dropbox handed the
            // same token back, which would revoke the new grant too.
            if (
              (oldAccessToken || oldRefreshToken) &&
              oldAccessToken !== res.access_token &&
              oldRefreshToken !== res.refresh_token
            ) {
              revokeDropboxTokens(oldAccessToken, oldRefreshToken)
                .then((revoked) => {
                  if (!revoked) {
                    console.error("Revoking the previous Dropbox grant failed");
                  }
                })
                .catch((error) =>
                  console.error(
                    "Revoking the previous Dropbox grant failed",
                    error,
                  ),
                );
            }
            await uploadBackup("dropbox");
          } catch (error) {
            console.error("Dropbox token exchange failed", error);
          }
          chrome.runtime
            .sendMessage({ action: "dropboxauthdone" })
            .catch(() => undefined);
        },
      );
    })();
    return;
  }
}

async function uploadBackup(service: string) {
  if (!isCloudProviderEnabled(service)) {
    return;
  }

  const { cachedPassphrase, cachedKeyId } = await chrome.storage.session.get();
  const encryption = new Encryption(
    cachedPassphrase as string,
    cachedKeyId as string,
  );

  switch (service) {
    case "dropbox":
      await new Dropbox(encryption).upload(encryption);
      break;

    default:
      break;
  }
}

// Show issue page after first install
chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason !== "install") {
    return;
  } else if (await ManagedStorage.get("disableInstallHelp", false)) {
    return;
  }

  let url: string | null = null;

  if (isChrome) {
    url = "https://otp.ee/chromeissues";
  }

  if (url) {
    chrome.tabs.create({ url, active: true });
  }

  // https://stackoverflow.com/a/56483156
  return true;
});

chrome.commands.onCommand.addListener(async (command: string) => {
  const { cachedPassphrase, cachedKeyId } = await chrome.storage.session.get();

  let tab: chrome.tabs.Tab | undefined;

  switch (command) {
    case "scan-qr":
      if (cachedPassphrase === null || cachedPassphrase === undefined) {
        return;
      }

      tab = await getCurrentTab();
      if (okToInjectContentScript(tab)) {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ["/js/content.js"],
        });
        await chrome.scripting.insertCSS({
          target: { tabId: tab.id },
          files: ["/css/content.css"],
        });

        chrome.storage.session.set({ captureTabId: tab.id });
        chrome.tabs.sendMessage(tab.id, { action: "capture" });
      }
      break;

    case "autofill": {
      await UserSettings.updateItems();
      if (UserSettings.items.autofill !== true) {
        break;
      }
      tab = await getCurrentTab();
      if (!okToInjectContentScript(tab)) {
        break;
      }
      const encryption = new Encryption(
        cachedPassphrase as string,
        cachedKeyId as string,
      );
      // With a master password set, a locked vault never autofills, even an
      // entry that happens to be stored in plaintext.
      if (await EntryStorage.requiresUnlock(encryption)) {
        break;
      }
      const entries = await EntryStorage.get();
      // Encrypted entries keep their issuer and bound host inside the
      // ciphertext, so decrypt before matching.
      for (const entry of entries) {
        await entry.applyEncryption(encryption);
      }
      // strict=true: autofill pastes a live OTP, so don't trust the page title
      const matchedEntries = getMatchedEntries(
        getSiteNameFromTab(tab),
        entries,
        true,
      );
      if (!matchedEntries || matchedEntries.length !== 1) {
        break;
      }
      const entry = matchedEntries[0];
      if (
        entry.code === CodeState.Encrypted ||
        entry.code === CodeState.Invalid
      ) {
        break;
      }
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["/js/content.js"],
      });
      await chrome.scripting.insertCSS({
        target: { tabId: tab.id },
        files: ["/css/content.css"],
      });
      chrome.tabs.sendMessage(tab.id, {
        action: "pastecode",
        code: entry.code,
      });
      break;
    }

    default:
      break;
  }

  // https://stackoverflow.com/a/56483156
  return true;
});

async function setAutolock() {
  const enforcedAutolock = Number(
    await ManagedStorage.get("enforceAutolock", false),
  );

  if (enforcedAutolock && enforcedAutolock > 0) {
    chrome.alarms.create("autolock", { delayInMinutes: enforcedAutolock });
    return;
  }

  // Set default autolock value
  if (UserSettings.items.autolock === undefined) {
    UserSettings.items.autolock = 30;
  }

  if (Number(UserSettings.items.autolock) > 0) {
    chrome.alarms.create("autolock", {
      delayInMinutes: Number(UserSettings.items.autolock),
    });
  }
}

async function updateContextMenu() {
  chrome.permissions.contains(
    {
      permissions: ["contextMenus"],
    },
    (result) => {
      if (result) {
        if (UserSettings.items.enableContextMenu === true) {
          chrome.contextMenus.removeAll();
          chrome.contextMenus.create({
            id: "otpContextMenu",
            title: chrome.i18n.getMessage("extName"),
            contexts: ["all"],
          });
          chrome.contextMenus.onClicked.addListener((info, tab) => {
            let popupUrl = "view/popup.html?popup=true";
            if (tab && tab.url && tab.title) {
              popupUrl +=
                "&url=" +
                encodeURIComponent(tab.url) +
                "&title=" +
                encodeURIComponent(tab.title);
            }
            let windowType;
            if (isFirefox) {
              windowType = "detached_panel";
            } else {
              windowType = "panel";
            }
            chrome.windows.create({
              url: chrome.runtime.getURL(popupUrl),
              type: windowType as chrome.windows.CreateType,
              height: 400,
              width: 320,
            });

            // https://stackoverflow.com/a/56483156
            return true;
          });
        } else {
          chrome.contextMenus.removeAll();
        }
      }
    },
  );
}

updateContextMenu();
