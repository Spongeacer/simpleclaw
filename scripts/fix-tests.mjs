/**
 * One-time script: convert test files from positional AgentEngine args to options bag.
 * Uses bracket-counting to handle nested objects and expressions.
 */

import { readFileSync, writeFileSync, readdirSync } from "fs";
import { join } from "path";

const files = readdirSync("tests").filter(f => f.startsWith("test-") && f.endsWith(".mjs"));

function findAgentEngineCalls(content) {
  const results = [];
  let idx = 0;
  while (true) {
    const start = content.indexOf("new AgentEngine(", idx);
    if (start === -1) break;
    const argsStart = start + "new AgentEngine(".length;
    let depth = 1;
    let end = argsStart;
    while (depth > 0 && end < content.length) {
      const ch = content[end];
      if (ch === "(") depth++;
      else if (ch === ")") depth--;
      else if (ch === "`") {
        // skip template literal
        end++;
        while (end < content.length && content[end] !== "`") {
          if (content[end] === "\\") end++;
          end++;
        }
      }
      else if (ch === "'" || ch === '"') {
        const quote = ch;
        end++;
        while (end < content.length && content[end] !== quote) {
          if (content[end] === "\\") end++;
          end++;
        }
      }
      end++;
    }
    results.push({ start, end: end - 1, raw: content.slice(argsStart, end - 1) });
    idx = end;
  }
  return results;
}

function splitArgs(raw) {
  const args = [];
  let depth = 0;
  let current = "";
  let inString = false;
  let stringChar = "";
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (inString) {
      current += ch;
      if (ch === "\\") { current += raw[++i]; continue; }
      if (ch === stringChar) inString = false;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      inString = true;
      stringChar = ch;
      current += ch;
      continue;
    }
    if (ch === "(" || ch === "{" || ch === "[") { depth++; current += ch; continue; }
    if (ch === ")" || ch === "}" || ch === "]") { depth--; current += ch; continue; }
    if (ch === "," && depth === 0) {
      args.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) args.push(current.trim());
  return args;
}

for (const file of files) {
  const path = join("tests", file);
  let content = readFileSync(path, "utf-8");
  const calls = findAgentEngineCalls(content);
  if (calls.length === 0) continue;

  let changed = false;
  for (let i = calls.length - 1; i >= 0; i--) {
    const { start, end, raw } = calls[i];
    const args = splitArgs(raw);
    if (args.length === 6) {
      const [config, store, llm, tools, approval, logger] = args;
      const replacement = `new AgentEngine({\n    config: ${config},\n    store: ${store},\n    llm: ${llm},\n    tools: ${tools},\n    approval: ${approval},\n    logger: ${logger}\n  })`;
      content = content.slice(0, start) + replacement + content.slice(end + 1);
      changed = true;
    } else if (args.length === 1) {
      // Already options bag (or something else), skip
      console.log(`  ${file}: args.length=${args.length}, skipping`);
    } else {
      console.log(`  ${file}: args.length=${args.length}, skipping`);
    }
  }

  if (changed) {
    writeFileSync(path, content, "utf-8");
    console.log(`Updated ${file}`);
  }
}

console.log("Done.");
