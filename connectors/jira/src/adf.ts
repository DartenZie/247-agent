/**
 * Atlassian Document Format, the rich text of Jira Cloud's REST API v3: just enough to
 * read any document as plain text and to write plain text as a document. Paragraphs are
 * separated by blank lines; single newlines become hard breaks.
 */

export interface AdfNode {
  type: string;
  text?: string;
  content?: AdfNode[];
  attrs?: Record<string, unknown>;
}

export function textToAdf(text: string): AdfNode {
  const paragraphs = text
    .replace(/\r\n?/g, '\n')
    .split(/\n{2,}/)
    .filter((p) => p.trim() !== '');
  return {
    type: 'doc',
    attrs: { version: 1 },
    content: paragraphs.map((p) => ({
      type: 'paragraph',
      content: p.split('\n').flatMap((line, i): AdfNode[] => {
        const parts: AdfNode[] = i === 0 ? [] : [{ type: 'hardBreak' }];
        return line === '' ? parts : [...parts, { type: 'text', text: line }];
      }),
    })),
  };
}

const BLOCKS = new Set([
  'paragraph',
  'heading',
  'codeBlock',
  'blockquote',
  'rule',
  'panel',
  'table',
  'tableRow',
  'mediaSingle',
  'mediaGroup',
  'expand',
  'nestedExpand',
  'decisionList',
  'taskList',
]);

/** Plain text of a document; `null`/`undefined` (no description) is ''. */
export function adfToText(node: unknown): string {
  if (typeof node === 'string') {
    return node;
  }
  if (node === null || typeof node !== 'object') {
    return '';
  }
  return render(node as AdfNode, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function render(node: AdfNode, indent: string): string {
  const children = (sep = ''): string =>
    (node.content ?? []).map((c) => render(c, indent)).join(sep);
  switch (node.type) {
    case 'text':
      return node.text ?? '';
    case 'hardBreak':
      return '\n';
    case 'mention':
    case 'emoji':
    case 'status':
    case 'date':
      return attr(node, 'text') ?? attr(node, 'shortName') ?? attr(node, 'timestamp') ?? '';
    case 'inlineCard':
    case 'blockCard':
    case 'embedCard':
      return attr(node, 'url') ?? '';
    case 'rule':
      return '---\n\n';
    case 'bulletList':
    case 'orderedList':
      return (
        (node.content ?? [])
          .map((item, i) => {
            const marker = node.type === 'orderedList' ? `${String(i + 1)}. ` : '- ';
            const body = (item.content ?? [])
              .map((c) => render(c, indent + '  '))
              .join('')
              .trim();
            return `${indent}${marker}${body}`;
          })
          .join('\n') + '\n\n'
      );
    case 'tableRow':
      return (node.content ?? []).map((c) => render(c, indent).trim()).join(' | ') + '\n';
    case 'listItem':
    case 'tableCell':
    case 'tableHeader':
      return children();
    default:
      return BLOCKS.has(node.type) ? children() + '\n\n' : children();
  }
}

function attr(node: AdfNode, key: string): string | undefined {
  const v = node.attrs?.[key];
  return typeof v === 'string' ? v : undefined;
}
