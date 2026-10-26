import { EntryStorage } from "./models/storage";
import { isSessionLockChange } from "./utils";

// Reload this extension page when the cached passphrase is cleared while a
// master password is still set. The reload discards the secrets and plaintext
// export this page decrypted, so a lock (manual, autolock or from another
// page) can't leave codes running in an already-open popup or import page.
// Without a Key record (password removed, data deleted) there is nothing
// encrypted to protect, so the page keeps its state and any pending notice.
export function reloadOnLock() {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (!isSessionLockChange(changes, areaName)) {
      return;
    }
    EntryStorage.hasEncryptionKey()
      .then((hasKey) => {
        if (hasKey) {
          location.reload();
        }
      })
      .catch((error) => console.error(error));
  });
}
