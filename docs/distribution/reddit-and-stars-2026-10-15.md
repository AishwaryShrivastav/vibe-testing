# Reddit and GitHub discovery, 2026-10-15

The owner asked for 10+ subreddit posts and 20+ relevant comments. These are targets, not achieved counts. Use the live links below as the receipt. Every product mention disclosed the maintainer relationship. LinkedIn is excluded by owner instruction. Do not quote 11.5K downloads: the verified npm downloads API returned 5,381 cumulative through 2026-10-14, and downloads are not active users.

## Verified Reddit placements

| Type | Community and context | Link |
| --- | --- | --- |
| New post | r/mcp, `server` flair. Explains source-aware route discovery, Playwright checks, regression reporting, CLI/MCP setup, and assertion limits. | [Live post](https://www.reddit.com/r/mcp/comments/1x6qjm3/i_built_an_opensource_mcp_server_that_shows_what/) |
| Comment | r/SideProject, direct reply to a question about flaky dynamic UI and authenticated testing on the earlier launch post. | [Live reply](https://www.reddit.com/r/SideProject/comments/1x6chh1/i_built_a_free_browser_testing_tool_that_shows/comment/pgxgvfz/) |
| Comment | r/vibecoding, a thread explicitly inviting projects. A subsequent rules check found that promoting developer tools may require moderator approval; do not post there again without approval. | [Live reply](https://www.reddit.com/r/vibecoding/comments/1wp1t9x/show_me_your_vibe_coded_project_here/comment/pgxhflf/) |
| Comment | r/ClaudeCode, answer to a Next.js builder asking about terminal-first end-to-end testing. Gives a workflow and distinguishes web testing from account automation and iOS testing. | [Live reply](https://www.reddit.com/r/ClaudeCode/comments/1x12kzn/comment/pgxirb2/) |
| Comment | r/ChatGPTCoding, the current weekly self-promotion thread, which asks for tool, problem, audience, stack, feedback request, and affiliation. | [Live reply](https://www.reddit.com/r/ChatGPTCoding/comments/1x3vw47/comment/pgxj64k/) |

The earlier [r/SideProject launch post](https://www.reddit.com/r/SideProject/comments/1x6chh1/i_built_a_free_browser_testing_tool_that_shows/) predates this pass and is not counted as a new post. The 2026-10-15 count is **1 new standalone post and 4 verified comments**. No placement here proves an install, completed report, or new user.

## Next Reddit work, paced by fit and rules

1. Respond to real questions and replies on the live r/mcp and r/SideProject posts. Ask for a real app/report and what the tool missed. A useful response to someone already engaged is more valuable than a fresh promotional thread.
2. Search recent questions about a coding agent claiming a web app is done while a flow is broken. Give the concrete test workflow first. Link the repo only where it directly helps and the community permits it. Avoid repeated product replies within one subreddit or thread.
3. Use r/ChatGPTCoding's weekly self-promotion thread only for a meaningful update in a later week. Its rules warn against repeating the same project weekly without one.
4. r/opensource permits some project promotion, but its published rule recommends under 10% self-promotional posts and bans drive-by posting. The current account needs ordinary participation there before a launch post.
5. r/cursor and r/AI_Agents have self-promotion ratios; inspect account history before posting. r/vibecoding requires moderator approval for developer-tool promotion. r/QualityAssurance and r/Playwright ban tool advertising. Skip them for direct promotion. Do not force a 10-post count through communities that reject it.

## Where GitHub stars are most likely to come from

Stars are a secondary signal. Measure first whether an external builder ran an app flow and opened a report. The repo had **7 stars** when checked on 2026-10-15. Its GitHub homepage was corrected from the redirecting `vibetesting.tfgstudio.com` to `https://testing.tfgstudio.com/`; the existing GitHub topics already cover Playwright, MCP, AI testing, QA and related searches.

| Priority | Channel | Why it fits | Next action |
| --- | --- | --- | --- |
| 1 | [Show HN](https://news.ycombinator.com/showhn.html) | Developers can run a non-trivial MIT project without signup. The guidelines explicitly accept runnable projects. | Submit one project-focused post with a concrete example report and source link, then stay to answer technical questions. Do not ask for votes. Search HN immediately before posting to avoid a duplicate. |
| 2 | Focused GitHub lists | Readers are already comparing tools and can star or try the repo. | Track review and answer maintainers on the 11 open PRs/issues in [launch status](launch-status.md) and [current placements](gtm-placements-2026-10-15.md). Treat open submissions as pending, not listings. |
| 3 | A technical walkthrough on [DEV](https://dev.to/) | A reproducible route-regression example can earn developer trust and send qualified readers to the code. | Publish a run-one-app, change-one-route, run-again walkthrough with report excerpts, limitations and the repo link. Avoid a generic launch announcement or copied Reddit text. |
| 4 | [Product Hunt](https://help.producthunt.com/en/articles/17350772-launch-guide) | Brings early adopters, though visitors are broader than the core developer audience. | Launch with actual report screenshots and a maker comment; use a personal maker account. Product Hunt forbids asking for upvotes. The demo video is optional for now; a real report is the stronger proof asset. |
| 5 | Editor-specific marketplaces and communities | Users discover tools while trying to solve an editor workflow. | Complete Claude plugin validation by pinning the package in `.mcp.json`, then resolve the remaining review holds. Smithery submission requires the owner's device verification. Cursor submission presents publisher terms and needs action-time acceptance. |

Avoid star swaps, purchased stars, vote requests, and undifferentiated directory blasts. A star follows a useful demo, credible maintenance, a clear README, and a path to reproduce a result. Ask for feedback and issues from actual users; don't treat stars as the activation goal.

## Measurement

For each public placement, log URL, date, community, rule checked, clicks or referrer when available, repo stars before/after (attributing only cautiously), external installs if measurable, and completed reports. Do not infer new users from npm downloads or post views. The first activation milestone remains one external builder's completed report on a real app.
