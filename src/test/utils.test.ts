import "mocha";
import { expect } from "chai";
import { createPinia, setActivePinia } from "pinia";
import {
  getMatchedEntries,
  cloudBackupAllowed,
  getSiteNameFromTab,
  isSessionLockChange,
  shouldApplySearchFilter,
} from "../utils";
import * as sinon from "sinon";
import {
  BrowserStorage,
  EntryStorage,
  EntryWriteRefusedError,
  ManagedStorage,
  sameStoredValue,
} from "../models/storage";
import { StorageLocation, UserSettings } from "../models/settings";
import { useAccountsStore } from "../store/Accounts";
import { OTPEntry, OTPType, OTPAlgorithm } from "../models/otp";
import { Encryption, decryptString } from "../models/encryption";
import {
  getEntryDataFromOTPAuthPerLine,
  restoreEntryFromEnvelope,
} from "../import";
import { KeyUtilities } from "../models/key-utilities";
import { MultiFormatWriter, BarcodeFormat } from "@zxing/library";
import { decodeQrFromImageData, computeQrCropRegion } from "../qr-decoder";
import { isKnownArgonEncoding } from "../argon-params";
import { getOTPAuthPerLineFromOPTAuthMigration } from "../models/migration";
import { useAdvisorStore } from "../store/Advisor";
import { useBackupStore } from "../store/Backup";
import {
  readDropboxTokens,
  revokeDropboxTokens,
  writeDropboxTokens,
} from "../models/backup";
import {
  generateDropboxOAuthState,
  isCloudProviderEnabled,
  isValidDropboxOAuthState,
} from "../cloud-providers";

// getSiteName() returns [title, nameFromDomain, hostname]. autofill paths call
// getMatchedEntries(siteName, entries, strict=true). These tests pin the strict
// (host-bound) matching contract: a live OTP is only ever offered for a page
// whose real host matches the entry's bound host.
function site(
  hostname: string,
  nameFromDomain = "",
  title = "",
): Array<string | null> {
  return [title, nameFromDomain, hostname];
}

function entry(issuer: string, host?: string): OTPEntryInterface {
  return { issuer, host } as unknown as OTPEntryInterface;
}

describe("getMatchedEntries strict (host-bound autofill)", () => {
  it("matches when the bound host exactly equals the page host", () => {
    const entries = [entry("MyBank", "accounts.google.com")];
    const matched = getMatchedEntries(
      site("accounts.google.com", "google"),
      entries,
      true,
    );
    expect(matched).to.be.an("array").with.lengthOf(1);
  });

  it("matches a subdomain of the bound host", () => {
    const entries = [entry("MyBank", "google.com")];
    const matched = getMatchedEntries(
      site("accounts.google.com", "google"),
      entries,
      true,
    );
    expect(matched).to.be.an("array").with.lengthOf(1);
  });

  it("does NOT match when the bound host differs, even if the issuer name coincides with the page", () => {
    // issuer "Google" used to match the host "google" by name; with host
    // binding the mismatching bound host (mybank.com) must win and refuse.
    const entries = [entry("Google", "mybank.com")];
    const matched = getMatchedEntries(
      site("accounts.google.com", "google"),
      entries,
      true,
    );
    expect(matched).to.deep.equal([]);
  });

  it("does NOT match an attacker suffix of the bound host", () => {
    const entries = [entry("MyBank", "google.com")];
    const matched = getMatchedEntries(
      site("google.com.attacker.com", "attacker"),
      entries,
      true,
    );
    expect(matched).to.deep.equal([]);
  });

  it("does NOT autofill an entry that has no bound host", () => {
    // No host binding: even though the issuer name matches the page, strict
    // autofill must refuse to inject a live code.
    const entries = [entry("Google", undefined)];
    const matched = getMatchedEntries(
      site("google.com", "google"),
      entries,
      true,
    );
    expect(matched).to.deep.equal([]);
  });

  it("migrates a legacy issuer::host binding for strict matching", () => {
    // Upstream encoded the bound host in the issuer field as "Name::host".
    const entries = [entry("Google::google.com", undefined)];
    const matched = getMatchedEntries(
      site("accounts.google.com", "google"),
      entries,
      true,
    );
    expect(matched).to.be.an("array").with.lengthOf(1);
  });

  it("splits on the LAST :: when the issuer name itself contains ::", () => {
    // "My::Bank" is the issuer, "example.com" is the bound host. A naive
    // split("::") would wrongly cut it into issuer "My" + host "bank::example.com".
    const entries = [entry("My::Bank::example.com", undefined)];
    const matched = getMatchedEntries(
      site("example.com", "example"),
      entries,
      true,
    );
    expect(matched).to.be.an("array").with.lengthOf(1);
  });
});

describe("getMatchedEntries loose (display filtering)", () => {
  it("still matches by issuer name against the real host", () => {
    const entries = [entry("Google", undefined)];
    const matched = getMatchedEntries(
      site("google.com", "google"),
      entries,
      false,
    );
    expect(matched).to.be.an("array").with.lengthOf(1);
  });

  it("matches a multi-word issuer by its leading brand word in the title", () => {
    const entries = [entry("Unifi Ubiquiti SSO", undefined)];
    const page = site("192.168.1.1", "192.168.1.1", "unifios");
    expect(getMatchedEntries(page, entries, false)).to.have.lengthOf(1);
    // autofill never trusts the page title
    expect(getMatchedEntries(page, entries, true)).to.have.lengthOf(0);
  });

  it("ignores a short leading word", () => {
    const entries = [entry("My Company", undefined)];
    const page = site("example.test", "example", "mypage");
    expect(getMatchedEntries(page, entries, false)).to.have.lengthOf(0);
  });
});

// The background keyboard autofill has no document, so it derives the site
// name from the tab it already holds.
describe("getSiteNameFromTab", () => {
  it("normalizes the title and parses the host", () => {
    const tab = {
      title: "Sign in - Example!",
      url: "https://login.example.com/x",
    } as chrome.tabs.Tab;
    expect(getSiteNameFromTab(tab)).to.deep.equal([
      "signinexample",
      "example",
      "login.example.com",
    ]);
  });

  it("autofills a bound entry for its host", () => {
    const tab = {
      title: "Login",
      url: "https://accounts.example.com/",
    } as chrome.tabs.Tab;
    const entries = [entry("Example", "example.com")];
    expect(
      getMatchedEntries(getSiteNameFromTab(tab), entries, true),
    ).to.have.lengthOf(1);
  });
});

describe("shouldApplySearchFilter", () => {
  it("applies text filtering when the visible search field has input", () => {
    expect(shouldApplySearchFilter(false, "unifi")).to.equal(true);
  });

  it("does not apply text filtering when search is inactive and empty", () => {
    expect(shouldApplySearchFilter(false, "")).to.equal(false);
  });
});

// Open popup / import pages reload when this is true, so the secrets they
// decrypted while unlocked don't outlive a lock.
describe("isSessionLockChange", () => {
  it("detects the cached passphrase being cleared", () => {
    expect(
      isSessionLockChange(
        { cachedPassphrase: { oldValue: "pw", newValue: null } },
        "session",
      ),
    ).to.equal(true);
    expect(
      isSessionLockChange({ cachedPassphrase: { oldValue: "pw" } }, "session"),
    ).to.equal(true);
  });

  it("ignores unlocking and changing the passphrase", () => {
    expect(
      isSessionLockChange(
        { cachedPassphrase: { oldValue: null, newValue: "pw" } },
        "session",
      ),
    ).to.equal(false);
    expect(
      isSessionLockChange(
        { cachedPassphrase: { oldValue: "old", newValue: "new" } },
        "session",
      ),
    ).to.equal(false);
  });

  it("ignores a lock while already locked", () => {
    expect(
      isSessionLockChange(
        { cachedPassphrase: { oldValue: null, newValue: null } },
        "session",
      ),
    ).to.equal(false);
  });

  it("ignores other keys and storage areas", () => {
    expect(
      isSessionLockChange(
        { captureTabId: { oldValue: 1, newValue: undefined } },
        "session",
      ),
    ).to.equal(false);
    expect(
      isSessionLockChange(
        { cachedPassphrase: { oldValue: "pw", newValue: null } },
        "local",
      ),
    ).to.equal(false);
  });
});

// A cloud backup must never carry plaintext secrets off the device. Uploading
// is only permitted once a master password is set, so the export is encrypted
// before it leaves for Dropbox / Drive / OneDrive. cloudBackupAllowed only
// reads getEncryptionStatus(), so a tiny stub stands in for a real Encryption.
describe("cloudBackupAllowed (no plaintext cloud upload without a password)", () => {
  const withPassword = {
    getEncryptionStatus: () => true,
  } as unknown as EncryptionInterface;
  const withoutPassword = {
    getEncryptionStatus: () => false,
  } as unknown as EncryptionInterface;

  it("blocks cloud upload when no master password is set", () => {
    expect(cloudBackupAllowed(withoutPassword)).to.equal(false);
  });

  it("allows cloud upload once a master password is set", () => {
    expect(cloudBackupAllowed(withPassword)).to.equal(true);
  });

  it("blocks cloud upload when no encryption instance is provided", () => {
    expect(cloudBackupAllowed(undefined)).to.equal(false);
  });
});

