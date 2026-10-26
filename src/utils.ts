export async function getSiteName() {
  const query = new URLSearchParams(document.location.search.substring(1));
  const titleFromQuery = query.get("title");
  const urlFromQuery = query.get("url");

  if (titleFromQuery && urlFromQuery) {
    return getSiteNameFromPage(
      decodeURIComponent(titleFromQuery),
      decodeURIComponent(urlFromQuery),
    );
  }

  const tab = await getCurrentTab();
  if (!tab) {
    return [null, null];
  }
  return getSiteNameFromTab(tab);
}

// For callers that already hold the tab, such as the background keyboard
// autofill, where there is no document to read a query from.
export function getSiteNameFromTab(tab: chrome.tabs.Tab) {
  return getSiteNameFromPage(
    tab.title?.replace(/[^a-z0-9]/gi, "").toLowerCase() ?? null,
    tab.url ?? null,
  );
}

function getSiteNameFromPage(title: string | null, url: string | null) {
  if (!url) {
    return [title, null];
  }

  const urlParser = new URL(url);
  const hostname = urlParser.hostname; // it's always lower case

  // try to parse name from hostname
  // i.e. hostname is www.example.com
  // name should be example
  let nameFromDomain = "";

  // ip address
  if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) {
    nameFromDomain = hostname;
  } else {
    // local network
    if (hostname.indexOf(".") === -1) {
      nameFromDomain = hostname;
    }

    const hostLevelUnits = hostname.split(".");

    if (hostLevelUnits.length === 2) {
      nameFromDomain = hostLevelUnits[0];
    }

    // www.example.com
    // example.com.cn
    if (hostLevelUnits.length > 2) {
      // example.com.cn
      if (
        ["com", "net", "org", "edu", "gov", "co"].indexOf(
          hostLevelUnits[hostLevelUnits.length - 2],
        ) !== -1
      ) {
        nameFromDomain = hostLevelUnits[hostLevelUnits.length - 3];
      } else {
        // www.example.com
        nameFromDomain = hostLevelUnits[hostLevelUnits.length - 2];
      }
    }
  }

  nameFromDomain = nameFromDomain.replace(/-/g, "").toLowerCase();

  return [title, nameFromDomain, hostname];
}

export function shouldApplySearchFilter(
  showSearch: boolean,
  searchText: string,
): boolean {
  return showSearch || searchText !== "";
}

// `strict` is used by autofill, which pastes a live OTP into the page: it drops
// the page-controlled <title> match and anchors the host match to a real domain
// boundary, so a hostile page can't claim another origin's code. Display
// filtering passes strict=false and stays loose.
export function getMatchedEntries(
  siteName: Array<string | null>,
  entries: OTPEntryInterface[],
  strict = false,
) {
  if (siteName.length < 2) {
    return false;
  }

  const matched = [];

  for (const entry of entries) {
    if (isMatchedEntry(siteName, entry, strict)) {
      matched.push(entry);
    }
  }

  return matched;
}

export function getMatchedEntriesHash(
  siteName: Array<string | null>,
  entries: OTPEntryInterface[],
) {
  const matchedEnteries = getMatchedEntries(siteName, entries);
  if (matchedEnteries) {
    return matchedEnteries.map((entry) => entry.hash);
  }

  return false;
}

// True when `host` is exactly `bound` or a subdomain of it, so that
// "google.com.attacker.com" does NOT match the bound host "google.com".
function hostMatchesDomain(host: string, bound: string) {
  host = host.toLowerCase();
  bound = bound.toLowerCase().replace(/^\.+/, "");
  return host === bound || host.endsWith("." + bound);
}

