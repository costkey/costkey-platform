import { test } from "node:test";
import assert from "node:assert/strict";
import { commitSha, commitUrl, repositoryUrl } from "../releases.js";

test("a release links to its commit on GitHub, GitLab or Bitbucket", () => {
  assert.equal(commitUrl("https://github.com/thrive-money/core", "df48a0a"), "https://github.com/thrive-money/core/commit/df48a0a");
  assert.equal(commitUrl("https://gitlab.com/acme/app", "abc1234"), "https://gitlab.com/acme/app/-/commit/abc1234");
  assert.equal(commitUrl("https://bitbucket.org/acme/app", "abc1234"), "https://bitbucket.org/acme/app/commits/abc1234");
  assert.equal(commitUrl(null, "abc1234"), null);
  assert.equal(commitUrl("https://github.com/acme/app", null), null);
});

test("repositories are https URLs without credentials or .git", () => {
  assert.equal(repositoryUrl("git@github.com:costkey/platform.git"), "https://github.com/costkey/platform");
  assert.equal(repositoryUrl("https://x-access-token:secret@github.com/costkey/platform.git"), "https://github.com/costkey/platform");
  assert.equal(repositoryUrl("github.com/costkey/platform/"), "https://github.com/costkey/platform");
  assert.equal(repositoryUrl("ssh://git@gitlab.com/acme/app.git"), "https://gitlab.com/acme/app");
  assert.equal(repositoryUrl("not a repository"), null);
  assert.equal(repositoryUrl("https://github.com/only-owner"), null);
});

test("only hex of commit length is a commit", () => {
  assert.equal(commitSha("DF48A0A5D924FCDF05626119B9D390B3E1A86AEF"), "df48a0a5d924fcdf05626119b9d390b3e1a86aef");
  assert.equal(commitSha("v1.4.0"), null);
  assert.equal(commitSha("abc12"), null);
});
