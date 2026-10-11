export function selectOnboardingProject<T extends { id: string }>(projects: T[], requestedProjectId: string | null): T | undefined {
  return (requestedProjectId ? projects.find((project) => project.id === requestedProjectId) : undefined) ?? projects[0];
}