describe("cloud provider security boundary", () => {
  it("only enables Dropbox", () => {
    expect(isCloudProviderEnabled("dropbox")).to.equal(true);
    expect(isCloudProviderEnabled("drive")).to.equal(false);
    expect(isCloudProviderEnabled("onedrive")).to.equal(false);
    expect(isCloudProviderEnabled("unknown")).to.equal(false);
  });

  it("accepts only the state from the same Dropbox OAuth request", () => {
    const state = generateDropboxOAuthState();
    expect(state).to.match(/^[0-9a-f]{32}$/);
    expect(isValidDropboxOAuthState(state, state)).to.equal(true);
    expect(isValidDropboxOAuthState(state, "different-state")).to.equal(false);
    expect(isValidDropboxOAuthState(state, null)).to.equal(false);
  });
});

// Dropbox's token/revoke disables the calling access token and its refresh
// token. Logging out with an expired or missing access token must still reach
// a successful revoke through the refresh token.
describe("revokeDropboxTokens", () => {
  const REVOKE = "https://api.dropboxapi.com/2/auth/token/revoke";
  const TOKEN = "https://api.dropboxapi.com/oauth2/token";
  let fetchStub: sinon.SinonStub;

  function respond(status: number, body: object = {}) {
    return new Response(JSON.stringify(body), { status });
  }

  function calls() {
    return fetchStub.getCalls().map((c) => ({
      url: c.args[0] as string,
      auth: (c.args[1]?.headers as Record<string, string>)?.Authorization,
    }));
  }

  beforeEach(() => {
    fetchStub = sinon.stub(window, "fetch");
  });

  afterEach(() => {
    sinon.restore();
  });

  it("revokes with a valid access token without refreshing", async () => {
    fetchStub.resolves(respond(200));
    expect(await revokeDropboxTokens("access", "refresh")).to.equal(true);
    expect(calls()).to.deep.equal([{ url: REVOKE, auth: "Bearer access" }]);
  });

  it("refreshes an expired access token, then revokes with the new one", async () => {
    fetchStub
      .onFirstCall()
      .resolves(respond(401))
      .onSecondCall()
      .resolves(respond(200, { access_token: "fresh" }))
      .onThirdCall()
      .resolves(respond(200));
    expect(await revokeDropboxTokens("expired", "refresh")).to.equal(true);
    expect(calls().map((c) => c.url)).to.deep.equal([REVOKE, TOKEN, REVOKE]);
    expect(calls()[2].auth).to.equal("Bearer fresh");
    expect(String(fetchStub.getCall(1).args[1]?.body)).to.include(
      "refresh_token=refresh",
    );
  });

  it("revokes through the refresh token when no access token is stored", async () => {
    fetchStub
      .onFirstCall()
      .resolves(respond(200, { access_token: "fresh" }))
      .onSecondCall()
      .resolves(respond(200));
    expect(await revokeDropboxTokens(undefined, "refresh")).to.equal(true);
    expect(calls()).to.deep.equal([
      { url: TOKEN, auth: undefined },
      { url: REVOKE, auth: "Bearer fresh" },
    ]);
  });

  it("reports failure when the refresh token is already invalid", async () => {
    fetchStub.resolves(respond(400, { error: "invalid_grant" }));
    expect(await revokeDropboxTokens(undefined, "refresh")).to.equal(false);
  });

  it("does nothing without tokens", async () => {
    expect(await revokeDropboxTokens()).to.equal(false);
    expect(fetchStub.called).to.equal(false);
  });
});

// Dropbox tokens are stored encrypted under the master password key; only
// the unlocked vault can read them, and plaintext from older versions is
// re-encrypted on the next read.
describe("encrypted Dropbox token storage", () => {
  const key = new Encryption("dummy-salted-hash", "dropbox-key-id");
  const otherKey = new Encryption("another-salted-hash", "other-key-id");
  const tokens = { accessToken: "sl.access", refreshToken: "refresh-token" };
  let originalUserSettings: unknown;

  async function stored() {
    await UserSettings.updateItems();
    return {
      access: UserSettings.items.dropboxToken,
      refresh: UserSettings.items.dropboxRefreshToken,
      revoked: UserSettings.items.dropboxRevoked,
    };
  }

  beforeEach(async () => {
    originalUserSettings = (await chrome.storage.local.get("UserSettings"))
      .UserSettings;
  });

  afterEach(async () => {
    if (originalUserSettings === undefined) {
      await chrome.storage.local.remove("UserSettings");
    } else {
      await chrome.storage.local.set({ UserSettings: originalUserSettings });
    }
    await UserSettings.updateItems();
  });

  it("stores ciphertext and reads it back with the same key", async () => {
    await writeDropboxTokens(key, tokens);
    const { access, refresh } = await stored();
    expect(access).to.match(/^v4:/);
    expect(refresh).to.match(/^v4:/);
    expect(await readDropboxTokens(key)).to.deep.equal(tokens);
  });

  it("leaves the tokens stored while locked", async () => {
    await writeDropboxTokens(key, tokens);
    const before = await stored();
    expect(await readDropboxTokens(new Encryption("", ""))).to.deep.equal({});
    expect(await readDropboxTokens(undefined)).to.deep.equal({});
    expect(await stored()).to.deep.equal(before);
  });

  it("signs out when the tokens belong to another key", async () => {
    await writeDropboxTokens(key, tokens);
    expect(await readDropboxTokens(otherKey)).to.deep.equal({});
    const { access, refresh, revoked } = await stored();
    expect(access).to.equal(undefined);
    expect(refresh).to.equal(undefined);
    expect(revoked).to.equal(true);
  });

  it("encrypts plaintext tokens from older versions on read", async () => {
    await UserSettings.updateItems();
    UserSettings.items.dropboxToken = tokens.accessToken;
    UserSettings.items.dropboxRefreshToken = tokens.refreshToken;
    await UserSettings.commitItems();

    expect(await readDropboxTokens(key)).to.deep.equal(tokens);
    const { access, refresh } = await stored();
    expect(access).to.match(/^v4:/);
    expect(refresh).to.match(/^v4:/);
  });

  it("refuses to store tokens without a key", async () => {
    let error: unknown;
    try {
      await writeDropboxTokens(new Encryption("", ""), tokens);
    } catch (e) {
      error = e;
    }
    expect(error).to.be.instanceOf(Error);
    const { access, refresh } = await stored();
    expect(access).to.not.equal(tokens.accessToken);
    expect(refresh).to.not.equal(tokens.refreshToken);
  });
});

describe("useBackupStore disabled provider token cleanup", () => {
  let originalUserSettings: unknown;

  beforeEach(async () => {
    originalUserSettings = (await chrome.storage.local.get("UserSettings"))
      .UserSettings;
  });

  afterEach(async () => {
    if (originalUserSettings === undefined) {
      await chrome.storage.local.remove("UserSettings");
    } else {
      await chrome.storage.local.set({ UserSettings: originalUserSettings });
    }
    await UserSettings.updateItems();
  });

  it("removes disabled provider tokens in one initialization while keeping preferences", async () => {
    await chrome.storage.local.set({
      UserSettings: {
        driveToken: "drive-access-token",
        driveRefreshToken: "drive-refresh-token",
        oneDriveToken: "onedrive-access-token",
        oneDriveRefreshToken: "onedrive-refresh-token",
        driveFolder: "backup-folder",
        oneDriveBusiness: true,
      },
    });

    setActivePinia(createPinia());
    const store = useBackupStore();
    await store.init();

    const stored = (await chrome.storage.local.get("UserSettings"))
      .UserSettings as {
      driveFolder?: string;
      oneDriveBusiness?: boolean;
    };
    expect(stored).to.not.have.property("driveToken");
    expect(stored).to.not.have.property("driveRefreshToken");
    expect(stored).to.not.have.property("oneDriveToken");
    expect(stored).to.not.have.property("oneDriveRefreshToken");
    expect(stored.driveFolder).to.equal("backup-folder");
    expect(stored.oneDriveBusiness).to.equal(true);
    expect(store.driveToken).to.equal(false);
    expect(store.oneDriveToken).to.equal(false);
  });
});

// In sync mode commitItems() rewrites both storage areas from
// UserSettings.items. removeItem used to load only one area's blob into items,
// so deleting a local key wiped every syncable setting (autolock included) and
// deleting a syncable key copied the sync blob over the local one.
describe("UserSettings.removeItem keeps both storage areas intact", () => {
  let originalLocal: unknown;
  let originalSync: unknown;

  async function readArea(area: "local" | "sync") {
    return (await chrome.storage[area].get("UserSettings")).UserSettings;
  }

  async function seed(local: object, sync: object) {
    await chrome.storage.local.set({ UserSettings: local });
    await chrome.storage.sync.set({ UserSettings: sync });
  }

  beforeEach(async () => {
    originalLocal = await readArea("local");
    originalSync = await readArea("sync");
  });

  afterEach(async () => {
    for (const [area, original] of [
      ["local", originalLocal],
      ["sync", originalSync],
    ] as const) {
      if (original === undefined) {
        await chrome.storage[area].remove("UserSettings");
      } else {
        await chrome.storage[area].set({ UserSettings: original });
      }
    }
    await UserSettings.updateItems();
  });

  describe("sync mode", () => {
    const local = {
      storageLocation: "sync",
      dropboxToken: "dummy-access",
      dropboxRefreshToken: "dummy-refresh",
      dropboxRevoked: true,
      offset: 3,
    };
    const sync = {
      autolock: 1,
      autofill: true,
      smartFilter: false,
      encodedPhrase: "dummy-legacy",
    };

    it("deletes a local key without touching the sync area", async () => {
      await seed(local, sync);
      await UserSettings.removeItem("dropboxRevoked");

      const { dropboxRevoked: _removed, ...expectedLocal } = local;
      expect(await readArea("local")).to.deep.equal(expectedLocal);
      expect(await readArea("sync")).to.deep.equal(sync);
    });

    it("deletes a syncable key without touching the local area", async () => {
      await seed(local, sync);
      await UserSettings.removeItem("encodedPhrase");

      const { encodedPhrase: _removed, ...expectedSync } = sync;
      expect(await readArea("local")).to.deep.equal(local);
      expect(await readArea("sync")).to.deep.equal(expectedSync);
    });
  });

  describe("local mode", () => {
    const local = {
      storageLocation: "local",
      dropboxToken: "dummy-access",
      dropboxRevoked: true,
      autolock: 1,
      encodedPhrase: "dummy-legacy",
    };
    const sync = { autolock: 5, theme: "dummy-sentinel" };

    it("deletes a local key and leaves the sync area alone", async () => {
      await seed(local, sync);
      await UserSettings.removeItem("dropboxRevoked");

      const { dropboxRevoked: _removed, ...expectedLocal } = local;
      expect(await readArea("local")).to.deep.equal(expectedLocal);
      expect(await readArea("sync")).to.deep.equal(sync);
    });

    it("deletes a syncable key and leaves the sync area alone", async () => {
      await seed(local, sync);
      await UserSettings.removeItem("encodedPhrase");

      const { encodedPhrase: _removed, ...expectedLocal } = local;
      expect(await readArea("local")).to.deep.equal(expectedLocal);
      expect(await readArea("sync")).to.deep.equal(sync);
    });
  });
});