function isMatchedEntry(
  siteName: Array<string | null>,
  entry: OTPEntryInterface,
  strict = false,
) {
  const siteTitle = siteName[0] || "";
  const siteNameFromHost = siteName[1] || "";
  const siteHost = siteName[2] || "";

  // The bound host lives in entry.host; fall back to the legacy "issuer::host"
  // encoding for entries not yet migrated (e.g. raw storage objects). The
  // issuer itself may contain "::", so only the last "::" is the separator.
  const rawIssuer = entry.issuer || "";
  const sepIndex = rawIssuer.lastIndexOf("::");
  const issuerName = sepIndex === -1 ? rawIssuer : rawIssuer.slice(0, sepIndex);
  let boundHost = entry.host || "";
  if (!boundHost && sepIndex !== -1) {
    boundHost = rawIssuer.slice(sepIndex + 2);
  }
  boundHost = boundHost.replace(/^\.+/, "").toLowerCase();

  // strict (autofill): only ever inject a live code when the page's real host
  // matches an explicitly bound host. No bound host => never autofill, so a
  // hostile page can't harvest a code the user didn't mean for it.
  if (strict) {
    if (!boundHost) {
      return false;
    }
    return Boolean(siteHost && hostMatchesDomain(siteHost, boundHost));
  }

  // loose (display filtering): bound host match, else issuer-name heuristics.
  if (boundHost && siteHost && hostMatchesDomain(siteHost, boundHost)) {
    return true;
  }

  const issuer = issuerName.replace(/[^0-9a-z]/gi, "").toLowerCase();
  if (!issuer) {
    return false;
  }

  // The page-controlled <title> is only a weak hint, kept for display filtering.
  if (siteTitle && siteTitle.indexOf(issuer) !== -1) {
    return true;
  }

  // Multi-word issuers usually lead with the brand ("Unifi Ubiquiti SSO" on a
  // page titled "UniFi OS"). Short first words ("My", "The") match too much.
  const brand = (issuerName.match(/[0-9a-z]+/i)?.[0] || "").toLowerCase();
  if (siteTitle && brand.length >= 4 && siteTitle.indexOf(brand) !== -1) {
    return true;
  }

  // siteNameFromHost is derived from the real hostname, not page-controlled.
  if (siteNameFromHost && issuer.indexOf(siteNameFromHost) !== -1) {
    return true;
  }

  return false;
}

// Strip a legacy "issuer::host" binding down to the display issuer name. The
// issuer text itself may legitimately contain "::", so only the last "::" is
// treated as the host separator (matches migrateLegacyHost in models/otp.ts).
export function stripBoundHost(issuer: string): string {
  const sepIndex = issuer.lastIndexOf("::");
  return sepIndex === -1 ? issuer : issuer.slice(0, sepIndex);
}

// Normalize a user- or page-provided host into a bare lowercase hostname so it
// can be compared with hostMatchesDomain. Accepts a full URL or a bare host.
export function normalizeHost(input: string): string {
  const trimmed = input.trim().toLowerCase();
  if (!trimmed) {
    return "";
  }
  try {
    return new URL(trimmed.includes("://") ? trimmed : "https://" + trimmed)
      .hostname;
  } catch {
    return trimmed.replace(/^\.+/, "").replace(/\/.*$/, "");
  }
}

// A cloud backup must never carry plaintext secrets off the device. Uploading
// is only allowed once a master password is set, so the export is encrypted
// before it leaves for Dropbox / Drive / OneDrive. Lives here (a leaf module)
// rather than in backup.ts so tests can exercise it without dragging in the
// storage <-> otp import cycle.
export function cloudBackupAllowed(encryption?: EncryptionInterface): boolean {
  return Boolean(encryption && encryption.getEncryptionStatus());
}

// True when a storage change clears the cached passphrase: the background
// sets it to null on manual lock, autolock and "delete everything". Open
// extension pages use this to drop the secrets they decrypted while unlocked.
export function isSessionLockChange(
  changes: { [key: string]: chrome.storage.StorageChange },
  areaName: string,
): boolean {
  const change = changes.cachedPassphrase;
  return (
    areaName === "session" &&
    change !== undefined &&
    Boolean(change.oldValue) &&
    !change.newValue
  );
}

export async function getCurrentTab() {
  const currentWindow = await chrome.windows.getCurrent();
  const queryOptions = { active: true, windowId: currentWindow.id };
  // `tab` will either be a `tabs.Tab` instance or `undefined`.
  const [tab] = await chrome.tabs.query(queryOptions);
  return tab;
}

interface TabWithIdAndURL extends chrome.tabs.Tab {
  id: number;
  url: string;
}

export function okToInjectContentScript(
  tab: chrome.tabs.Tab,
): tab is TabWithIdAndURL {
  return (
    tab.id !== undefined &&
    tab.url !== undefined &&
    (tab.url.startsWith("https://") ||
      tab.url.startsWith("http://") ||
      tab.url.startsWith("file://"))
  );
}
