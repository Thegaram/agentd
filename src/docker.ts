import { execFile } from "node:child_process";
import { execFileSync } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type ContainerState = "running" | "stopped" | "missing";

export async function dockerImageExists(image: string): Promise<boolean> {
  try {
    await execFileAsync("docker", ["image", "inspect", image]);
    return true;
  } catch {
    return false;
  }
}

export async function dockerCreate(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("docker", ["create", ...args]);
  return stdout.trim();
}

export async function dockerStart(containerId: string): Promise<void> {
  await execFileAsync("docker", ["start", containerId]);
}

export async function dockerRemove(containerId: string): Promise<void> {
  await execFileAsync("docker", ["rm", "-f", containerId]);
}

/**
 * "missing" when the container truly doesn't exist; "error" for daemon
 * outages, permission issues, etc. The distinction matters because callers
 * use "missing" as authoritative ("no such container") and must not act on
 * transient daemon errors.
 */
export function classifyInspectError(stderr: string): "missing" | "error" {
  return /no such (container|object)/i.test(stderr) ? "missing" : "error";
}

export async function dockerInspectState(
  containerId: string,
): Promise<ContainerState> {
  try {
    const { stdout } = await execFileAsync("docker", [
      "inspect", "-f", "{{.State.Running}}", containerId,
    ]);
    return stdout.trim() === "true" ? "running" : "stopped";
  } catch (e) {
    const stderr = (e as { stderr?: string }).stderr ?? "";
    if (classifyInspectError(stderr) === "missing") return "missing";
    const msg = stderr.trim() || (e as Error).message;
    throw new Error(`docker inspect failed: ${msg}`, { cause: e });
  }
}

export async function dockerExec(
  containerId: string,
  cmd: string[],
): Promise<void> {
  await execFileAsync("docker", ["exec", containerId, ...cmd]);
}

export async function dockerCp(src: string, dest: string): Promise<void> {
  await execFileAsync("docker", ["cp", src, dest]);
}

export async function dockerLogs(
  containerId: string,
  tailLines = 20,
): Promise<string> {
  try {
    const { stdout, stderr } = await execFileAsync("docker", [
      "logs", "--tail", String(tailLines), containerId,
    ]);
    return [stdout, stderr].filter(Boolean).join("").trim();
  } catch {
    return "";
  }
}

export async function dockerInspectExit(
  containerId: string,
): Promise<{ exitCode: number; error: string } | null> {
  try {
    const { stdout } = await execFileAsync("docker", [
      "inspect", "-f", "{{.State.ExitCode}}|{{.State.Error}}", containerId,
    ]);
    const [code, ...rest] = stdout.trim().split("|");
    return { exitCode: Number(code), error: rest.join("|") };
  } catch {
    return null;
  }
}

export async function dockerPort(containerId: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("docker", ["port", containerId]);
    return stdout.trim();
  } catch {
    return "";
  }
}

export function dockerAttachSync(containerId: string): void {
  execFileSync(
    "docker",
    ["exec", "-it", containerId, "tmux", "attach", "-t", "agent"],
    // Inherit stdin/stdout for the interactive session, suppress stderr
    // to avoid Docker Desktop promotional messages on exit.
    { stdio: ["inherit", "inherit", "ignore"] },
  );
}