// The bound host must survive a storage round-trip (save -> reload). Without a
// master password an entry is stored as plaintext and rebuilt via the explicit
// field list in EntryStorage.get(), which used to drop the host field.
describe("EntryStorage preserves the bound host across reload", () => {
  it("keeps entry.host after add() and get()", async () => {
    const entry = new OTPEntry({
      type: OTPType.totp,
      index: 0,
      issuer: "MyBank",
      host: "accounts.example.com",
      account: "user",
      encrypted: false,
      secret: "AAAAAAAAAAAAAAAA",
    });
    try {
      await EntryStorage.add(entry);
      const reloaded = (await EntryStorage.get()).find(
        (e) => e.hash === entry.hash,
      );
      expect(reloaded && reloaded.host).to.equal("accounts.example.com");
    } finally {
      await EntryStorage.delete(entry);
    }
  });
});

// Backups encode the bound host into issuer as "issuer::host" (upstream
// convention) instead of a separate host field, so the website survives a
// round-trip through import's migrateLegacyHost.
describe("EntryStorage.getExport encodes the bound host into issuer", () => {
  it("emits issuer::host with no separate host field, and it round-trips", async () => {
    const entry = new OTPEntry({
      type: OTPType.totp,
      index: 0,
      issuer: "MyBank",
      host: "accounts.example.com",
      account: "user",
      encrypted: false,
      secret: "AAAAAAAAAAAAAAAA",
    });
    const exported = (await EntryStorage.getExport([entry], false)) as {
      [hash: string]: RawOTPStorage;
    };
    const item = exported[entry.hash];
    expect(item.issuer).to.equal("MyBank::accounts.example.com");
    expect(item.host).to.equal(undefined);

    // import side restores the dedicated host field
    const restored = new OTPEntry({
      type: OTPType.totp,
      index: 0,
      issuer: item.issuer,
      host: item.host,
      account: "user",
      encrypted: false,
      secret: "AAAAAAAAAAAAAAAA",
    });
    expect(restored.issuer).to.equal("MyBank");
    expect(restored.host).to.equal("accounts.example.com");
  });

  it("round-trips an issuer that itself contains :: by splitting on the LAST ::", async () => {
    // A naive split("::") on "My::Bank::example.com" would wrongly produce
    // issuer "My" + host "bank::example.com" and corrupt the issuer name.
    const entry = new OTPEntry({
      type: OTPType.totp,
      index: 0,
      issuer: "My::Bank",
      host: "example.com",
      account: "user",
      encrypted: false,
      secret: "AAAAAAAAAAAAAAAA",
    });
    const exported = (await EntryStorage.getExport([entry], false)) as {
      [hash: string]: RawOTPStorage;
    };
    const item = exported[entry.hash];
    expect(item.issuer).to.equal("My::Bank::example.com");

    const restored = new OTPEntry({
      type: OTPType.totp,
      index: 0,
      issuer: item.issuer,
      host: item.host,
      account: "user",
      encrypted: false,
      secret: "AAAAAAAAAAAAAAAA",
    });
    expect(restored.issuer).to.equal("My::Bank");
    expect(restored.host).to.equal("example.com");
  });
});

// The otpauth:// URI export carries the bound host on the issuer parameter as
// "issuer::host"; import must parse it back and migrateLegacyHost splits it
// into the dedicated host field.
describe("getEntryDataFromOTPAuthPerLine parses issuer::host", () => {
  it("restores the bound host from the issuer parameter", async () => {
    const uri =
      "otpauth://totp/Mozilla:user%2Bfirefox%40gmail.com" +
      "?secret=AAAAAAAAAAAAAAAA&issuer=Mozilla::accounts.example.com";
    const { exportData } = await getEntryDataFromOTPAuthPerLine(uri);
    const item = Object.values(exportData)[0];
    expect(item.issuer).to.equal("Mozilla::accounts.example.com");

    const entry = new OTPEntry({
      type: OTPType.totp,
      index: 0,
      issuer: item.issuer,
      account: item.account,
      encrypted: false,
      secret: item.secret,
    });
    expect(entry.issuer).to.equal("Mozilla");
    expect(entry.host).to.equal("accounts.example.com");
  });
});

// backupGetExport used to unconditionally `continue` on EncOTPStorage entries
// (encrypted accounts), even when asked for a *plaintext* export. That left
// AES-GCM ciphertext sitting inside an "unencrypted" backup: the importer has
// no passphrase to unlock it, so the account was silently lost on restore.
describe("EntryStorage.backupGetExport decrypts EncOTPStorage entries for a plaintext export", () => {
  it("round-trips an encrypted account through a plaintext backup export and back through import", async () => {
    const encryption = new Encryption(
      "p0-round-trip-test-password-hash",
      "p0-round-trip-test-key-id",
    );
    const originalSecret = "AAAAAAAAAAAAAAAA";

    const entry = new OTPEntry(
      {
        type: OTPType.totp,
        index: 0,
        issuer: "P0TestBank",
        account: "user",
        encrypted: false,
        secret: originalSecret,
      },
      encryption,
    );

    try {
      // With a password-bearing encryption instance, this is persisted as an
      // EncOTPStorage (AES-GCM ciphertext) record, not a plain RawOTPStorage.
      await EntryStorage.add(entry);

      const exported = (await EntryStorage.backupGetExport(
        encryption,
        false, // encrypted=false -> plaintext export
      )) as { [hash: string]: RawOTPStorage };

      const item = exported[entry.hash];
      expect(item, "exported entry should be present").to.exist;
      expect(item.secret).to.equal(originalSecret);
      expect(item.encrypted).to.equal(false);
      // Must not carry dataType/keyId forward, or FileImport.vue will treat
      // this plaintext entry as ciphertext requiring a passphrase.
      expect((item as { dataType?: string }).dataType).to.equal(undefined);
      expect(item.keyId).to.equal(undefined);

      // Restore side: import must accept it as a plain entry, no passphrase.
      const importEncryption = new Encryption("", "");
      await EntryStorage.import(importEncryption, { [entry.hash]: item });

      const restored = (await EntryStorage.get()).find(
        (e) => e.hash === entry.hash,
      );
      expect(restored, "restored entry should be present").to.exist;
      expect(restored && restored.secret).to.equal(originalSecret);
      expect(restored && restored.issuer).to.equal("P0TestBank");

      if (restored) {
        await EntryStorage.delete(restored);
      }
    } finally {
      await EntryStorage.delete(entry);
    }
  });
});

// AES-GCM only authenticates an EncOTPStorage's `data`. Whoever holds the
// backup file can add fields to the outer JSON without the password; a restore
// must ignore them, or an injected `host` would rebind a real secret's
// host-bound autofill to the attacker's site.
describe("restoreEntryFromEnvelope ignores unauthenticated envelope fields", () => {
  const plaintext = {
    dataType: "OTPStorage",
    hash: "11111111-2222-4333-8444-555555555555",
    index: 3,
    type: "totp",
    secret: "JBSWY3DPEHPK3PXP",
    issuer: "Bank::bank.test",
    account: "user",
    encrypted: false,
  };

  it("keeps only the decrypted fields when the envelope carries extras", () => {
    const tampered = {
      dataType: "EncOTPStorage",
      keyId: "key-id",
      data: "v4:unchanged-ciphertext",
      index: 9,
      host: "evil.test",
      digits: 8,
      algorithm: "SHA512",
      period: 60,
    } as unknown as EncOTPStorage;

    const restored = restoreEntryFromEnvelope(tampered, plaintext);
    expect(restored).to.deep.equal({ ...plaintext, encrypted: false });
  });

  it("falls back to the envelope index only when the plaintext has none", () => {
    const { index: _omit, ...withoutIndex } = plaintext;
    const envelope = {
      dataType: "EncOTPStorage",
      keyId: "key-id",
      data: "v4:x",
      index: 7,
    } as EncOTPStorage;
    expect(restoreEntryFromEnvelope(envelope, withoutIndex)?.index).to.equal(7);
  });

  it("rejects decrypted values that are not objects", () => {
    const envelope = {
      dataType: "EncOTPStorage",
      keyId: "key-id",
      data: "v4:x",
      index: 0,
    } as EncOTPStorage;
    expect(restoreEntryFromEnvelope(envelope, null)).to.equal(null);
    expect(restoreEntryFromEnvelope(envelope, [plaintext])).to.equal(null);
    expect(restoreEntryFromEnvelope(envelope, "secret")).to.equal(null);
  });
});

