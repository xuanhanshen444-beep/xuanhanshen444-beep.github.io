# Cloud daily publishing

The `Generate lithium industry briefing` workflow runs on Monday, Wednesday and
Friday. It starts at 16:00 Asia/Shanghai, researches events since the previous
published report with the OpenAI Responses API and web search, validates the
result, waits until 16:30, and commits the report and subject index.

Before publishing, the generator compares each candidate with historical report
URLs and event identity (date, companies, headline, project/product and key
numbers). A second guard in the local fallback publisher rejects the entire
update if a cross-report duplicate survives generation.

Required repository secret:

- `OPENAI_API_KEY`: an OpenAI API project key with billing enabled.

Optional repository variables:

- `OPENAI_MODEL`: defaults to `gpt-5`.
- `MIN_NEWS_ITEMS`: defaults to `1`; the workflow fails without changing the
  website when fewer verified events survive validation.

The workflow can also be started manually from the Actions tab. Manual runs
publish as soon as generation succeeds.
