## "Why can't I close it?" — now you can

> PO: "an employee needs to watch an item send for 5 min before working on another section"

**Root insight:** the push stream lives in the *page's* JavaScript, not the modal — the modal was never load-bearing. Closing it is completely safe; only closing the **browser tab** kills the stream. So:

- **Push + Auto Push modals close freely during a send** (overlay click, ✕, "Hide — keeps running"). The employee moves on to other sections — or other listings via in-app navigation — while the stream finishes and the write-throughs land.
- **Floating progress pill** (bottom-right) whenever a push runs with its modal closed: `Pushing Fit Type… 34 accepted — view` / `Auto Push running… 3/7 fields` → click reopens the live modal mid-stream.
- **Tab-close guard**: the browser now asks for confirmation before closing/refreshing the tab while a push runs — the one action that genuinely interrupts. (Already-accepted SKUs always stay pushed; **Verify → Push just the stale** recovers the rest.)
- In-modal note rewritten to the new semantics.

**Known v1 limit (honest):** the pill renders on the listing page that started the push — navigating to a different page keeps the push running, just without the pill; Verify on return shows what landed. If you want pushes that survive **tab close and deploys** (true server-side job queue with a global status bar), that's the follow-up build — say the word.

`tsc` exit 0. UI-only, one file.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
