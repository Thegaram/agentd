import { describe, it, expect } from "vitest";
import {
  classifyInspectError,
  parseContainerStates,
  parseContainerStats,
} from "./docker.js";

describe("classifyInspectError", () => {
  it("classifies 'No such container' as missing", () => {
    expect(classifyInspectError("Error: No such container: abc123")).toBe("missing");
  });

  it("classifies 'No such object' as missing", () => {
    expect(
      classifyInspectError("Error response from daemon: No such object: abc123"),
    ).toBe("missing");
  });

  it("is case-insensitive", () => {
    expect(classifyInspectError("error: no such container: x")).toBe("missing");
  });

  it("classifies daemon-unreachable as error", () => {
    expect(
      classifyInspectError(
        "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?",
      ),
    ).toBe("error");
  });

  it("classifies permission denied as error", () => {
    expect(
      classifyInspectError("permission denied while trying to connect to docker daemon"),
    ).toBe("error");
  });

  it("classifies empty stderr as error", () => {
    expect(classifyInspectError("")).toBe("error");
  });
});

describe("parseContainerStates", () => {
  it("maps full IDs to running/stopped, treating non-running as stopped", () => {
    const out = "abc123\trunning\ndef456\texited\nghi789\tcreated\n";
    const map = parseContainerStates(out);
    expect(map.get("abc123")).toBe("running");
    expect(map.get("def456")).toBe("stopped");
    expect(map.get("ghi789")).toBe("stopped");
    expect(map.size).toBe(3);
  });

  it("ignores blank lines and empty output", () => {
    expect(parseContainerStates("").size).toBe(0);
    expect(parseContainerStates("\n\n").size).toBe(0);
  });
});

describe("parseContainerStats", () => {
  it("keys by short ID and keeps only the used portion of memory", () => {
    const out = "abc123\t0.20%\t45.2MiB / 7.66GiB\n";
    const map = parseContainerStats(out);
    expect(map.get("abc123")).toEqual({ cpu: "0.20%", mem: "45.2MiB" });
  });

  it("tolerates missing fields and blank lines", () => {
    expect(parseContainerStats("").size).toBe(0);
    const map = parseContainerStats("xyz\t1.00%\t\n");
    expect(map.get("xyz")).toEqual({ cpu: "1.00%", mem: "" });
  });
});
