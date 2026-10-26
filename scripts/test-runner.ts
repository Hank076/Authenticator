// Runs tests via puppeteer. Do not compile using webpack.

import puppeteer from "puppeteer";
import path from "path";
import fs from "fs";
import { execSync } from "child_process";
import { MochaTestResults, printTestResults } from "./test-report";

async function runTests() {
  const puppeteerArgs: string[] = [
    `--load-extension=${path.resolve(__dirname, "../test/chrome")}`,
    // for CI
    "--no-sandbox",
    "--lang=en-US,en"
  ];

  const browser = await puppeteer.launch({
    ignoreDefaultArgs: ["--disable-extensions"],
    args: puppeteerArgs,
    // chrome extensions don't work in headless
    headless: false,
    executablePath: process.env.PUPPETEER_EXEC_PATH,
  });
  const mochaPage = await browser.newPage();
  await mochaPage.goto(
    "chrome-extension://bhghoamapcdpbohphigoooaddinpkbai/view/test.html"
  );

  // by setting this env var, console logging works for both components and testing
  if (process.env.ENABLE_CONSOLE) {
    mochaPage.on("console", consoleMessage => console.log(consoleMessage.text()));
  }

  const results: {
    testResults: MochaTestResults;
  } = await mochaPage.evaluate(() => {
    return new Promise((resolve: (value: {
    testResults: MochaTestResults;
  }) => void) => {
      window.addEventListener("testsComplete", () => {
        resolve({
          testResults: window.__mocha_test_results__,
        });
      });

      if (window.__mocha_test_results__.completed) {
        resolve({
          testResults: window.__mocha_test_results__,
        });
      }
    });
  });

  const failedTest = printTestResults(results?.testResults);
  process.exit(failedTest ? 1 : 0);
}

runTests().catch(e => {
  console.error(e);
  process.exit(1);
});