// enforcePassword promises no account is added before a master password
// exists. The popup only gates its own buttons, so the storage write paths
// (import page, QR capture, manual add) must enforce the policy themselves.
describe("EntryStorage enforces the enforcePassword policy on writes", () => {
  const hash = "99999999-8888-4777-8666-555555555555";
  const raw: RawOTPStorage = {
    hash,
    index: 0,
    type: "totp",
    secret: "JBSWY3DPEHPK3PXP",
    issuer: "PolicyTest",
    account: "user",
    encrypted: false,
  };

  afterEach(async () => {
    sinon.restore();
    const leftover = (await EntryStorage.get()).find((e) => e.hash === hash);
    if (leftover) {
      await EntryStorage.delete(leftover);
    }
  });

  it("refuses to import without a password when the policy is set", async () => {
    sinon.stub(ManagedStorage, "get").resolves(true);
    sinon.stub(EntryStorage, "hasEncryptionKey").resolves(false);

    let error: unknown;
    try {
      await EntryStorage.import(new Encryption("", ""), { [hash]: raw });
    } catch (e) {
      error = e;
    }
    expect(error).to.be.instanceOf(EntryWriteRefusedError);
    expect((error as EntryWriteRefusedError).messageKey).to.equal(
      "import_requires_password",
    );
    const stored = (await EntryStorage.get()).find((e) => e.hash === hash);
    expect(stored, "nothing may be written").to.equal(undefined);
  });

  it("refuses to add a single entry without a password when the policy is set", async () => {
    sinon.stub(ManagedStorage, "get").resolves(true);
    sinon.stub(EntryStorage, "hasEncryptionKey").resolves(false);
    const entry = new OTPEntry(
      {
        type: OTPType.totp,
        index: 0,
        issuer: "PolicyTest",
        account: "user",
        encrypted: false,
        secret: "JBSWY3DPEHPK3PXP",
      },
      new Encryption("", ""),
    );

    let error: unknown;
    try {
      await EntryStorage.add(entry);
    } catch (e) {
      error = e;
    }
    expect(error).to.be.instanceOf(Error);
  });

  it("reports whether the policy blocks writes", async () => {
    const get = sinon.stub(ManagedStorage, "get").resolves(true);
    const hasKey = sinon.stub(EntryStorage, "hasEncryptionKey").resolves(false);
    expect(await EntryStorage.isPasswordRequiredByPolicy()).to.equal(true);

    hasKey.resolves(true);
    expect(await EntryStorage.isPasswordRequiredByPolicy()).to.equal(false);

    get.resolves(false);
    hasKey.resolves(false);
    expect(await EntryStorage.isPasswordRequiredByPolicy()).to.equal(false);
  });
});

// BrowserStorage.get() hides Key records, so EntryStorage.import could not see
// them: an imported entry whose storage key (the outer key or the inner `hash`)
// matched a Key id, or the v2 name `key`, replaced the master password's Key
// record and left every encrypted secret undecryptable.
describe("EntryStorage.import never overwrites a Key record", () => {
  const keyId = "11111111-2222-4333-8444-555555555555";
  const keyRecord: Key = {
    dataType: "Key",
    id: keyId,
    salt: "dummy-salt",
    hash: "dummy-argon2-hash",
    version: 3,
  };
  const password = "dummy-salted-hash";
  const secret = "JBSWY3DPEHPK3PXP";
  const uuidPattern =
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
  let entryKeysBefore: string[];

  function payload(hash?: string) {
    return {
      secret,
      type: "totp",
      account: "dummy-attacker",
      issuer: "Dummy",
      ...(hash ? { hash } : {}),
    } as RawOTPStorage;
  }

  async function importedKeys() {
    return Object.keys(await BrowserStorage.get()).filter(
      (k) => k !== "UserSettings" && !entryKeysBefore.includes(k),
    );
  }

  // The import must land as one new entry under a fresh UUID whose encrypted
  // payload carries the same hash, or the popup cannot unlock it.
  async function expectSingleEntryUnderFreshUuid(...forbidden: string[]) {
    const added = await importedKeys();
    expect(added).to.have.length(1);
    expect(added[0]).to.match(uuidPattern);
    expect(forbidden).to.not.include(added[0]);

    const stored = (await BrowserStorage.get())[added[0]] as EncOTPStorage;
    expect(stored.dataType).to.equal("EncOTPStorage");
    const inner = JSON.parse(
      (await decryptString(stored.data, password)) || "",
    );
    expect(inner.hash).to.equal(added[0]);
    expect(inner.secret).to.equal(secret);
  }

  beforeEach(async () => {
    entryKeysBefore = Object.keys(await BrowserStorage.get());
  });

  afterEach(async () => {
    await BrowserStorage.remove([keyId, "key", ...(await importedKeys())]);
  });

  describe("with a v3 Key record", () => {
    const unlocked = new Encryption(password, keyId);

    beforeEach(async () => {
      await BrowserStorage.set({ [keyId]: keyRecord });
    });

    async function expectKeyIntact() {
      expect(await BrowserStorage.getKeys()).to.deep.equal([keyRecord]);
      expect(await EntryStorage.hasEncryptionKey()).to.equal(true);
    }

    it("re-keys an entry whose outer key is the Key id", async () => {
      await EntryStorage.import(unlocked, { [keyId]: payload() });
      await expectKeyIntact();
      await expectSingleEntryUnderFreshUuid(keyId);
    });

    it("re-keys an entry whose inner hash is the Key id", async () => {
      await EntryStorage.import(unlocked, {
        "99999999-8888-4777-8666-555555555555": payload(keyId),
      });
      await expectKeyIntact();
      await expectSingleEntryUnderFreshUuid(
        keyId,
        "99999999-8888-4777-8666-555555555555",
      );
    });

    it("re-keys an entry whose inner hash is not a UUID", async () => {
      await EntryStorage.import(unlocked, {
        "99999999-8888-4777-8666-555555555555": payload("UserSettings"),
      });
      await expectKeyIntact();
      await expectSingleEntryUnderFreshUuid(
        "UserSettings",
        "99999999-8888-4777-8666-555555555555",
      );
    });

    it("keeps the hash of an ordinary UUID entry", async () => {
      const hash = "22222222-3333-4444-8555-666666666666";
      await EntryStorage.import(unlocked, { [hash]: payload() });
      await expectKeyIntact();
      expect(await importedKeys()).to.deep.equal([hash]);
    });
  });

  describe("with a v2 `key` record", () => {
    const oldKey: OldKey = { enc: "dummy-enc", hash: "dummy-hash" };

    beforeEach(async () => {
      await BrowserStorage.set({ key: oldKey });
    });

    it("re-keys an entry whose inner hash is `key`", async () => {
      await EntryStorage.import(new Encryption(password, "dummy-v2-key-id"), {
        "99999999-8888-4777-8666-555555555555": payload("key"),
      });
      expect(await BrowserStorage.getKeys()).to.deep.equal(oldKey);
      await expectSingleEntryUnderFreshUuid(
        "key",
        "99999999-8888-4777-8666-555555555555",
      );
    });

    // An interrupted v2 -> v3 migration leaves `key` and a v3 Key together;
    // getKeys() then reports only the v2 key.
    it("re-keys an entry whose inner hash is a v3 Key id next to it", async () => {
      await BrowserStorage.set({ [keyId]: keyRecord });
      await EntryStorage.import(new Encryption(password, keyId), {
        "99999999-8888-4777-8666-555555555555": payload(keyId),
      });
      expect(await BrowserStorage.getKeyRecordIds()).to.deep.equal([keyId]);
      await expectSingleEntryUnderFreshUuid(
        keyId,
        "99999999-8888-4777-8666-555555555555",
      );
    });
  });
});

