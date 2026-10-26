// Renders view/licenses.html from the production dependency tree reported by
// `pnpm licenses list`, grouping packages that share the same license text.
// Usage: node scripts/generate-licenses.js <template> <out-path>
// Exits non-zero when a package ships no license text and has no override, so
// a release never goes out with an incomplete acknowledgement page.
"use strict";

const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const Mustache = require("mustache");

const [templatePath, outPath] = process.argv.slice(2);
if (!templatePath || !outPath) {
  console.error(
    "Usage: node scripts/generate-licenses.js <template> <out-path>",
  );
  process.exit(1);
}

// Packages that publish no license file. The text is the standard license
// body plus the copyright line the package itself carries.
const LICENSE_TEXT_OVERRIDES = {
  // dist/qrcode.js header: "Copyright (c) 2009 Kazuhiko Arase", MIT
  "qrcode-generator": `MIT License

Copyright (c) 2009 Kazuhiko Arase

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`,
};

const LICENSE_FILE = /^(licen[sc]e|copying)([.-].*)?$/i;

function readLicenseText(pkg) {
  for (const dir of pkg.paths || []) {
    const file = fs.readdirSync(dir).find((name) => LICENSE_FILE.test(name));
    if (file) {
      return fs.readFileSync(path.join(dir, file), "utf8").trim();
    }
  }
  return LICENSE_TEXT_OVERRIDES[pkg.name] || null;
}

const report = JSON.parse(
  execFileSync("pnpm", ["licenses", "list", "--json", "--prod"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  }),
);

const groups = new Map();
const missing = [];
for (const pkgs of Object.values(report)) {
  for (const pkg of pkgs) {
    const text = readLicenseText(pkg);
    if (!text) {
      missing.push(`${pkg.name}@${pkg.versions.join(",")}`);
      continue;
    }
    if (!groups.has(text)) {
      groups.set(text, []);
    }
    groups.get(text).push({ name: pkg.name, homepage: pkg.homepage || "" });
  }
}

if (missing.length) {
  console.error(`No license text found for: ${missing.join(", ")}`);
  process.exit(1);
}

const renderLicenses = [...groups.entries()]
  .map(([text, pkgs]) => {
    pkgs.sort((a, b) => a.name.localeCompare(b.name));
    return {
      text,
      pkgs: pkgs.map((pkg, i) => ({ ...pkg, comma: i < pkgs.length - 1 })),
    };
  })
  .sort((a, b) => a.pkgs[0].name.localeCompare(b.pkgs[0].name));

const template = fs.readFileSync(templatePath, "utf8");
fs.writeFileSync(outPath, Mustache.render(template, { renderLicenses }));
console.log(
  `Wrote ${outPath}: ${groups.size} license texts, ${renderLicenses.reduce(
    (n, g) => n + g.pkgs.length,
    0,
  )} packages`,
);
