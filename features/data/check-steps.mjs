#!/usr/bin/env node
// Checks the conformance corpus against its step vocabulary: every step in features/data/**/*.feature
// must match exactly one pattern in STEPS.md (Cucumber Expressions), and every pattern must be used.
// Outline placeholders (<name>) are expanded from the Examples tables before matching.
//   node features/data/check-steps.mjs

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(here, "../../web/package.json"));
const { AstBuilder, GherkinClassicTokenMatcher, Parser } = require("@cucumber/gherkin");
const { IdGenerator } = require("@cucumber/messages");
const { CucumberExpression, ParameterTypeRegistry } = require("@cucumber/cucumber-expressions");

// Patterns are written with a keyword for readability; Cucumber matching ignores keywords.
const patterns = [...fs.readFileSync(path.join(here, "STEPS.md"), "utf8").matchAll(/^\| `([^`]+)` \|/gm)]
  .map((m) => m[1].replace(/^(Given|When|Then|And|But) /, ""));
const registry = new ParameterTypeRegistry();
const expressions = patterns.map((p) => ({ pattern: p, expr: new CucumberExpression(p, registry), used: 0 }));

const files = [];
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith(".feature")) files.push(p);
  }
};
walk(here);

const problems = [];
let scenarios = 0;
let steps = 0;
for (const file of files.sort()) {
  const parser = new Parser(new AstBuilder(IdGenerator.uuid()), new GherkinClassicTokenMatcher());
  const doc = parser.parse(fs.readFileSync(file, "utf8"));
  const background = [];
  for (const child of doc.feature?.children ?? []) {
    if (child.background) background.push(...child.background.steps);
    if (!child.scenario) continue;
    const sc = child.scenario;
    const rows = sc.examples.flatMap((ex) =>
      ex.tableBody.map((r) => Object.fromEntries(ex.tableHeader.cells.map((h, i) => [h.value, r.cells[i].value]))),
    );
    for (const row of rows.length ? rows : [{}]) {
      scenarios++;
      for (const step of [...background, ...sc.steps]) {
        steps++;
        const text = step.text.replace(/<([^>]+)>/g, (m, k) => row[k] ?? m);
        const hits = expressions.filter((e) => e.expr.match(text));
        const where = `${path.relative(process.cwd(), file)}:${step.location.line}`;
        if (hits.length === 0) problems.push(`${where}  no pattern matches: ${step.keyword}${text}`);
        else if (hits.length > 1) problems.push(`${where}  ambiguous (${hits.map((h) => h.pattern).join(" | ")}): ${text}`);
        else {
          hits[0].used++;
          const wantsDoc = hits[0].pattern.endsWith(":");
          if (wantsDoc !== Boolean(step.docString)) problems.push(`${where}  ${wantsDoc ? "needs" : "must not have"} a docstring: ${text}`);
        }
      }
    }
  }
}
for (const e of expressions) if (!e.used) problems.push(`STEPS.md  pattern never used: ${e.pattern}`);

if (problems.length) {
  console.error(problems.join("\n"));
  console.error(`\nFAILED: ${problems.length} problem(s)`);
  process.exit(1);
}
console.log(`OK: ${files.length} features, ${scenarios} scenarios (outlines expanded), ${steps} steps, ${patterns.length} patterns`);
