---
sidebar_position: 5
title: Dashboard
description: What each screen in the CostKey dashboard shows.
---

# Dashboard

The dashboard shows what your AI calls cost, where the spend comes from and where it is heading. Open it at your CostKey address, `http://localhost:4100` by default. See [Self-hosting](./self-hosting).

Runs, Costs and Experiments have a filter bar with a date range (month to date by default) and an environment. It also shows the workspace time zone and reporting currency, and every timestamp uses that time zone. The Overview has its period and environment in the page header.

A call without a price is never counted as $0. It is shown as unpriced, and totals that leave it out say so.

## Overview

The Overview answers "are we on track this month?"

- **Month to date**: priced spend so far, with the change against last month
- **Monthly budget**: the limit, and whether it only alerts or stops new calls
- **Estimated month-end**: where spend lands at the current daily average
- **Cumulative spend**: actual spend, the estimate for the rest of the month and the budget line. Switch to daily bars if you prefer.
- **Budget check**: what is left in this month's budget
- **Recent runs** and the biggest costs by feature, model or customer

When something changes, a "Needs a look" note appears at the top. See [Needs a look](#needs-a-look).

## Runs

A run is one request your app made, such as `POST /api/search` or one nightly job. Every supported provider call inside it is grouped with it. Use `start_trace()` / `startTrace()` or the framework middleware to set run boundaries. Calls outside a boundary still appear on their own.

- **Runs** lists each run with its start time, duration, call count, status and cost
- **Calls** lists individual provider calls
- Search, filter, save a view or export the list
- Tick two runs to compare them side by side

Open a run to see its cost, duration, calls and status, plus a timeline of its calls. Select a call to see its cost, tokens, model, the source line that made it, its labels and, if text capture is on for the project, the prompt and response.

## Quality

Quality shows how runs went. The **Checks** view lists your quality checks with each one's pass rate, average score and runs scored. Rule checks such as Run succeeded need no prompt text; LLM judges score runs against a rubric when the project captures text. Each run's results are on its **Checks** tab. See [Quality checks](./quality-checks).

## Costs

Costs shows where the spend went. Split it by feature, function, model or customer to see each one's spend, share, runs and cost per run. Open any row for its daily cost and how cost is spread across its runs.

**Feature label rules** label calls by function, provider or model without changing your code. Labels set in your code always take priority.

## Experiments

Jobs, evals and experiments run in batches. Each batch is recorded with its own cost, item count, settings and status. You can:

- compare two batches
- see cost by phase, such as generation and scoring
- set a budget per batch

Costs that arrive after a batch finishes are added when they land.

## Forecasts

Forecasts show where this month is heading at the current pace, compared with your budget. **What would more usage cost?** estimates the cost of a given number of runs or calls from your recent average. Save a scenario to come back to it.

## Budgets

Budgets alert you before you overspend. They are **alerts only** by default: you hear at 80% and 100% of the limit, and nothing is blocked.

Stopping calls is opt-in. A **stop new calls** budget refuses new matching calls once the limit is reached. Calls already running still finish, and their cost still counts.

A budget can cover a whole project or one feature, function, model or customer. Its limit can reset every day or every month, or apply to each run or each batch on its own. Each budget shows what is used, what is reserved for calls in progress and its recent decisions.

## Needs a look

CostKey flags changes worth checking:

- cost per run went up for a feature
- one run cost far more than similar runs
- fewer calls have a price, or fewer calls are labelled
- a budget is close to, or has reached, its limit

Each note shows the comparison, the amounts and the runs behind it. It doesn't guess at a cause. Mark it as reviewed once you've checked it. Reviewing doesn't stop any work.

## Settings

- **Projects**: each project has its own DSN and its own data. Rotate a DSN here.
- **Team**: invite people as Viewers, Developers or Admins
- **Notifications**: weekly summaries, flagged changes, budget alerts and refused calls, by email or webhook
- **Privacy & data**: time zone, reporting currency, text capture, redaction and retention
- **Prices & credits**: models without a price, custom rates for negotiated or self-hosted models, and provider credits
- **Billing**: your plan and invoices

When body capture is on, known secrets such as API keys, bearer tokens and JWTs are replaced with `[REDACTED]` before they leave your app.
