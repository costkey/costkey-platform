import { describe, expect, it } from "vitest";
import { selectOnboardingProject } from "./onboardingSelection";

describe("onboarding project selection", () => {
  const projects = [
    { id: "project-first", name: "First" },
    { id: "project-requested", name: "Requested" },
  ];

  it("selects a requested authorized project instead of the first project", () => {
    expect(selectOnboardingProject(projects, "project-requested")).toEqual(projects[1]);
  });

  it("falls back to the first authorized project for an unknown query", () => {
    expect(selectOnboardingProject(projects, "project-unknown")).toEqual(projects[0]);
    expect(selectOnboardingProject(projects, null)).toEqual(projects[0]);
  });
});