// With a master password set, a locked Encryption (no cached key, e.g. an
// import page opened after autolock) made getOTPStorageFromEntry store the
// secret as plaintext. The write paths must refuse instead, while users
// without a password keep importing and adding as before.
describe("EntryStorage refuses plaintext writes while the master password is locked", () => {
  const keyId = "33333333-4444-4555-8666-777777777777";
  const keyRecord: Key = {
    dataType: "Key",
    id: keyId,
    salt: "dummy-salt",
    hash: "dummy-argon2-hash",
    version: 3,
  };
  const hash = "44444444-5555-4666-8777-888888888888";
  const raw: RawOTPStorage = {
    hash,
    index: 0,
    type: "totp",
    secret: "JBSWY3DPEHPK3PXP",
    issuer: "LockTest",
    account: "user",
    encrypted: false,
  };

  function newEntry(encryption?: Encryption) {
    return new OTPEntry(
      {
        type: OTPType.totp,
        index: 0,
        issuer: "LockTest",
        account: "user",
        encrypted: false,
        secret: raw.secret,
        hash,
      },
      encryption,
    );
  }

  async function snapshot() {
    return {
      entries: await BrowserStorage.get(),
      keys: await BrowserStorage.getKeys(),
    };
  }

  async function expectRejected(write: () => Promise<void>) {
    let error: unknown;
    try {
      await write();
    } catch (e) {
      error = e;
    }
    expect(error).to.be.instanceOf(EntryWriteRefusedError);
    expect((error as EntryWriteRefusedError).messageKey).to.equal(
      "import_error_password",
    );
  }

  afterEach(async () => {
    await BrowserStorage.remove([keyId, hash]);
  });

  describe("with a Key record", () => {
    beforeEach(async () => {
      await BrowserStorage.set({ [keyId]: keyRecord });
    });

    it("refuses to import and leaves storage unchanged", async () => {
      const before = await snapshot();
      await expectRejected(() =>
        EntryStorage.import(new Encryption("", ""), { [hash]: { ...raw } }),
      );
      expect(await snapshot()).to.deep.equal(before);
    });

    it("refuses to add with a locked or missing encryption", async () => {
      const before = await snapshot();
      await expectRejected(() =>
        EntryStorage.add(newEntry(new Encryption("", ""))),
      );
      await expectRejected(() => EntryStorage.add(newEntry()));
      expect(await snapshot()).to.deep.equal(before);
    });

    it("reports that the import page must stay locked", async () => {
      expect(
        await EntryStorage.requiresUnlock(new Encryption("", "")),
      ).to.equal(true);
      expect(
        await EntryStorage.requiresUnlock(new Encryption("dummy-hash", keyId)),
      ).to.equal(false);
    });
  });

  describe("without a Key record", () => {
    it("imports a plaintext entry as before", async () => {
      expect(await EntryStorage.hasEncryptionKey()).to.equal(false);
      expect(
        await EntryStorage.requiresUnlock(new Encryption("", "")),
      ).to.equal(false);

      await EntryStorage.import(new Encryption("", ""), { [hash]: { ...raw } });
      const stored = (await BrowserStorage.get())[hash] as RawOTPStorage;
      expect(stored.secret).to.equal(raw.secret);
      expect(stored.encrypted).to.equal(false);
    });

    it("adds a plaintext entry as before", async () => {
      await EntryStorage.add(newEntry());
      const stored = (await BrowserStorage.get())[hash] as RawOTPStorage;
      expect(stored.secret).to.equal(raw.secret);
    });
  });
});

// Plaintext entries can sit next to a Key record (browser sync, or an import
// page opened before the password existed). Encrypted exports used to copy
// them verbatim, so a backup labelled "encrypted" carried plaintext secrets.
describe("encrypted exports never carry plaintext secrets", () => {
  const keyId = "55555555-6666-4777-8888-999999999999";
  const keyRecord: Key = {
    dataType: "Key",
    id: keyId,
    salt: "dummy-salt",
    hash: "dummy-argon2-hash",
    version: 3,
  };
  const password = "dummy-export-salted-hash";
  const unlocked = new Encryption(password, keyId);
  const plainHash = "66666666-7777-4888-9999-aaaaaaaaaaaa";
  const legacyHash = "77777777-8888-4999-8aaa-bbbbbbbbbbbb";
  const plainSecret = "JBSWY3DPEHPK3PXP";
  const encSecret = "GEZDGNBVGY3TQOJQ";
  const legacyCiphertext = "U2FsdGVkX1dummy-legacy-ciphertext";
  let encHash: string;

  async function decryptInner(item: OTPStorage) {
    expect(item.dataType).to.equal("EncOTPStorage");
    const encItem = item as EncOTPStorage;
    expect(encItem.keyId).to.equal(keyId);
    return JSON.parse((await decryptString(encItem.data, password)) || "");
  }

  beforeEach(async () => {
    await BrowserStorage.set({ [keyId]: keyRecord });
    const encEntry = new OTPEntry(
      {
        type: OTPType.totp,
        index: 0,
        issuer: "Encrypted",
        account: "user",
        encrypted: false,
        secret: encSecret,
      },
      unlocked,
    );
    await EntryStorage.add(encEntry);
    encHash = encEntry.hash;
    await BrowserStorage.set({
      [plainHash]: {
        dataType: "OTPStorage",
        encrypted: false,
        hash: plainHash,
        index: 1,
        type: "totp",
        secret: plainSecret,
        issuer: "Plain",
        host: "plain.test",
      },
      [legacyHash]: {
        encrypted: true,
        hash: legacyHash,
        index: 2,
        type: "totp",
        secret: legacyCiphertext,
      },
    });
  });

  afterEach(async () => {
    await BrowserStorage.remove([keyId, encHash, plainHash, legacyHash]);
  });

  it("backupGetExport(enc, true) encrypts plaintext entries and keeps ciphertext", async () => {
    const storedEnc = (await BrowserStorage.get())[encHash];
    const exported = (await EntryStorage.backupGetExport(unlocked, true)) as {
      [hash: string]: OTPStorage | Key;
    };

    expect(JSON.stringify(exported)).to.not.include(plainSecret);
    expect(JSON.stringify(exported)).to.not.include(encSecret);

    const inner = await decryptInner(exported[plainHash] as OTPStorage);
    expect(inner.dataType).to.equal("OTPStorage");
    expect(inner.hash).to.equal(plainHash);
    expect(inner.secret).to.equal(plainSecret);
    expect(inner.issuer).to.equal("Plain::plain.test");

    expect(exported[encHash]).to.deep.equal(storedEnc);
    expect((exported[legacyHash] as RawOTPStorage).secret).to.equal(
      legacyCiphertext,
    );
    expect(exported[keyId]).to.deep.equal(keyRecord);
  });

  it("backupGetExport(enc, true) drops plaintext entries it cannot encrypt", async () => {
    const exported = (await EntryStorage.backupGetExport(
      new Encryption("", ""),
      true,
    )) as { [hash: string]: OTPStorage };

    expect(exported).to.not.have.property(plainHash);
    expect(JSON.stringify(exported)).to.not.include(plainSecret);
  });

  it("getExport(data, true) encrypts entries that have no encryption of their own", async () => {
    const plainEntry = (await EntryStorage.get()).find(
      (e) => e.hash === plainHash,
    ) as OTPEntryInterface;
    expect(plainEntry.encryption).to.equal(undefined);

    const exported = (await EntryStorage.getExport(
      [plainEntry],
      true,
      unlocked,
    )) as {
      [hash: string]: OTPStorage;
    };
    const inner = await decryptInner(exported[plainHash]);
    expect(inner.hash).to.equal(plainHash);
    expect(inner.secret).to.equal(plainSecret);

    expect(await EntryStorage.getExport([plainEntry], true)).to.deep.equal({});
    const plainExport = (await EntryStorage.getExport([plainEntry])) as {
      [hash: string]: RawOTPStorage;
    };
    expect(plainExport[plainHash].secret).to.equal(plainSecret);
  });
});

// EntryStorage.import() used to run parseInt() on the type and algorithm
// fields, but both are persisted as their enum *names* ("hotp", "SHA512"), so
// parseInt returned NaN and the entry silently fell back to TOTP/SHA1. A
// SHA-512 account added by QR scan / otpauth URI / backup restore therefore
// generated SHA-1 codes while the UI still claimed SHA-512
// (Authenticator-Extension/Authenticator#1442, #1294, #1089, #1559; imported
// HOTP/Steam entries becoming TOTP is the same bug: #1292, #405).
describe("EntryStorage.import maps type/algorithm names back to their enums", () => {
  const importEncryption = new Encryption("", "");

  function rawEntry(overrides: Partial<RawOTPStorage>): RawOTPStorage {
    return {
      hash: crypto.randomUUID(),
      index: 0,
      encrypted: false,
      secret: "AAAAAAAAAAAAAAAA",
      issuer: "EnumImportTest",
      account: "user",
      type: OTPType[OTPType.totp],
      ...overrides,
    };
  }

  async function importAndRead(item: RawOTPStorage) {
    await EntryStorage.import(importEncryption, { [item.hash]: item });
    const restored = (await EntryStorage.get()).find(
      (e) => e.hash === item.hash,
    );
    expect(restored, "imported entry should be present").to.exist;
    return restored as OTPEntryInterface;
  }

  it("keeps SHA512 instead of falling back to SHA1", async () => {
    const item = rawEntry({ algorithm: OTPAlgorithm[OTPAlgorithm.SHA512] });
    const restored = await importAndRead(item);
    try {
      expect(restored.algorithm).to.equal(OTPAlgorithm.SHA512);
    } finally {
      await EntryStorage.delete(restored);
    }
  });

  it("accepts a lower-cased algorithm name, as written in otpauth:// URIs", async () => {
    const item = rawEntry({ algorithm: "sha256" });
    const restored = await importAndRead(item);
    try {
      expect(restored.algorithm).to.equal(OTPAlgorithm.SHA256);
    } finally {
      await EntryStorage.delete(restored);
    }
  });

  it("keeps the hotp type instead of falling back to totp", async () => {
    const item = rawEntry({ type: OTPType[OTPType.hotp], counter: 7 });
    const restored = await importAndRead(item);
    try {
      expect(restored.type).to.equal(OTPType.hotp);
      expect(restored.counter).to.equal(7);
    } finally {
      await EntryStorage.delete(restored);
    }
  });

  it("still defaults to SHA1 when no algorithm is stored", async () => {
    const item = rawEntry({});
    const restored = await importAndRead(item);
    try {
      expect(restored.algorithm).to.equal(OTPAlgorithm.SHA1);
    } finally {
      await EntryStorage.delete(restored);
    }
  });

  // The consequence of the fallback: SHA1 and SHA512 are not interchangeable,
  // so a silently downgraded entry hands the user a code the server rejects.
  it("SHA1 and SHA512 produce different codes for the same secret and counter", () => {
    const args = ["AAAAAAAAAAAAAAAA", 7, 30, 6] as const;
    const sha1 = KeyUtilities.generate(
      OTPType.hotp,
      ...args,
      OTPAlgorithm.SHA1,
    );
    const sha512 = KeyUtilities.generate(
      OTPType.hotp,
      ...args,
      OTPAlgorithm.SHA512,
    );
    expect(sha1).to.not.equal(sha512);
  });
});

