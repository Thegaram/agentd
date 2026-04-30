import { describe, it, expect } from "vitest";
import { classifyInspectError } from "./docker.js";

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
