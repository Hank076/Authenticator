import { argonHashEncoded, argonVerifyEncoded } from "./argon-core";

// tsconfig only has the DOM lib, where `self` is a Window; describe the part
// of the worker scope used here.
const scope = self as unknown as {
  addEventListener(
    type: "message",
    listener: (event: MessageEvent) => void,
  ): void;
  postMessage(message: unknown): void;
};

// argon2 takes ~100 ms per call in JS; running it here keeps the popup
// responsive while it unlocks. Replies echo the request id.
scope.addEventListener("message", (event: MessageEvent) => {
  const { id, action, value, salt, hash } = event.data || {};
  let response: string | boolean | undefined;
  try {
    if (action === "hash") {
      response = argonHashEncoded(value, salt);
    } else if (action === "verify") {
      response = argonVerifyEncoded(value, hash);
    } else {
      return;
    }
    scope.postMessage({ id, response });
  } catch (error) {
    scope.postMessage({ id, error: String(error) });
  }
});