// base32tohex used to map any character outside [A-Z2-7=] to indexOf's -1
// sentinel and silently fold that into the key bits, producing a
// wrong-but-well-formed OTP with no indication anything was wrong.
describe("KeyUtilities.generate rejects invalid Base32 secrets", () => {
  it("throws for a character outside the Base32 alphabet", () => {
    expect(() =>
      KeyUtilities.generate(OTPType.totp, "AAAAAAA1", 0, 30),
    ).to.throw("Invalid Base32 string");
  });

  it("still accepts a valid Base32 secret", () => {
    expect(() =>
      KeyUtilities.generate(OTPType.totp, "AAAAAAAAAAAAAAAA", 0, 30),
    ).to.not.throw();
  });
});

// Upstream issue #1546: a Base32 secret whose data-character count isn't a
// multiple of 8 (so it needs `=` padding to reach a mod-8 length) produced a
// wrong OTP when the `=` padding was missing, because the old decoder derived
// how many trailing bits to discard from a count of literal `=` characters
// rather than from the bit length itself -- no padding meant no truncation,
// leaving one extra garbage nibble in the HMAC key. base32tohex now always
// truncates to a whole number of bytes (floor(bits.length / 8) * 8), so
// padding is optional and, when present, purely cosmetic.
describe("KeyUtilities.generate handles unpadded Base32 secrets (#1546)", () => {
  const unpadded = "J3WWIV3PTGJPQV5QAICM";
  const padded = "J3WWIV3PTGJPQV5QAICM====";
  // Independently verified (standalone RFC 4648 decoder, see scratchpad
  // base32check.js) that both secrets above decode to this 12-byte key --
  // this is the correctness anchor, not just "both branches agree".
  const expectedHexKey = "4eed64576f9992f857b00204";

  it("produces the same TOTP whether or not the secret is padded", () => {
    const withoutPadding = KeyUtilities.generate(OTPType.totp, unpadded, 0, 30);
    const withPadding = KeyUtilities.generate(OTPType.totp, padded, 0, 30);
    expect(withoutPadding).to.equal(withPadding);
  });

  it("decodes the unpadded secret to the independently-verified key bytes", () => {
    const fromBase32 = KeyUtilities.generate(OTPType.hotp, unpadded, 0, 30);
    const fromHex = KeyUtilities.generate(OTPType.hhex, expectedHexKey, 0, 30);
    expect(fromBase32).to.equal(fromHex);
  });
});

// The QR migration (jsqr -> @zxing/library) replaced the decoder used by both
// the popup import flow (QrImport.vue) and the injected content script
// (content.ts) with the shared decodeQrFromImageData leaf module. Generate a
// real otpauth QR with @zxing's writer, rasterize its BitMatrix into RGBA
// ImageData exactly like a <canvas> getImageData would, and assert the shared
// decoder reads the original string back.
describe("decodeQrFromImageData round-trips an otpauth QR (@zxing)", () => {
  it("decodes the same string that was encoded", () => {
    const content =
      "otpauth://totp/Example:user@example.com" +
      "?secret=AAAAAAAAAAAAAAAA&issuer=Example";
    const matrix = new MultiFormatWriter().encode(
      content,
      BarcodeFormat.QR_CODE,
      300,
      300,
      new Map(),
    );
    const width = matrix.getWidth();
    const height = matrix.getHeight();
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        // BitMatrix.get => true for a dark module. Paint dark as black (0) and
        // light as white (255), fully opaque, matching a canvas render.
        const value = matrix.get(x, y) ? 0 : 255;
        const idx = (y * width + x) * 4;
        data[idx] = value;
        data[idx + 1] = value;
        data[idx + 2] = value;
        data[idx + 3] = 255;
      }
    }
    const imageData = new ImageData(data, width, height);
    expect(decodeQrFromImageData(imageData)).to.equal(content);
  });

  it("returns null for an image with no QR code", () => {
    const width = 64;
    const height = 64;
    const data = new Uint8ClampedArray(width * height * 4).fill(255);
    for (let i = 3; i < data.length; i += 4) {
      data[i] = 255; // opaque, otherwise all-white
    }
    const imageData = new ImageData(data, width, height);
    expect(decodeQrFromImageData(imageData)).to.equal(null);
  });
});

// The QR decode moved from the injected content script back into the background
// (so content.js no longer ships @zxing). computeQrCropRegion is the pure part
// of that move: it maps the CSS-pixel drag selection onto the captured bitmap's
// device pixels, clamped to bounds, mirroring the old content-script math.
describe("computeQrCropRegion (background QR crop math)", () => {
  it("crops a normal selection at 1x device pixel ratio", () => {
    // bitmap 1000 wide, viewport 1000 css px => dpr 1, so px map 1:1.
    const region = computeQrCropRegion(1000, 800, 1000, 100, 50, 200, 150);
    expect(region).to.deep.equal({ sx: 100, sy: 50, sw: 200, sh: 150 });
  });

  it("scales the selection by the device pixel ratio (2x)", () => {
    // bitmap 2000 wide, viewport 1000 css px => dpr 2, so every css px doubles.
    const region = computeQrCropRegion(2000, 1600, 1000, 100, 50, 200, 150);
    expect(region).to.deep.equal({ sx: 200, sy: 100, sw: 400, sh: 300 });
  });

  it("clamps a selection that runs past the bitmap edges", () => {
    // dpr 1; selection starts near the right/bottom and overflows, so width and
    // height are trimmed to what remains inside the bitmap.
    const region = computeQrCropRegion(1000, 800, 1000, 900, 700, 400, 400);
    expect(region).to.deep.equal({ sx: 900, sy: 700, sw: 100, sh: 100 });
  });

  it("rejects a zero-size selection (a click or 1px drag)", () => {
    expect(computeQrCropRegion(1000, 800, 1000, 100, 50, 0, 0)).to.equal(null);
  });

  it("rejects a selection wholly outside the bitmap", () => {
    // sx clamps to bitmapWidth so the remaining width is <= 0 => rejected.
    expect(computeQrCropRegion(1000, 800, 1000, 2000, 50, 100, 100)).to.equal(
      null,
    );
  });

  it("rejects a 0-size bitmap (a failed capture)", () => {
    expect(computeQrCropRegion(0, 0, 1000, 100, 50, 200, 150)).to.equal(null);
  });
});

// advisorIgnoreList predates the array format: localStorage-era (pre-Pinia)
// settings stored it as a JSON string, and some users' chrome.storage still
// holds that string. useAdvisorStore().init() used to assign the raw
// (possibly-string) value straight into ignoreList, so dismissInsight()'s
// .push() would throw TypeError on those accounts and could persist the
// corrupted string back to storage.
describe("useAdvisorStore init() parses a legacy JSON-string ignoreList", () => {
  let originalUserSettings: unknown;

  beforeEach(async () => {
    originalUserSettings = (await chrome.storage.local.get("UserSettings"))
      .UserSettings;
  });

  afterEach(async () => {
    if (originalUserSettings === undefined) {
      await chrome.storage.local.remove("UserSettings");
    } else {
      await chrome.storage.local.set({ UserSettings: originalUserSettings });
    }
    await UserSettings.updateItems();
  });

  it("normalises a legacy JSON-string advisorIgnoreList into an array", async () => {
    await chrome.storage.local.set({
      UserSettings: { advisorIgnoreList: '["autoLockNotSet"]' },
    });

    setActivePinia(createPinia());
    const store = useAdvisorStore();
    await store.init();

    expect(store.ignoreList).to.deep.equal(["autoLockNotSet"]);
  });

  it("dismissInsight() appends onto a legacy string ignoreList without throwing, and persists an array", async () => {
    await chrome.storage.local.set({
      UserSettings: { advisorIgnoreList: '["autoLockNotSet"]' },
    });

    setActivePinia(createPinia());
    const store = useAdvisorStore();
    await store.init();

    await store.dismissInsight("passwordNotSet");

    expect(store.ignoreList).to.deep.equal([
      "autoLockNotSet",
      "passwordNotSet",
    ]);
    expect(UserSettings.items.advisorIgnoreList)
      .to.be.an("array")
      .that.deep.equals(["autoLockNotSet", "passwordNotSet"]);
  });

  it("treats a malformed or non-array ignoreList as empty instead of throwing", async () => {
    for (const advisorIgnoreList of ["[not json", '{"a":1}', "42"]) {
      await chrome.storage.local.set({ UserSettings: { advisorIgnoreList } });
      setActivePinia(createPinia());
      const store = useAdvisorStore();
      await store.init();
      expect(store.ignoreList, advisorIgnoreList).to.deep.equal([]);
    }
  });
});

// Google Authenticator stores account and issuer as UTF-8 bytes; the URI
// must keep them intact and must not let "&" or "?" in a name add parameters.
describe("getOTPAuthPerLineFromOPTAuthMigration", () => {
  function field(tag: number, bytes: number[]) {
    return [tag, bytes.length, ...bytes];
  }

  function migrationUri(account: string, issuer: string) {
    const utf8 = (text: string) => Array.from(new TextEncoder().encode(text));
    const otp = [
      ...field(
        10,
        [0x48, 0x65, 0x6c, 0x6c, 0x6f, 0x21, 0xde, 0xad, 0xbe, 0xef],
      ),
      ...field(18, utf8(account)),
      ...field(26, utf8(issuer)),
      32,
      1, // SHA1
      40,
      1, // 6 digits
      48,
      2, // TOTP
    ];
    const payload = field(10, otp);
    return (
      "otpauth-migration://offline?data=" +
      encodeURIComponent(btoa(String.fromCharCode(...payload)))
    );
  }

  it("keeps UTF-8 names and encodes URI delimiters", () => {
    const [line] = getOTPAuthPerLineFromOPTAuthMigration(
      migrationUri("José&x=1@例子", "Café?#%"),
    );
    const url = new URL(line);
    expect(decodeURIComponent(url.pathname.replace(/^\/+/, ""))).to.equal(
      "José&x=1@例子",
    );
    expect(url.searchParams.get("issuer")).to.equal("Café?#%");
    expect(url.searchParams.has("x")).to.equal(false);
    expect(url.searchParams.get("secret")).to.equal("JBSWY3DPEHPK3PXP");
  });
});

