import { join } from "node:path";
import { homedir } from "node:os";

export function createPaths(home: string) {
  return {
    home,
    stateFile: join(home, "state.json"),
    secretFile: (scope: string) =>
      join(home, "secrets", `${scope}.env`),
  } as const;
}

export type Paths = ReturnType<typeof createPaths>;

const AGENTD_HOME =
  process.env["AGENTD_HOME"] ?? join(homedir(), ".agentd");

export const paths = createPaths(AGENTD_HOME);
