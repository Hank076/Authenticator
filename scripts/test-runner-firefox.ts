// Runs tests in Firefox via puppeteer (WebDriver BiDi). Do not compile using webpack.
// Uses puppeteer's Firefox (`pnpm exec puppeteer browsers install firefox`)
// unless FIREFOX_BIN points to another binary.

import puppeteer from "puppeteer";
import path from "path";
import { MochaTestResults, printTestResults } from "./test-report";

// browser_specific_settings.gecko.id in manifests/manifest-firefox-testing.json
const GECKO_ID = "{aa04367e-4dc8-4833-87a1-43ee93ce9a42}";
// Fixed moz-extension UUID so the test page has a known URL.
const EXTENSION_UUID = "0a7e3c11-5b2d-4f6e-9c8a-1d2e3f405162";
const TIMEOUT_MS = 120000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function runTests() {
  const browser = await puppeteer.launch({
    browser: "firefox",
    // match the Chrome runner, which needs a display for extensions
    headless: false,
    executablePath: process.env.FIREFOX_BIN,
    // BiDi only navigates and scripts moz-extension pages with system access.
    args: ["-remote-allow-system-access"],
    extraPrefsFirefox: {
      "extensions.webextensions.uuids": JSON.stringify({
        [GECKO_ID]: EXTENSION_UUID,
      }),
    },
  });

  let testResults: MochaTestResults | undefined;
  try {
    await browser.installExtension(path.resolve(__dirname, "../test/firefox"));

    const mochaPage = await browser.newPage();
    // by setting this env var, console logging works for both components and testing
    if (process.env.ENABLE_CONSOLE) {
      mochaPage.on("console", consoleMessage => console.log(consoleMessage.text()));
    }

    // Extension pages never report the load event to BiDi, so the navigation
    // times out even though the page is running.
    await mochaPage
      .goto(`moz-extension://${EXTENSION_UUID}/view/test.html`, {
        waitUntil: "domcontentloaded",
        timeout: 5000,
      })
      .catch(() => undefined);

    const deadline = Date.now() + TIMEOUT_MS;
    while (Date.now() < deadline) {
      testResults = await mochaPage
        .evaluate(() => window.__mocha_test_results__)
        .catch(() => undefined);
      if (testResults?.completed) {
        break;
      }
      await sleep(1000);
    }
  } finally {
    await browser.close();
  }

  if (!testResults?.completed) {
    console.error(`Tests did not complete within ${TIMEOUT_MS / 1000} seconds.`);
    process.exit(1);
  }
  if (!testResults.tests?.length) {
    console.error("No tests were run.");
    process.exit(1);
  }

  const failedTest = printTestResults(testResults);
  process.exit(failedTest ? 1 : 0);
}

runTests().catch(e => {
  console.error(e);
  process.exit(1);
});