// An interrupted v1/v2 -> v3 migration (or a sync from an older device) can
// leave legacy ciphertext that no unlocked key decrypts. Writing such an entry
// back must keep the ciphertext; it used to become { encrypted: false,
// secret: "" }, permanently erasing the account.
describe("EntryStorage keeps undecryptable legacy ciphertext when writing back", () => {
  const hash = "77777777-6666-4555-8444-333333333333";
  const legacySecret = "U2FsdGVkX1/Ca3NjxUzrBfM7IGOu/uI7vouAZsLrX5o=";

  afterEach(async () => {
    await BrowserStorage.remove(hash);
  });

  it("writes the legacy record back unchanged", async () => {
    await BrowserStorage.set({
      [hash]: {
        encrypted: true,
        hash,
        index: 0,
        type: "totp",
        secret: legacySecret,
        issuer: "LegacyBank",
        account: "user",
      },
    });
    const entry = (await EntryStorage.get()).find((e) => e.hash === hash);
    expect(entry, "legacy entry should load").to.exist;
    expect(entry?.secret).to.equal(null);

    if (entry) {
      await EntryStorage.set([entry]);
    }

    const stored = (await BrowserStorage.get())[hash] as RawOTPStorage;
    expect(stored.encrypted).to.equal(true);
    expect(stored.secret).to.equal(legacySecret);
    expect(stored.issuer).to.equal("LegacyBank");
    expect(stored.keyId).to.equal(undefined);
  });
});

// A plaintext export with keyId makes FileImport treat the entry as encrypted
// and ask for a password the plaintext file does not need.
describe("EntryStorage.getExport plaintext export carries no keyId", () => {
  it("omits keyId for unencrypted exports and keeps it inside encrypted ones", async () => {
    const encryption = new Encryption(
      "plaintext-export-test-password-hash",
      "plaintext-export-test-key-id",
    );
    const entry = new OTPEntry(
      {
        type: OTPType.totp,
        index: 0,
        issuer: "PlainExport",
        account: "user",
        encrypted: false,
        secret: "JBSWY3DPEHPK3PXP",
      },
      encryption,
    );

    const plain = (await EntryStorage.getExport([entry], false)) as {
      [hash: string]: RawOTPStorage;
    };
    expect(plain[entry.hash].secret).to.equal("JBSWY3DPEHPK3PXP");
    expect(plain[entry.hash].keyId).to.equal(undefined);

    const encrypted = (await EntryStorage.getExport([entry], true)) as {
      [hash: string]: EncOTPStorage;
    };
    expect(encrypted[entry.hash].dataType).to.equal("EncOTPStorage");
    expect(encrypted[entry.hash].keyId).to.equal(
      "plaintext-export-test-key-id",
    );
  });
});

// Switching storage areas clears the old area, so every value must have
// arrived first; comparing key names alone missed truncated or changed values.
describe("storage area switch and log clearing", () => {
  afterEach(() => {
    sinon.restore();
  });

  it("compares stored values regardless of key order", () => {
    expect(
      sameStoredValue({ a: 1, b: { c: [1, 2] } }, { b: { c: [1, 2] }, a: 1 }),
    ).to.equal(true);
    expect(sameStoredValue({ a: 1 }, { a: 2 })).to.equal(false);
    expect(sameStoredValue({ a: 1 }, undefined)).to.equal(false);
  });

  it("keeps the local area when sync did not store every value", async () => {
    setActivePinia(createPinia());
    const store = useAccountsStore();
    const original = UserSettings.items.storageLocation;
    UserSettings.items.storageLocation = StorageLocation.Local;
    const entry = { hash: "e", secret: "JBSWY3DPEHPK3PXP" };
    sinon
      .stub(chrome.storage.local, "get")
      .resolves({ e: entry, UserSettings: {} });
    sinon.stub(chrome.storage.sync, "set").resolves();
    sinon
      .stub(chrome.storage.sync, "get")
      .resolves({ e: { ...entry, secret: "" } });
    const localClear = sinon.stub(chrome.storage.local, "clear").resolves();
    const commit = sinon.stub(UserSettings, "commitItems").resolves();

    let error: unknown;
    try {
      await store.migrateStorage(StorageLocation.Sync);
    } catch (e) {
      error = e;
    }
    UserSettings.items.storageLocation = original;
    expect(error).to.not.equal(undefined);
    expect(localClear.called).to.equal(false);
    expect(commit.called).to.equal(false);
  });

  it("restores the area when clearLogs stopped between clear and set", async () => {
    await UserSettings.updateItems();
    const area =
      chrome.storage[
        UserSettings.items.storageLocation || StorageLocation.Local
      ];
    await area.set({ clearLogsMarker: "keep-me" });
    const before = await area.get();

    sinon
      .stub(area, "set")
      .onFirstCall()
      .rejects(new Error("worker stopped"))
      .callThrough();
    let error: unknown;
    try {
      await BrowserStorage.clearLogs();
    } catch (e) {
      error = e;
    }
    expect(error).to.be.instanceOf(Error);
    sinon.restore();

    await BrowserStorage.restoreInterruptedClearLogs();
    expect(sameStoredValue(await area.get(), before)).to.equal(true);
    expect(
      (await chrome.storage.session.get("clearLogsBackup")).clearLogsBackup,
    ).to.equal(undefined);
    await area.remove("clearLogsMarker");
  });
});

// EncOTPStorage written before the AES-GCM switch holds AES-CBC data. The
// fixture was produced by `openssl enc -aes-256-cbc -md md5 -salt`, the same
// framing crypto-js used. Decrypting it marks the entry for an AES-GCM rewrite.
describe("OTPEntry.applyEncryption flags AES-CBC data for upgrade", () => {
  const password = "dummy-salted-hash";
  const hash = "33333333-4444-4555-8666-777777777777";
  const cbcData =
    "U2FsdGVkX1+b7WwPnJEG96zDDNHaJl9c3NV7dmkdBsjh2qqltWMfLDkIL+/BsE15xuLaEC0IXArQkOmDCJPNBXOO13qRhB3OxCLmo5nOdvfqZmDx+74bP8YWfT//FUd+ra8UFAV3lAh5bPIlfnHZ0eooM8UWoxadrz70Ui5e2gfRi/Pu4TmvfTkv7Sq8f5hsIhJBLjqhPONnDZISED4qFFd6ozOzG4SZGWFZgKmjHKQR63t3C81FALlTLOmrS90J59mo6ybRYFsldzArBcswKQLA/AWTzzM0+r7qoBVGQECE2e3zkqDQm3qtlGwp7N11";

  function entryWith(encData: string) {
    return new OTPEntry({
      encrypted: true,
      keyId: "cbc-key-id",
      encData,
      hash,
      index: 0,
    });
  }

  it("decrypts AES-CBC data and marks it for rewrite", async () => {
    const entry = entryWith(cbcData);
    await entry.applyEncryption(new Encryption(password, "cbc-key-id"));
    expect(entry.secret).to.equal("JBSWY3DPEHPK3PXP");
    expect(entry.issuer).to.equal("CbcEra");
    expect(entry.legacyEncData).to.equal(true);
  });

  it("leaves AES-GCM data unmarked", async () => {
    const encryption = new Encryption(password, "cbc-key-id");
    const gcmData = await encryption.getEncryptedString(
      JSON.stringify({
        dataType: "OTPStorage",
        hash,
        secret: "JBSWY3DPEHPK3PXP",
        type: "totp",
        encrypted: true,
        keyId: "cbc-key-id",
        index: 0,
      }),
    );
    const entry = entryWith(gcmData);
    await entry.applyEncryption(encryption);
    expect(entry.secret).to.equal("JBSWY3DPEHPK3PXP");
    expect(entry.legacyEncData).to.equal(false);
  });

  it("keeps an undecryptable entry unmarked", async () => {
    const entry = entryWith(cbcData);
    await entry.applyEncryption(new Encryption("wrong-password", "cbc-key-id"));
    expect(entry.secret).to.equal(null);
    expect(entry.legacyEncData).to.not.equal(true);
  });
});

// Encrypting without a key must fail rather than store plaintext.
describe("Encryption.getEncryptedString without a key", () => {
  it("throws instead of returning plaintext", async () => {
    let error: unknown;
    try {
      await new Encryption("", "").getEncryptedString("JBSWY3DPEHPK3PXP");
    } catch (e) {
      error = e;
    }
    expect(error).to.be.instanceOf(Error);
  });
});

