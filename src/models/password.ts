import { BrowserStorage, isOldKey } from "./storage";

let argonWorker: Worker | undefined;

function getArgonWorker(): Worker {
  if (!argonWorker) {
    argonWorker = new Worker(chrome.runtime.getURL("js/argon-worker.js"));
  }
  return argonWorker;
}

// A hung or crashed worker is discarded; the next call starts a new one.
function resetArgonWorker() {
  argonWorker?.terminate();
  argonWorker = undefined;
}

// One argon2 round-trip to the worker. Every request carries a unique id and
// only the reply with that id settles it, so overlapping calls can't swap
// results. A timeout turns a hung worker into a rejection.
function callArgonWorker(message: {
  action: "hash" | "verify";
  [key: string]: unknown;
}): Promise<unknown> {
  const worker = getArgonWorker();
  const id = crypto.randomUUID();

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      worker.removeEventListener("message", handler);
      worker.removeEventListener("error", onError);
      clearTimeout(timer);
    };
    const handler = (event: MessageEvent) => {
      if (!event.data || event.data.id !== id) {
        return;
      }
      cleanup();
      if (event.data.error) {
        reject(new Error(event.data.error));
      } else {
        resolve(event.data.response);
      }
    };
    const onError = (event: ErrorEvent) => {
      cleanup();
      resetArgonWorker();
      reject(new Error("argon2 worker failed: " + event.message));
    };
    const timer = setTimeout(() => {
      cleanup();
      resetArgonWorker();
      reject(new Error("argon2 worker timed out"));
    }, 60000);
    worker.addEventListener("message", handler);
    worker.addEventListener("error", onError);
    worker.postMessage({ ...message, id });
  });
}

export async function argonHash(
  value: string,
  salt: string,
): Promise<string | undefined> {
  return (await callArgonWorker({ action: "hash", value, salt })) as
    string | undefined;
}

export async function argonVerify(
  value: string,
  hash: string,
): Promise<boolean> {
  return (await callArgonWorker({ action: "verify", value, hash })) as boolean;
}

// Verify a password using keys in BrowserStorage
export async function verifyPasswordUsingKeyID(
  keyId: string,
  password: string,
): Promise<boolean> {
  // Get key for current encryption
  const keys = await BrowserStorage.getKeys();
  if (isOldKey(keys)) {
    throw new Error(
      "v3 encryption not being used with verifyPassword. This should never happen!",
    );
  }

  const key = keys.find((key) => key.id === keyId);
  if (!key) {
    throw new Error(`Key ${keyId} not in BrowserStorage`);
  }

  return verifyPasswordUsingKey(key, password);
}

export async function verifyPasswordUsingKey(
  key: Key,
  password: string,
): Promise<boolean> {
  // Hash password with argon
  const rawHash = await argonHash(password, key.salt);
  if (!rawHash) {
    throw new Error("argon2 did not return a hash!");
  }
  // https://passlib.readthedocs.io/en/stable/lib/passlib.hash.argon2.html#format-algorithm
  const possibleHash = rawHash.split("$")[5];

  // verify user password by comparing their password hash with the
  // hash of their password's hash
  return await argonVerify(possibleHash, key.hash);
}
