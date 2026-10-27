// @vitest-environment jsdom
//
// DOMPurify requires a real DOM (window/document) to sanitize — it throws
// "DOMPurify.sanitize is not a function" under plain Node. This is the only
// file in the project that needs the jsdom environment, hence the per-file
// pragma rather than a project-wide environment switch.

import { describe, it, expect } from 'vitest';
import { renderMarkdownSafe } from './markdownRender';

describe('renderMarkdownSafe', () => {
  it('returns an empty string for empty/null/undefined input', () => {
    expect(renderMarkdownSafe('')).toBe('');
    expect(renderMarkdownSafe(null)).toBe('');
    expect(renderMarkdownSafe(undefined)).toBe('');
  });

  it('renders headings, bold and bullet lists as real HTML elements', () => {
    const md = '## Meeting Report\n\n**Key Topics**\n- First point\n- Second point';
    const html = renderMarkdownSafe(md);
    expect(html).toContain('<h2>Meeting Report</h2>');
    expect(html).toContain('<strong>Key Topics</strong>');
    expect(html).toContain('<li>First point</li>');
    expect(html).toContain('<li>Second point</li>');
    // The raw markdown syntax itself must not leak through as literal text.
    expect(html).not.toContain('##');
    expect(html).not.toContain('**');
  });

  it('renders a markdown table as a real HTML table', () => {
    const md = '| A | B |\n|--|--|\n| 1 | 2 |';
    const html = renderMarkdownSafe(md);
    expect(html).toContain('<table>');
    expect(html).toContain('<td>1</td>');
  });

  it('strips a raw script tag instead of passing it through', () => {
    const html = renderMarkdownSafe('Some text<script>alert(1)</script> more text');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('alert(1)');
  });

  it('strips an inline event-handler attribute (onerror) from an img tag', () => {
    const html = renderMarkdownSafe('<img src=x onerror="alert(1)">');
    expect(html).not.toContain('onerror');
  });
});
