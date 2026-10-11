---
title: Quality checks
description: Score every finished run on the server with rule checks and LLM judges.
---

# Quality checks

A quality check scores each finished run. Checks run on the CostKey server,
not in your app, so there is no SDK code to add. Results show on the run page,
on the **Quality** page and in the Overview.

Quality checks need CostKey server 0.7.0 or later. Set them up on
**Quality, Checks**. Owners and admins can create, edit and delete checks.

## Rules and judges

There are two kinds of check.

- **Rules** are computed from data CostKey already stores for the run: calls,
  spans, timing and cost. They need no prompt text and cost nothing to run.
- **LLM judges** send a transcript of the run to a model you choose, with a
  rubric, and record the model's score and reason. They need prompt capture
  and an API key.

Every check scores a run from 0 to 1, where 1 is best, and labels it pass or
fail.

### Rules

| Rule | Passes when | Target |
| --- | --- | --- |
| Run succeeded | No failed spans and no failed model calls. A call that failed and then succeeded on retry doesn't fail the run. | None |
| Tool errors | The share of tool spans that errored is at or under the limit. | Most tool errors allowed, default 0% |
| Retries | Model calls retried in the run are at or under the limit. | Most retries allowed, default 0 |
| Latency | The run finishes within the target time. | Seconds, default 30 |
| Cost per run | The run's priced cost is within the target. | USD, default $0.10 |

A rule that doesn't apply to a run is marked **Not applicable**: Tool errors
on a run with no tool calls, Retries on a run with no model calls, Latency on
a run with no recorded duration, and Cost per run when no call in the run has
a price yet.

### LLM judges

Start a judge from a template, or write a custom rubric.

| Template | What it checks |
| --- | --- |
| Answered the question | The final answer addresses what the user asked. |
| Faithfulness | Claims are grounded in retrieved documents or tool results. |
| Tool choice | The agent called the right tools with sensible arguments. |
| Instruction following | The answer follows the system prompt and the user's constraints. |
| Safety | Nothing harmful, private or overconfident reached the user. |

The template fills in the rubric, which you can edit. The judge reads a
transcript of the run (the system prompt, the user's question, up to 24 tool
and model steps, and the final answer, each trimmed to a fixed length) and
replies with a score from 0 to 1 and a short reason. A score of 0.5 or more
passes. Judge calls use temperature 0.

## Prompt capture

LLM judges only run when the project has prompt capture on (**Settings,
Privacy & data**, text capture). A metadata-only project never stores prompt
or response text, so there is nothing to judge. Until text capture is on,
judge checks show **Needs prompt capture** and runs are skipped. Rule checks
still run.

A run whose calls carry no captured text is marked **No text captured**.

If redaction is on for the project, the judge's reason is redacted before it
is stored. Viewers see judge scores but not the judge's reasons.

## Judge provider and API key

Pick the judge provider and model on the check:

| Provider | Default model |
| --- | --- |
| OpenAI | `gpt-4o-mini` |
| Anthropic | `claude-haiku-4-5` |
| Google | `gemini-2.5-flash` |

You can type any model ID for the provider. The API key is stored encrypted
on your CostKey server with `COSTKEY_NOTIFICATION_ENCRYPTION_KEY`, and it
can't be shown again. Edit the check to replace or remove it. A judge check
without a key shows **Add an API key** and skips runs.

Your CostKey server calls the provider directly, so it needs network access to
the provider's API.

## Which runs are checked

- **When:** a run is checked once it has had no new activity for the settle
  time (2 minutes by default) and no span is still running. A new check scores
  runs that finish after it is created.
- **Applies to:** all runs, or only runs from specific agents or workflows.
  Names match agent and workflow span names, group names and trace names. List
  up to 50.
- **Sample rate:** a percentage from 0 to 100. Runs are picked by run ID, so
  the same run is always in or out of the sample, and a run sampled at 10% is
  also sampled at 50%. Use it to keep judge costs down on busy projects.

Turning a check off stops new results. Deleting a check keeps its past scores.

## Costs

Rule checks are free. Each judge call is billed by the provider to the key you
saved. CostKey records every judge call as a call in the same project, under
the feature `quality-checks` with the check's name as the operation, so judge
spend shows in **Costs** next to everything else.

Judge calls are rate limited per project, 30 a minute by default. A call that
fails is retried with exponential backoff, up to 5 attempts.

## Run on recent runs

**Run on recent runs** on a check scores up to 200 of the most recent finished
runs from the last 30 days that the check samples and applies to. Runs it
already scored are scored again. Use it after creating a check or changing a
rubric. Only one backfill per check runs at a time.

## Results on a run

Open a run and select the **Checks** tab to see each check's result for that
run: the score, pass or fail, and the reason. A check that didn't score the
run shows why:

| State | Meaning |
| --- | --- |
| Passed, Failed, Scored | The check scored the run. |
| Queued | The run is waiting to be checked. |
| Waiting for the run to finish | The run is still active or inside the settle time. |
| Not sampled | The run is outside the check's sample rate. |
| Not applicable | The rule doesn't apply to this run. |
| Needs prompt capture | A judge, and the project is metadata-only. |
| Add an API key | A judge with no key saved. |
| No text captured | A judge, and the run has no captured text. |
| Couldn't run | The judge call failed after its retries. |
| Check is off | The check is turned off. |

## Server settings

Set these in the CostKey server's environment, for example the `.env` beside
`docker-compose.yml`. See [Self-hosting](./self-hosting#settings).

| Setting | Default | What it does |
| --- | --- | --- |
| `COSTKEY_QUALITY_SETTLE_SECONDS` | `120` | Seconds a run must be idle before it is checked. |
| `COSTKEY_QUALITY_JUDGE_RPM` | `30` | Most judge calls per minute for each project. |
| `COSTKEY_QUALITY_WORKER_INTERVAL_SECONDS` | `15` | Seconds between runs of the quality check worker. |

## Moving from `score()`

SDK 0.6 had `CostKey.score()` and `costkey.score()` for sending scores from
your code. SDK 0.7 removes them. Rebuild those checks here: as a rule if the
score came from counts, timing or cost, or as a judge with your rubric.
