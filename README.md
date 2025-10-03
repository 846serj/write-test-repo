# AI Blog Generator

This project is a small Next.js app that generates blog articles using OpenAI.
The Generate page collects a variety of options such as article type and tone of
voice and sends them to `/api/generate`.

## Include Links option

A new checkbox on the Generate page allows toggling whether links are included in
the generated article. When **Include links in article** is unchecked the API
route skips pulling sources from SERP API and no link instructions are sent to
the model.

## Local storage of generated articles

When an article is generated, the returned HTML content and list of sources are
saved to `localStorage` as `lastArticleContent` and `lastArticleSources`.
Opening the Editor page reads these values to prefill the editor. If the values
are missing (for example, after clearing storage), the user is redirected back
to the Generate page.

## WordPress promo footer

After connecting your WordPress site you can store a snippet of HTML that will
be appended to every published post. Select an account in the editor to reveal a
textarea where you can edit this footer. Click **Save Footer** to store the
markup in Supabase. The `/api/wordpress/publish` route automatically appends the
saved footer before creating the draft post.

## Verification configuration

Article verification uses OpenAI chat completions to double-check generated
drafts whenever `OPENAI_API_KEY` is set and at least one source is available.
You can override the defaults by setting `OPENAI_VERIFICATION_MODEL` (defaults
to `gpt-4o-mini`) and `OPENAI_VERIFICATION_TIMEOUT_MS` (defaults to `9000`). See
`.env.example` for the expected format.

## More Specific Articles

The generation API now includes a default instruction encouraging concrete
examples. Generated content will reference real car models, release years or app
names instead of placeholders like "App 1". You can override this by providing
custom instructions.

## Recipe embedding workflow

Recipe search relies on vector embeddings stored in `data/recipeEmbeddings.json`.
Run `npm run generate:recipe-embeddings` to regenerate this file after adding or
editing recipes in Airtable. The script skips unchanged records by comparing a
hash of each recipe's content, so only new or modified recipes trigger fresh
embedding requests. A scheduled GitHub Action automatically executes this task
weekly and commits any updates back to the repository, ensuring the JSON file
stays current.

## Headlines fetching

The Headlines tab on the Generate page calls the `/api/headlines` route to pull
recent stories from NewsAPI.org. Supply a NewsAPI key in `.env.local` (see
`.env.example`) by setting `NEWSAPI_API_KEY` so the route can authenticate
requests. You can refine the feed with NewsAPI-compatible filters including
language, sort order, optional from/to dates, specific search fields, and
comma-separated lists of sources or domains to include/exclude. The UI enforces
NewsAPI rules—for example, you can request 1–100 results, but you cannot combine
explicit sources with domain filters. When no overrides are selected the backend
defaults to English headlines sorted by publish time.
