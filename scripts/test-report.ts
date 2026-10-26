// Shared result types and console report for the puppeteer test runners.

import merge from "lodash/merge";

export interface MochaTestResults {
  total?: number;
  tests?: StrippedTestResults[];
  completed?: boolean;
}

export interface StrippedTestResults {
  title: string;
  duration: number;
  path: string[];
  err?: string;
  status: "failed" | "passed" | "pending";
}

declare global {
  interface Window {
    __mocha_test_results__: MochaTestResults;
  }
}
interface TestDisplay {
  [key: string]: TestDisplay | StrippedTestResults
}

const colors = {
  reset: "\x1b[0m",
  green: "\x1b[32m",
  red: "\x1b[31m",
}

// Prints the tests as a tree and returns true when any test failed.
export function printTestResults(testResults: MochaTestResults | undefined): boolean {
  let failedTest = false;
  let display: TestDisplay = {};
  if (testResults?.tests) {
    for (const test of testResults.tests) {
      let tmp: TestDisplay = {};
      test.path.reduce((acc, current, index) => {
        return acc[current] = test.path.length - 1 === index ? test : {}
      }, tmp);
      display = merge(display, tmp);
    }
  }

  const printDisplayTests = (display: TestDisplay | StrippedTestResults) => {
    for (const key in display) {
      if (typeof display[key].status === "string") {
        const test = display[key];
        switch (test.status) {
          case "passed":
            console.log(`${colors.green}✓${colors.reset} ${test.title}`);
            break;
          case "failed":
            console.log(`${colors.red}✗ ${test.title}${colors.reset}`);
            if (test.err) {
              console.log(test.err)
            }
            failedTest = true;
            break;
          case "pending":
            console.log(`- ${test.title}`);
            break;
        }
      } else {
        console.log(key)
        console.group();
        printDisplayTests(display[key]);
      }
    }
    console.groupEnd();
  }
  printDisplayTests(display);
  return failedTest;
}
