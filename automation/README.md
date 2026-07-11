# Cloud daily publishing

The `Generate lithium industry daily` GitHub Actions workflow starts at 18:30
Asia/Shanghai, researches the current report with the OpenAI Responses API and
web search, validates the result, waits until 19:00, and commits the generated
site files to the repository.

Required repository secret:

- `OPENAI_API_KEY`: an OpenAI API project key with billing enabled.

Optional repository variables:

- `OPENAI_MODEL`: defaults to `gpt-5`.
- `MIN_NEWS_ITEMS`: defaults to `8`; the workflow fails without changing the
  website when fewer verified events survive validation.

The workflow can also be started manually from the Actions tab. Manual runs
publish as soon as generation succeeds.
