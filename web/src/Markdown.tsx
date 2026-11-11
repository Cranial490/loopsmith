/** @jsxRuntime automatic */
import type { ReactNode } from "react";

/**
 * A small, safe Markdown renderer: headings, lists, quotes, fenced code, inline code,
 * bold, italics and links. Builds React elements only, so supplied HTML is shown as text.
 */
export function Markdown({ text }: { text: string }) {
  const lines = text.replace(/\r/g, "").split("\n");
  const out: ReactNode[] = [];
  let i = 0;
  const take = (re: RegExp) => {
    const items: string[] = [];
    let m: RegExpExecArray | null;
    while (i < lines.length && (m = re.exec(lines[i]))) { items.push(m[1]); i++; }
    return items;
  };
  while (i < lines.length) {
    const line = lines[i];
    const k = out.length;
    const fence = /^\s*(```+|~~~+)\s*([\w+-]*)/.exec(line);
    if (fence) {
      const body: string[] = [];
      for (i++; i < lines.length && !lines[i].trim().startsWith(fence[1]); i++) body.push(lines[i]);
      i++;
      out.push(<pre key={k}><code className={fence[2] ? `lang-${fence[2]}` : undefined}>{body.join("\n")}</code></pre>);
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      const H = `h${h[1].length}` as "h1";
      out.push(<H key={k}>{inline(h[2])}</H>);
      i++;
      continue;
    }
    if (/^\s*[-*+]\s+/.test(line)) { out.push(<ul key={k}>{take(/^\s*[-*+]\s+(.*)$/).map((t, j) => <li key={j}>{inline(t)}</li>)}</ul>); continue; }
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const start = parseInt(line, 10);
      out.push(<ol key={k} start={start !== 1 ? start : undefined}>{take(/^\s*\d+[.)]\s+(.*)$/).map((t, j) => <li key={j}>{inline(t)}</li>)}</ol>);
      continue;
    }
    if (/^>\s?/.test(line)) { out.push(<blockquote key={k}>{inline(take(/^>\s?(.*)$/).join("\n"))}</blockquote>); continue; }
    if (!line.trim()) { i++; continue; }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^\s*(```|~~~|#{1,6}\s|[-*+]\s|\d+[.)]\s|>)/.test(lines[i])) para.push(lines[i++]);
    out.push(<p key={k}>{inline(para.join("\n"))}</p>);
  }
  return <div className="md">{out}</div>;
}

const INLINE = /`([^`]+)`|\*\*([^*]+)\*\*|\[([^\]]+)\]\(([^)\s]+)\)|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])|(?<![\w*])[*_]([^*_\s][^*_]*)[*_](?![\w*])/g;

function inline(s: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of s.matchAll(INLINE)) {
    if (m.index > last) out.push(s.slice(last, m.index));
    const k = out.length;
    if (m[1] !== undefined) out.push(<code key={k}>{m[1]}</code>);
    else if (m[2] !== undefined) out.push(<strong key={k}>{inline(m[2])}</strong>);
    else if (m[3] !== undefined) out.push(safeUrl(m[4]) ? <a key={k} href={m[4]} target="_blank" rel="noreferrer noopener">{m[3]}</a> : m[3]);
    else if (m[5] !== undefined) out.push(<a key={k} href={m[5]} target="_blank" rel="noreferrer noopener">{m[5]}</a>);
    else out.push(<em key={k}>{m[6]}</em>);
    last = m.index + m[0].length;
  }
  if (last < s.length) out.push(s.slice(last));
  return out;
}

const safeUrl = (u: string) => /^(https?:|mailto:|#|\/)/i.test(u);
