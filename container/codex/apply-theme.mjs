#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";

const configPath = "/home/agent/.codex/config.toml";
const theme = process.env.AGENTD_THEME;

if (!theme) process.exit(0);

const escapedTheme = theme.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"");
const themeLine = `theme = "${escapedTheme}"`;
const raw = readFileSync(configPath, "utf8");
const lines = raw.split(/\r?\n/);

let tuiStart = -1;
let tuiEnd = lines.length;
for (let i = 0; i < lines.length; i++) {
  const section = lines[i]?.match(/^\s*\[([^\]]+)\]\s*$/);
  if (!section) continue;
  if (section[1]?.trim() === "tui") {
    tuiStart = i;
    continue;
  }
  if (tuiStart !== -1) {
    tuiEnd = i;
    break;
  }
}

if (tuiStart === -1) {
  const next = raw.endsWith("\n") ? raw : `${raw}\n`;
  writeFileSync(configPath, `${next}\n[tui]\n${themeLine}\n`);
  process.exit(0);
}

for (let i = tuiStart + 1; i < tuiEnd; i++) {
  if (/^\s*theme\s*=/.test(lines[i] ?? "")) {
    lines[i] = themeLine;
    writeFileSync(configPath, `${lines.join("\n")}\n`);
    process.exit(0);
  }
}

lines.splice(tuiEnd, 0, themeLine);
writeFileSync(configPath, `${lines.join("\n")}\n`);
