import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import { claude } from "./agents/claude.js";
import { codex } from "./agents/codex.js";
import { credentialPreamble } from "./agents/types.js";
import type { AgentBackend } from "./agents/types.js";

/**
 * Tests for the shell-level credential preamble.
 *
 * Each backend's credentialPreamble generates bash that runs inside
 * containers. These tests execute the actual shell logic to verify that
 * env vars are correctly unset based on whether a credential file exists.
 */

/** Parse "KEY=value" output lines into a Record. */
function parseEnvOutput(output: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of output.split("\n")) {
    const eq = line.indexOf("=");
    if (eq > 0) result[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return result;
}

/**
 * Run a backend's preamble in a bash subprocess and print surviving env vars.
 * Uses a temp dir to simulate the credential file presence/absence.
 */
function runPreamble(opts: {
  backend: AgentBackend;
  credsFileExists: boolean;
  envVars: Record<string, string>;
}): Record<string, string> {
  const tmpDir = execSync("mktemp -d").toString().trim();
  try {
    const containerPath = opts.backend.credentialContainerPath;
    const credsFile = `${tmpDir}${containerPath}`;
    execSync(`mkdir -p $(dirname ${credsFile})`);
    if (opts.credsFileExists) {
      execSync(`echo '{}' > ${credsFile}`);
    }

    const localPreamble = credentialPreamble(opts.backend)
      .replace(containerPath, credsFile);

    const envExports = Object.entries(opts.envVars)
      .map(([k, v]) => `export ${k}="${v}"`)
      .join("\n");

    const script = [
      `#!/bin/bash`,
      envExports,
      localPreamble,
      ...Object.keys(opts.envVars).map(
        (k) => `echo "${k}=\${${k}:-UNSET}"`,
      ),
    ].join("\n");

    const output = execSync(`bash -c '${script.replace(/'/g, "'\\''")}'`).toString().trim();
    return parseEnvOutput(output);
  } finally {
    execSync(`rm -r ${tmpDir}`);
  }
}

describe("credential preamble – claude (shell)", () => {
  it("unsets both vars when credential file exists", () => {
    const result = runPreamble({
      backend: claude,
      credsFileExists: true,
      envVars: {
        ANTHROPIC_API_KEY: "sk-ant-test",
        CLAUDE_CODE_OAUTH_TOKEN: "tok-test",
      },
    });
    expect(result["ANTHROPIC_API_KEY"]).toBe("UNSET");
    expect(result["CLAUDE_CODE_OAUTH_TOKEN"]).toBe("UNSET");
  });

  it("preserves both vars when no credential file", () => {
    const result = runPreamble({
      backend: claude,
      credsFileExists: false,
      envVars: {
        ANTHROPIC_API_KEY: "sk-ant-test",
        CLAUDE_CODE_OAUTH_TOKEN: "tok-test",
      },
    });
    expect(result["ANTHROPIC_API_KEY"]).toBe("sk-ant-test");
    expect(result["CLAUDE_CODE_OAUTH_TOKEN"]).toBe("tok-test");
  });
});

describe("credential preamble – codex (shell)", () => {
  it("unsets both vars when credential file exists", () => {
    const result = runPreamble({
      backend: codex,
      credsFileExists: true,
      envVars: {
        CODEX_API_KEY: "sk-test",
        OPENAI_API_KEY: "sk-test",
      },
    });
    expect(result["CODEX_API_KEY"]).toBe("UNSET");
    expect(result["OPENAI_API_KEY"]).toBe("UNSET");
  });

  it("preserves both vars when no credential file", () => {
    const result = runPreamble({
      backend: codex,
      credsFileExists: false,
      envVars: {
        CODEX_API_KEY: "sk-test",
        OPENAI_API_KEY: "sk-test",
      },
    });
    expect(result["CODEX_API_KEY"]).toBe("sk-test");
    expect(result["OPENAI_API_KEY"]).toBe("sk-test");
  });
});

/**
 * The .bashrc in agent Dockerfiles sources /run/secrets/*.env then unsets
 * credential-shadowing vars when a creds file exists. This test simulates
 * the full .bashrc flow to ensure env vars from secret files don't shadow
 * the mounted credential file.
 */
function runBashrc(opts: {
  backend: AgentBackend;
  credsFileExists: boolean;
  envFileContent: string;
}): Record<string, string> {
  const tmpDir = execSync("mktemp -d").toString().trim();
  try {
    const containerPath = opts.backend.credentialContainerPath;
    const credsFile = `${tmpDir}${containerPath}`;
    const secretsDir = `${tmpDir}/secrets`;
    execSync(`mkdir -p $(dirname ${credsFile}) ${secretsDir}`);
    if (opts.credsFileExists) {
      execSync(`echo '{}' > ${credsFile}`);
    }
    execSync(`cat > ${secretsDir}/test.env << 'ENVEOF'\n${opts.envFileContent}\nENVEOF`);

    const preamble = credentialPreamble(opts.backend).replace(containerPath, credsFile);

    const bashrc = [
      `if [ -d ${secretsDir} ]; then for _f in ${secretsDir}/*.env; do [ -f "$_f" ] && set -a && . "$_f" && set +a; done; unset _f; fi`,
      preamble,
    ].join("\n");

    const varNames = [...opts.backend.credentialShadowVars];
    const script = [
      `#!/bin/bash`,
      bashrc,
      ...varNames.map((k) => `echo "${k}=\${${k}:-UNSET}"`),
    ].join("\n");

    const output = execSync(`bash -c '${script.replace(/'/g, "'\\''")}'`).toString().trim();
    return parseEnvOutput(output);
  } finally {
    execSync(`rm -r ${tmpDir}`);
  }
}

describe("bashrc credential cleanup – claude (shell)", () => {
  it("unsets both vars when credential file exists (even if env file sets them)", () => {
    const result = runBashrc({
      backend: claude,
      credsFileExists: true,
      envFileContent: "CLAUDE_CODE_OAUTH_TOKEN=tok-from-env\nANTHROPIC_API_KEY=sk-ant-from-env",
    });
    expect(result["CLAUDE_CODE_OAUTH_TOKEN"]).toBe("UNSET");
    expect(result["ANTHROPIC_API_KEY"]).toBe("UNSET");
  });

  it("preserves env file vars when no credential file", () => {
    const result = runBashrc({
      backend: claude,
      credsFileExists: false,
      envFileContent: "CLAUDE_CODE_OAUTH_TOKEN=tok-from-env\nANTHROPIC_API_KEY=sk-ant-from-env",
    });
    expect(result["CLAUDE_CODE_OAUTH_TOKEN"]).toBe("tok-from-env");
    expect(result["ANTHROPIC_API_KEY"]).toBe("sk-ant-from-env");
  });
});

describe("bashrc credential cleanup – codex (shell)", () => {
  it("unsets both vars when credential file exists (even if env file sets them)", () => {
    const result = runBashrc({
      backend: codex,
      credsFileExists: true,
      envFileContent: "CODEX_API_KEY=sk-from-env\nOPENAI_API_KEY=sk-from-env",
    });
    expect(result["CODEX_API_KEY"]).toBe("UNSET");
    expect(result["OPENAI_API_KEY"]).toBe("UNSET");
  });

  it("preserves env file vars when no credential file", () => {
    const result = runBashrc({
      backend: codex,
      credsFileExists: false,
      envFileContent: "CODEX_API_KEY=sk-from-env\nOPENAI_API_KEY=sk-from-env",
    });
    expect(result["CODEX_API_KEY"]).toBe("sk-from-env");
    expect(result["OPENAI_API_KEY"]).toBe("sk-from-env");
  });
});
