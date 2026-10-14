import { GitCommitHorizontal } from "lucide-react";
import type { Release } from "../api";
import { shortRelease, useReleases } from "./releasesModel";

/** A release as a short commit, linked to the commit's page when the repository is known. */
export function ReleaseLink({ release, info, className = "" }: { release: string; info?: Release | null; className?: string }) {
  const label = shortRelease(release);
  const title = info?.commit && info.commit !== release ? `${release} · commit ${info.commit}` : release;
  const body = <><GitCommitHorizontal size={13} aria-hidden="true" /><span>{label}</span></>;
  return info?.commitUrl
    ? <a className={`ck-release ck-release-link ${className}`} href={info.commitUrl} target="_blank" rel="noreferrer" title={`${title} · open the commit`}>{body}</a>
    : <span className={`ck-release ${className}`} title={title}>{body}</span>;
}

/** ReleaseLink that finds the release's commit among the project's deploys. */
export function ProjectRelease({ projectId, release }: { projectId: string | null; release: string }) {
  const { releases } = useReleases(projectId);
  return <ReleaseLink release={release} info={releases.find((item) => item.release === release) ?? null} />;
}
