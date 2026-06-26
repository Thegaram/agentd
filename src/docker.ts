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

/** Parse `docker ps -a --format '{{.ID}}\t{{.State}}'` into fullId → state. */
export function parseContainerStates(stdout: string): Map<string, ContainerState> {
  const map = new Map<string, ContainerState>();
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [id, state] = trimmed.split("\t");
    if (!id) continue;
    map.set(id, state === "running" ? "running" : "stopped");
  }
  return map;
}

/**
 * One batched call returning every container's state keyed by full ID.
 * Throws on daemon failure (callers distinguish "daemon down" from "container
 * absent" — an absent ID simply isn't in the returned map).
 */
export async function dockerListStates(): Promise<Map<string, ContainerState>> {
  const { stdout } = await execFileAsync("docker", [
    "ps", "-a", "--no-trunc", "--format", "{{.ID}}\t{{.State}}",
  ]);
  return parseContainerStates(stdout);
}

export interface ContainerStats {
  cpu: string;
  mem: string;
}

/** Parse `docker stats --no-stream` output into shortId → {cpu, mem(used)}. */
export function parseContainerStats(stdout: string): Map<string, ContainerStats> {
  const map = new Map<string, ContainerStats>();
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [id, cpu, mem] = trimmed.split("\t");
    if (!id) continue;
    const memUsed = mem?.split("/")[0]?.trim() ?? "";
    map.set(id, { cpu: (cpu ?? "").trim(), mem: memUsed });
  }
  return map;
}

/**
 * One batched call returning live CPU/mem for running containers, keyed by
 * short ID. Non-fatal: returns an empty map if stats are unavailable.
 */
export async function dockerStats(): Promise<Map<string, ContainerStats>> {
  try {
    const { stdout } = await execFileAsync("docker", [
      "stats", "--no-stream", "--format", "{{.ID}}\t{{.CPUPerc}}\t{{.MemUsage}}",
    ]);
    return parseContainerStats(stdout);
  } catch {
    return new Map();
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