// Only the parameter sets this extension has used may unlock; a Key record
// synced in with weaker parameters or argon2d is refused before verifying.
describe("isKnownArgonEncoding", () => {
  const salt = "c2FsdHNhbHRzYWx0c2FsdA";
  const hash24 = "A".repeat(32);
  const hash32 = "A".repeat(43);

  it("accepts the current and the original parameter sets", () => {
    expect(
      isKnownArgonEncoding(`$argon2id$v=19$m=19456,t=2,p=1$${salt}$${hash32}`),
    ).to.equal(true);
    expect(
      isKnownArgonEncoding(`$argon2id$v=19$m=16384,t=1,p=1$${salt}$${hash24}`),
    ).to.equal(true);
  });

  it("rejects weaker parameters, other types and malformed strings", () => {
    for (const encoded of [
      `$argon2id$v=19$m=1024,t=1,p=1$${salt}$${hash32}`,
      `$argon2id$v=19$m=19456,t=1,p=1$${salt}$${hash32}`,
      `$argon2d$v=19$m=19456,t=2,p=1$${salt}$${hash32}`,
      `$argon2i$v=19$m=19456,t=2,p=1$${salt}$${hash32}`,
      `$argon2id$v=16$m=19456,t=2,p=1$${salt}$${hash32}`,
      `$argon2id$v=19$m=19456,t=2,p=1$${salt}$${"A".repeat(10)}`,
      `$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$${hash32}`,
      "",
      "not-a-hash",
    ]) {
      expect(isKnownArgonEncoding(encoded), encoded).to.equal(false);
    }
  });
});

// --- Phase 0 of the crypto-js removal (docs/plans/crypto-js-migration-plan.md):
// fixture-first baseline before touching any implementation. These ciphertexts
// were generated once with the current crypto-js (CryptoJS.AES.encrypt(...).
// toString()) and hardcoded as static constants, so they keep existing after
// crypto-js is removed and become the cross-check for the replacement
// EVP_BytesToKey + AES-CBC implementation (Phase 3). decryptString() is the
// production entry point (encryption.ts) that dispatches "v4:"-prefixed
// AES-GCM vs. legacy crypto-js AES-CBC ("U2FsdGVkX1..." OpenSSL framing).
describe("legacy crypto-js AES-CBC fixtures (decryptString baseline)", () => {
  const fixtures: Array<{
    name: string;
    plaintext: string;
    passphrase: string;
    ciphertext: string;
  }> = [
    {
      name: "ASCII plaintext x ASCII passphrase",
      plaintext: "hello world",
      passphrase: "password123",
      ciphertext: "U2FsdGVkX1/Ca3NjxUzrBfM7IGOu/uI7vouAZsLrX5o=",
    },
    {
      name: "ASCII plaintext x Chinese passphrase",
      plaintext: "hello world",
      passphrase: "測試密碼中文密碼",
      ciphertext: "U2FsdGVkX1/TypKxAV9yBvmZ346rm3uB6sh/+gsmy6Y=",
    },
    {
      name: "ASCII plaintext x emoji passphrase",
      plaintext: "hello world",
      passphrase: "pass🔐word🎉phrase",
      ciphertext: "U2FsdGVkX19YEEiv/i2L7N7CMKWnRY25qTPO/h+5Phs=",
    },
    {
      name: "ASCII plaintext x long passphrase (>64 bytes)",
      plaintext: "hello world",
      passphrase:
        "a-very-long-passphrase-that-exceeds-sixty-four-bytes-in-length-1234567890",
      ciphertext: "U2FsdGVkX1+9v3rISV0NQ2r0R+XJRL9E40/yuN7wgco=",
    },
    {
      name: "Chinese/emoji plaintext x ASCII passphrase",
      plaintext: "測試内容🎉emoji和中文",
      passphrase: "password123",
      ciphertext:
        "U2FsdGVkX1/5Y5jJ2ev68Yddd5wYzOOYUslb+l0Y5RpqCh1IT5+soinK3Px2pmnl",
    },
  ];

  for (const f of fixtures) {
    it(`decrypts: ${f.name}`, async () => {
      const result = await decryptString(f.ciphertext, f.passphrase);
      expect(result).to.equal(f.plaintext);
    });
  }

  // Empty-plaintext is a documented quirk, not a plain round-trip case:
  // decryptString does `return decrypted || null`, so a correctly-decrypted
  // empty string ("") is falsy and gets mapped to null -- indistinguishable
  // from an actual decryption failure. This assertion locks that CURRENT
  // behavior (observed directly, not assumed) so a Phase 3 replacement must
  // reproduce it rather than "fix" it into returning "".
  it("empty plaintext x ASCII passphrase decrypts to null, not '' (decryptString's `|| null` quirk)", async () => {
    const result = await decryptString(
      "U2FsdGVkX18vgaJx+YXWJR1iQ2bUAdDbzT5VaEvG4ZA=", // "" / "password123"
      "password123",
    );
    expect(result).to.equal(null);
  });

  // This assertion locks the CURRENT crypto-js behavior for a wrong
  // passphrase: CryptoJS.AES.decrypt(...).toString(CryptoJS.enc.Utf8) does
  // NOT throw here, it silently returns an empty string ("" observed across
  // 10 independent ASCII plaintext/passphrase samples during fixture
  // generation), which decryptString's `decrypted || null` then maps to
  // null. Any Phase 3 replacement must preserve this null-on-wrong-password
  // contract (UI treats null as "decryption failed").
  it("returns null for a wrong passphrase (locks current crypto-js behavior)", async () => {
    const result = await decryptString(
      "U2FsdGVkX18XFBuvDiymS9HzX+ItUG+MtnBe4rLiLWU=", // "hello world" / "password123"
      "totally-wrong-password",
    );
    expect(result).to.equal(null);
  });
});

// RFC 4226 (HOTP) and RFC 6238 (TOTP) official test vectors -- the acceptance
// baseline for KeyUtilities.generate's HMAC layer (Phase 2 of the crypto-js
// removal plan). generate() only accepts a Base32 `secret` for
// OTPType.totp/hotp (base32tohex), but the RFC vectors' ASCII secrets are not
// valid Base32 ("12345678901234567890" contains 1/8/9/0, outside
// A-Z2-7). OTPType.hhex takes `secret` as a raw hex string (no Base32
// decoding) and, like hotp, uses the given `counter` directly instead of
// deriving it from the current time (see the `type !== hotp && type !==
// hhex` epoch branch in key-utilities.ts) -- so hhex is used here to inject
// the RFC secret and counter exactly, for both the HOTP vectors and (via
// counter = floor(T / 30), verified equivalent to the TOTP time-stepping
// since KeyUtilities.generate's time-based path only differs from the direct
// counter path in how `counter` is computed) the TOTP vectors. This avoids
// depending on Date.now() / clockOffset injection for TOTP, which the
// current generate() signature has no seam for beyond wall-clock time.
function asciiToHex(str: string): string {
  let hex = "";
  for (let i = 0; i < str.length; i++) {
    hex += str.charCodeAt(i).toString(16).padStart(2, "0");
  }
  return hex;
}

describe("RFC 4226 HOTP official test vectors", () => {
  // RFC 4226 Appendix D, secret = ASCII "12345678901234567890"
  const secretHex = asciiToHex("12345678901234567890");
  const expected = [
    "755224",
    "287082",
    "359152",
    "969429",
    "338314",
    "254676",
    "287922",
    "162583",
    "399871",
    "520489",
  ];

  expected.forEach((expectedOtp, counter) => {
    it(`counter=${counter} -> ${expectedOtp}`, () => {
      const otp = KeyUtilities.generate(
        OTPType.hhex,
        secretHex,
        counter,
        30,
        6,
      );
      expect(otp).to.equal(expectedOtp);
    });
  });
});

describe("RFC 6238 TOTP official test vectors (SHA1/SHA256/SHA512)", () => {
  // RFC 6238 Appendix B. period=30, digits=8.
  const secretSha1 = asciiToHex("12345678901234567890");
  const secretSha256 = asciiToHex("12345678901234567890123456789012");
  const secretSha512 = asciiToHex(
    "1234567890123456789012345678901234567890123456789012345678901234",
  );

  const cases: Array<{
    time: number;
    sha1: string;
    sha256: string;
    sha512: string;
  }> = [
    { time: 59, sha1: "94287082", sha256: "46119246", sha512: "90693936" },
    {
      time: 1111111109,
      sha1: "07081804",
      sha256: "68084774",
      sha512: "25091201",
    },
    {
      time: 1111111111,
      sha1: "14050471",
      sha256: "67062674",
      sha512: "99943326",
    },
    {
      time: 1234567890,
      sha1: "89005924",
      sha256: "91819424",
      sha512: "93441116",
    },
    {
      time: 2000000000,
      sha1: "69279037",
      sha256: "90698825",
      sha512: "38618901",
    },
    {
      time: 20000000000,
      sha1: "65353130",
      sha256: "77737706",
      sha512: "47863826",
    },
  ];

  cases.forEach((c) => {
    const counter = Math.floor(c.time / 30);

    it(`T=${c.time} SHA1 -> ${c.sha1}`, () => {
      const otp = KeyUtilities.generate(
        OTPType.hhex,
        secretSha1,
        counter,
        30,
        8,
        OTPAlgorithm.SHA1,
      );
      expect(otp).to.equal(c.sha1);
    });

    it(`T=${c.time} SHA256 -> ${c.sha256}`, () => {
      const otp = KeyUtilities.generate(
        OTPType.hhex,
        secretSha256,
        counter,
        30,
        8,
        OTPAlgorithm.SHA256,
      );
      expect(otp).to.equal(c.sha256);
    });

    it(`T=${c.time} SHA512 -> ${c.sha512}`, () => {
      const otp = KeyUtilities.generate(
        OTPType.hhex,
        secretSha512,
        counter,
        30,
        8,
        OTPAlgorithm.SHA512,
      );
      expect(otp).to.equal(c.sha512);
    });
  });
});
