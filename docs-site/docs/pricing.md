---
sidebar_position: 5
title: Pricing
description: Where CostKey's model prices come from, how a call is matched to one, and what to do when a model has none.
---

# Pricing

The SDKs send usage (tokens, characters, searches...). The server turns it into
cost from a price catalog that it keeps up to date.

## Where prices come from

CostKey syncs three public catalogs every 6 hours:
[LiteLLM](https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json),
[models.dev](https://models.dev) and
[OpenRouter](https://openrouter.ai/api/v1/models).

- When a call arrives for a model no catalog knows, the server checks the
  catalogs again within 30 minutes. New models usually appear within hours of
  launch. Once a price appears, the calls that were waiting are priced.
- Every price version is kept. A call is priced at the rate in force when it
  happened, and a retired model keeps pricing its history.
- When the catalogs disagree, CostKey uses the price most of them agree on,
  counting the vendor's own listing as an extra vote. A $0 placeholder never
  beats a real price.
- A feed that suddenly loses most of its models is ignored, and the last good
  prices stay.

## Which price wins

1. **Your project's prices.** These are set in **Settings → Prices & credits**,
   for negotiated rates or self-hosted models.
2. **Rates CostKey maintains** for APIs the catalogs miss or list stale: Exa,
   Firecrawl and Tavily credits, Rumik Silk, ElevenLabs Flash/Turbo, Deepgram
   Aura, AssemblyAI Universal, Cartesia, Sarvam (converted from INR) and Jina.
3. **The synced catalog.**
4. **A built-in table** for older models.

## How a call is matched

| Call | Priced as |
| --- | --- |
| Azure OpenAI or Azure AI Foundry | The Azure price, else OpenAI's list price |
| Vertex AI | The Vertex price, else the Gemini API price |
| Bedrock model id, inference profile or ARN | The Bedrock price for that model and region prefix |
| Dated snapshot (`claude-sonnet-5-20260101`, `gpt-6-sol-2026-09-22`) | The exact snapshot, else the model |
| Fine-tune (`ft:gpt-4o-mini-2024-07-18:acme::id`) | The fine-tune rate, else the base model |
| Proxy or gateway with a vendor model name | The vendor's list price |

## What is billed

- **Tokens:**
  - input and output
  - cached input at the cache rate
  - cache writes
  - long-context tiers
  - image output tokens
  - Gemini thinking tokens, at the output rate
- **Search grounding:** per search query on Gemini 3 and later, per grounded
  request on Gemini 2.x. Google Maps grounding is charged per grounded request.
- **Characters** for text to speech.
- **Audio minutes** for speech to text.
- **Searches and results** for search APIs.
- **Credits** for scraping APIs.
- **Pages.**

Free tiers aren't deducted (for example, Gemini's monthly free grounding
queries). Batch, priority and flex service tiers are priced at the standard
rate. Credit and character prices depend on your plan, so CostKey uses the
published pay-as-you-go or mid-tier rate. To use your own plan's rate, set it
as a project price.

## A model without a price

**Settings → Prices & credits** lists any model whose calls have no price.
**Set price** offers two ways to fix it:

- **Same as a known model.** Use this for an Azure deployment or proxy route
  named something other than the model, such as `prod-reasoner` priced as
  `gpt-6-sol`. The mapping follows catalog price changes.
- **Your rates.** Enter input and output per 1M tokens, or per 1k characters,
  per minute, per credit, and so on.

Calls that already arrived are repriced right away. A call without a price is
never shown as $0.

## Self-hosting

The server ships with a snapshot of the catalog, so a new install has prices
before its first sync.

| Variable | Effect |
| --- | --- |
| `COSTKEY_PRICE_SYNC=off` | Never fetch the public catalogs. For an air-gapped install, use the shipped snapshot. |
| `COSTKEY_PRICE_CATALOG=off` | Turn the catalog off and use only the built-in table and project prices. |

To refresh the shipped snapshot:

```bash
npm run pricing:snapshot --workspace=@costkey/server
```
