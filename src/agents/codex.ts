import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { AgentBackend } from "./types.js";
import type { Paths } from "../paths.js";

/**
 * Flags shared by all codex invocations inside the container.
 * --dangerously-bypass-approvals-and-sandbox disables the OS-level sandbox
 * (Seatbelt/bubblewrap) which fails under Docker's --cap-drop ALL.
 * The Docker container itself provides isolation.
 */
const BASE_FLAGS = "--dangerously-bypass-approvals-and-sandbox";
const CODEX_LIGHT_THEME = "github";
const CODEX_DARK_THEME = "two-dark";

export function readCodexThemeOverride(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env["AGENTD_CODEX_THEME"] ?? env["CODEX_THEME"] ?? undefined;
}

function shellQuote(arg: string): string {
  return `'${arg.replaceAll("'", "'\\''")}'`;
}

function buildCodexBaseCommand(model?: string): string {
  const cmd = ["codex", BASE_FLAGS];
  if (model) cmd.push("--model", model);

  return [
    `cmd=(${cmd.map(shellQuote).join(" ")})`,
    `if [ -n "$AGENTD_THEME" ]; then cmd+=(-c "tui.theme=$AGENTD_THEME"); fi`,
  ].join("; ");
}

export function readCodexThemeFromToml(raw: string): string | undefined {
  let inTui = false;
  for (const line of raw.split(/\r?\n/)) {
    const section = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (section) {
      inTui = section[1]?.trim() === "tui";
      continue;
    }
    if (!inTui) continue;
    const theme = line.match(/^\s*theme\s*=\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')\s*(?:#.*)?$/);
    const value = theme?.[1] ?? theme?.[2];
    if (value != null) {
      return value.replaceAll(String.raw`\"`, "\"").replaceAll(String.raw`\\`, "\\");
    }
  }
  return undefined;
}

export function inferCodexThemeFromColorFgbg(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const parts = raw.split(";").map((part) => Number.parseInt(part, 10)).filter((n) => Number.isFinite(n));
  const bg = parts.at(-1);
  if (bg == null) return undefined;
  return bg >= 9 || bg === 7 ? CODEX_LIGHT_THEME : CODEX_DARK_THEME;
}

export function inferCodexThemeFromOsc11(raw: string): string | undefined {
  const match = raw.match(/\]11;rgb:([0-9a-fA-F]{2,4})\/([0-9a-fA-F]{2,4})\/([0-9a-fA-F]{2,4})/);
  if (!match) return undefined;
  const [, rs, gs, bs] = match;
  if (!rs || !gs || !bs) return undefined;

  const toByte = (value: string): number => {
    const n = Number.parseInt(value, 16);
    return value.length <= 2 ? n : Math.round(n / 257);
  };

  const r = toByte(rs);
  const g = toByte(gs);
  const b = toByte(bs);
  const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return luminance >= 0.6 ? CODEX_LIGHT_THEME : CODEX_DARK_THEME;
}

export function inferCodexThemeFromAppleInterfaceStyle(raw: string | undefined): string | undefined {
  if (raw == null) return undefined;
  return raw.trim() === "Dark" ? CODEX_DARK_THEME : CODEX_LIGHT_THEME;
}

function readMacSystemAppearanceTheme(): string | undefined {
  if (process.platform !== "darwin") return undefined;
  try {
    const raw = execFileSync("defaults", ["read", "-g", "AppleInterfaceStyle"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return inferCodexThemeFromAppleInterfaceStyle(raw);
  } catch {
    // `defaults read` exits non-zero when the system appearance is Light.
    return CODEX_LIGHT_THEME;
  }
}

function resolveOsc11QueryTarget(env: NodeJS.ProcessEnv = process.env): { tty: string; query: string } {
  if (env["TMUX"]) {
    try {
      const clientTty = execFileSync("tmux", ["display-message", "-p", "#{client_tty}"], {
        encoding: "utf8",
      }).trim();
      if (clientTty) {
        return { tty: clientTty, query: "\x1b]11;?\x07" };
      }
    } catch {
      // Fall back to querying through the pane TTY below.
    }
  }

  const query = env["TMUX"]
    ? "\x1bPtmux;\x1b\x1b]11;?\x07\x1b\\"
    : "\x1b]11;?\x07";
  return { tty: "/dev/tty", query };
}

function queryTerminalForOsc11(): string | undefined {
  const { tty, query } = resolveOsc11QueryTarget();
  const script = `
tty="$AGENTD_OSC11_TTY"
[ -r "$tty" ] && [ -w "$tty" ] || exit 0
old=$(stty -g <"$tty" 2>/dev/null) || exit 0
cleanup() {
  stty "$old" <"$tty" >"$tty" 2>/dev/null || true
}
trap cleanup EXIT INT TERM
stty raw -echo min 0 time 10 <"$tty" >"$tty" 2>/dev/null || exit 0
printf '%s' "$AGENTD_OSC11_QUERY" >"$tty" || exit 0
dd bs=1 count=1024 <"$tty" 2>/dev/null || true
`;

  try {
    const output = execFileSync("bash", ["-c", script], {
      env: { ...process.env, AGENTD_OSC11_QUERY: query, AGENTD_OSC11_TTY: tty },
    }).toString("utf8");
    return output || undefined;
  } catch {
    return undefined;
  }
}

export async function detectCodexTheme(env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  const fromEnv = inferCodexThemeFromColorFgbg(env["COLORFGBG"]);
  if (fromEnv) return fromEnv;

  const macSystemTheme = readMacSystemAppearanceTheme();

  // Under host tmux, OSC 11 query/response is often swallowed by tmux itself.
  // Fall back to the host OS appearance before trying terminal queries there.
  if (env["TMUX"] && macSystemTheme) return macSystemTheme;

  const osc11 = await queryTerminalForOsc11();
  const fromOsc11 = osc11 ? inferCodexThemeFromOsc11(osc11) : undefined;
  if (fromOsc11) return fromOsc11;

  return macSystemTheme;
}

export const codex: AgentBackend = {
  name: "codex",
  dockerImage: "agentd-codex:latest",
  defaultModel: "gpt-5.4",

  credentialShadowVars: ["CODEX_API_KEY", "OPENAI_API_KEY"],

  credentialHostPath(paths: Paths): string {
    return join(paths.home, "secrets", "codex-auth.json");
  },

  credentialContainerPath: "/home/agent/.codex/auth.json",

  startCommand(model?: string): string {
    return `${buildCodexBaseCommand(model)}; "\${cmd[@]}"`;
  },

  resumeCommand(model?: string): string {
    return `${buildCodexBaseCommand(model)}; "\${cmd[@]}" resume --last || "\${cmd[@]}"`;
  },

  defaultSecretScope: "codex",

  secretMissingHint(path: string): string {
    return `Create it with: echo "CODEX_API_KEY=sk-..." > ${path}`;
  },

  noAuthWarning: "Warning: no --secret passed, Codex will prompt for login",

  async hostTheme(): Promise<string | undefined> {
    const explicit = await this.explicitHostTheme?.();
    if (explicit) return explicit;
    return await detectCodexTheme();
  },

  explicitHostTheme(): string | undefined {
    const override = readCodexThemeOverride();
    if (override) return override;

    try {
      const raw = readFileSync(join(homedir(), ".codex", "config.toml"), "utf-8");
      return readCodexThemeFromToml(raw);
    } catch { /* missing or unreadable */ }
    return undefined;
  },

  applyThemeCommand(): string {
    return `[ -z "$AGENTD_THEME" ] || node /agentd/apply-codex-theme.mjs`;
  },
};
