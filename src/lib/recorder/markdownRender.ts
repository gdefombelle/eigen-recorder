// markdownRender.ts — renders LLM-generated markdown (Report, summaries) as
// sanitized HTML, instead of dumping raw "## Heading" / "**bold**" text.
//
// Content is our own backend's LLM output, not third-party user HTML, but
// it's still speech-derived text we don't fully control (a meeting
// participant could say something that ends up echoed back verbatim) — so
// marked's output is run through DOMPurify before ever reaching {@html},
// rather than trusting it as a safe sink by default.

import { marked } from 'marked';
import DOMPurify from 'dompurify';

marked.setOptions({ breaks: true, gfm: true });

export function renderMarkdownSafe(md: string | null | undefined): string {
  if (!md) return '';
  const html = marked.parse(md, { async: false }) as string;
  return DOMPurify.sanitize(html);
}
