# Round 1 submission checklist

Submit through the [organizer's Round 1 form](https://forms.gle/htyWGFJRBgsg3qmx6) by **20 November 2026, 23:59 IST**. Have the registered Techfest Team ID ready. The required deliverables are a public GitHub repository, a public link to the 1–3 page PDF, and a public or unlisted demo video no longer than four minutes. Verify every link while signed out.

## Demo sequence

1. Start on Flask tag `3.1.3` at commit `22d92470`. Keep the VS Code editor and Anvil sidebar legible.
2. **A, inline edit:** Select `get_debug_flag` in `src/flask/helpers.py` and give the exact competition instruction. Show the proposed diff, hunk acceptance, then `FLASK_DEBUG=off` producing `False`. Click **Undo last apply** and show the original function restored for the diff-safety score.
3. **B, agent mode:** Give the exact `flask config` instruction with no file names. Show discovered context and its reasons, the at-least-three-file review, application, TrueForge session turns/tool calls, passing `pytest tests/test_cli.py -q`, and JSON with the requested keys masked.
4. **Cancellation:** After B's verification, start a separate short generation and click **Cancel** while tokens stream. Show that no additional source edits appeared.
5. **C, resilience:** Use a fresh clean Flask checkout and an invalid model key or unreachable endpoint. Repeat A. Show a responsive editor, retry/error or automatic fallback, and `git status` with no source changes.
6. Keep A → B → C in order. You may cut model waiting time, but do not cut between an instruction and the resulting diff. Keep the cancellation insert brief enough to stay under four minutes.

On Windows PowerShell, activate the Flask checkout's virtual environment before verification. For Task A use `$env:FLASK_DEBUG = 'off'` followed by `python -c "from flask.helpers import get_debug_flag; print(get_debug_flag())"`. Run `Remove-Item Env:FLASK_DEBUG` after verification. Keep the virtual environment and any demo app outside the checkout or locally ignored so `git status --short` reflects only source changes.

For Task B, from `.demo/flask`, run `python -m flask --help`, `python -m pytest tests/test_cli.py -q`, and `python -m flask --app ../../docs/flask_demo_app.py config`. The example app sets fake values for all four masking patterns. Verify that those values print as `"***"` and that `DISPLAY_NAME` remains visible.

For Task C, add a separate **Custom** provider in TrueForge with base URL `http://127.0.0.1:39282/v1` and model `unreachable`, while that port has no listener. Add the full provider/model name as a VS Code model profile and select it for the demo. Keep your working Gemini provider configured. If the working profile is also available as fallback, leave the resulting diff unapproved to show the clean status.

## Write-up headings (exact order)

1. **Team** — names, college/employer, GitHub handles, Team ID.
2. **Starting point** — from scratch; MIT license.
3. **Architecture on TrueForge** — SDK sessions/turns/streaming/approval; local MCP editor bridge; deferred tool loading.
4. **How context is selected** — lexical and symbol ranking, explicit mentions, 6,000-token estimated budget, visible reasons.
5. **Model setup** — every model actually used, where it ran, approximate cost, and how to switch profiles. Do not claim a model that was not tested.
6. **Scorecard** — one row per A1, A2, A3, B1, B2, B3, B4, C1, C2; add video timestamps and one-line evidence claims.
7. **Tools used** — dependencies and every AI coding assistant used to build this extension.
8. **Known limitations and what you would do with another month** — concise and honest.

## Final check

- Public repository includes clean-clone setup, agent definition, example model configuration, license, and no API keys or secrets.
- Video is at most four minutes and the three on-screen verifications are readable.
- PDF is 1–3 pages with all eight headings and accurate timestamps.
- All three links open without an access request. Submit them through the [Round 1 form](https://forms.gle/htyWGFJRBgsg3qmx6) using the registered Team ID.
- The form also asks for the exact registered team name, leader name and phone with country code, student or professional status, affiliation, video duration (`mm:ss`), and eligibility declarations. Keep the leader's contact details in the form rather than the GitHub repository or PDF.
- Describe only TrueForge capabilities that were exercised. For the context question, explain how the extension ranks paths and excerpts by filenames, lexical matches and symbol mentions, gives explicit references priority, and shows the selected files and reasons within a fixed estimated budget.
