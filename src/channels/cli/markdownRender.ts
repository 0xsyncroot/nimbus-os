// markdownRender.ts — SPEC-801: render Markdown text as styled ANSI for CLI channel.
// Strategy: lex with `marked`, walk tokens, apply ANSI via colors helpers.
// Falls through to raw text when no Markdown syntax detected (fast path).

import { marked, type Token, type Tokens } from 'marked';
import { colors, stripAnsi } from './colors.ts';

// ── italic fallback (colors.ts has no italic; use ANSI 3m/23m directly) ──────

const ESC = '\x1b[';

function italic(s: string): string {
  // ANSI italic (SGR 3). Many terminals support it; worst case it's a no-op.
  const forceColor = process.env['FORCE_COLOR'] !== undefined && process.env['FORCE_COLOR'] !== '';
  const noColor = process.env['NO_COLOR'] !== undefined && process.env['NO_COLOR'] !== '';
  const ttyOn = typeof process.stdout.isTTY === 'boolean' && process.stdout.isTTY;
  const enabled = noColor ? false : forceColor ? true : ttyOn;
  return enabled ? `${ESC}3m${s}${ESC}23m` : `_${s}_`;
}

// ── Markdown syntax fast-path ─────────────────────────────────────────────────

// Detects common Markdown syntax markers. Uses multiline flag so `^` anchors
// match line starts (needed for list bullets and HR).
const MD_SYNTAX_RE =
  /[#*`|[\]>_~]|\n\n|(?:^|\n)\d+\. |(?:^|\n)- |(?:^|\n)---+\s*(?:\n|$)/m;

export function hasMarkdownSyntax(text: string): boolean {
  return MD_SYNTAX_RE.test(text);
}

// ── Public API ────────────────────────────────────────────────────────────────

export function renderMarkdown(md: string): string {
  if (!md || !hasMarkdownSyntax(md)) return md;
  const tokens = marked.lexer(md);
  return tokens.map((t) => formatToken(t as Token, 0)).join('');
}

// ── Token formatters ──────────────────────────────────────────────────────────

function formatToken(token: Token, listDepth: number): string {
  switch (token.type) {
    case 'heading': {
      const prefix = '#'.repeat(token.depth) + ' ';
      const inner = (token.tokens ?? []).map((t) => formatInline(t as Token)).join('');
      return colors.bold(colors.info(prefix + inner)) + '\n\n';
    }

    case 'paragraph': {
      const inner = (token.tokens ?? []).map((t) => formatInline(t as Token)).join('');
      return inner + '\n\n';
    }

    case 'list': {
      const rendered = (token as Tokens.List).items.map((item, i) =>
        formatListItem(item as Token, listDepth, (token as Tokens.List).ordered ? i + 1 : undefined),
      );
      return rendered.join('') + '\n';
    }

    case 'code': {
      const t = token as Tokens.Code;
      const langLabel = t.lang ? colors.dim(`[${t.lang}]`) + '\n' : '';
      const body = t.text
        .split('\n')
        .map((l) => '  ' + colors.info(l))
        .join('\n');
      return '\n' + langLabel + body + '\n\n';
    }

    case 'blockquote': {
      const t = token as Tokens.Blockquote;
      const inner = (t.tokens ?? [])
        .map((child) => formatToken(child as Token, listDepth))
        .join('');
      return inner
        .split('\n')
        .map((l) => (stripAnsi(l).trim() ? colors.dim('│ ') + l : l))
        .join('\n');
    }

    case 'hr':
      return colors.dim('─'.repeat(40)) + '\n\n';

    case 'space':
      return '';

    case 'text':
      return (token as Tokens.Text).text;

    default:
      return (token as { raw?: string }).raw ?? '';
  }
}

function formatListItem(token: Token, depth: number, num?: number): string {
  const t = token as Tokens.ListItem;
  const indent = '  '.repeat(depth);
  const marker = num !== undefined ? colors.info(`${num}. `) : colors.info('• ');
  const content = (t.tokens ?? [])
    .map((child) => {
      const c = child as Token;
      if (c.type === 'list') return '\n' + formatToken(c, depth + 1);
      // text tokens inside list_item may have inline children
      if (c.type === 'text') {
        const ct = c as Tokens.Text;
        if (ct.tokens && ct.tokens.length > 0) {
          return ct.tokens.map((it) => formatInline(it as Token)).join('');
        }
        return ct.text;
      }
      return formatInline(c);
    })
    .join('');
  return indent + marker + content.trimEnd() + '\n';
}

function formatInline(token: Token): string {
  switch (token.type) {
    case 'strong': {
      const t = token as Tokens.Strong;
      const inner = (t.tokens ?? []).map((c) => formatInline(c as Token)).join('');
      return colors.bold(inner);
    }

    case 'em': {
      const t = token as Tokens.Em;
      const inner = (t.tokens ?? []).map((c) => formatInline(c as Token)).join('');
      return italic(inner);
    }

    case 'codespan':
      return colors.info((token as Tokens.Codespan).text);

    case 'link': {
      const t = token as Tokens.Link;
      const label = (t.tokens ?? []).map((c) => formatInline(c as Token)).join('') || t.text;
      return colors.info(`${label} (${t.href})`);
    }

    case 'br':
      return '\n';

    case 'text':
      return (token as Tokens.Text).text;

    default:
      return (token as { raw?: string }).raw ?? '';
  }
}
