// Test set for the short-skill boundary logic (lib/termMatch.mjs) — the rules
// behind "C" matching/highlighting a standalone "C" but not "Cruise". The repo
// has no test framework; this is a plain Node + node:assert script, run via
// `npm run test:match`. Deterministic, needs no data files.

import assert from "node:assert/strict";
import { isShortAlphaTerm, boundedMatch } from "../lib/termMatch.mjs";

let passed = 0;
const failures = [];

function check(label, actual, expected) {
  try {
    assert.deepEqual(actual, expected);
    passed++;
  } catch {
    failures.push(`${label}: expected ${expected}, got ${actual}`);
  }
}

// --- isShortAlphaTerm: only purely 1–2-letter terms are "short" ---------------
for (const t of ["C", "R", "Go", "AI", "c", "go"]) {
  check(`isShortAlphaTerm(${t})`, isShortAlphaTerm(t), true);
}
for (const t of ["C#", "C++", ".NET", "F#", "AWS", "Java", "Python", "Go ", ""]) {
  check(`isShortAlphaTerm(${JSON.stringify(t)})`, isShortAlphaTerm(t), false);
}

// --- boundedMatch: whole-token, boundary-delimited, case-insensitive ----------
const cases = [
  ["Strong C, R, and Devops", "C", true],
  ["Cruise control", "C", false],
  ["JavaScript", "C", false],
  ["React", "R", false],
  ["R and Python", "R", true],
  ["Golang", "Go", false],
  ["Go developer", "Go", true],
  ["Google", "Go", false],
  ["C# and C++ shop", "C#", true],
  ["C# and C++ shop", "C", false],
  ["ASP.NET role", ".NET", false],
  [".NET Core", ".NET", true],
  ["database engineer", "data", false],
  ["data pipeline", "data", true],
  ["JavaScript", "java", false],
  ["Java 17", "Java", true],
  ["F# functional", "F#", true],
  ["C++ and C", "C", true], // standalone "C" after the C++ token
];
for (const [text, term, expected] of cases) {
  check(`boundedMatch(${JSON.stringify(text)}, ${JSON.stringify(term)})`, boundedMatch(text, term), expected);
}

if (failures.length) {
  console.error(`\n✖ ${failures.length} failed, ${passed} passed:\n`);
  for (const f of failures) console.error("  - " + f);
  process.exit(1);
}
console.log(`✓ all ${passed} term-matching cases passed`);
