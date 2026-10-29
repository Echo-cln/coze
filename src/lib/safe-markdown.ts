/** Render the small inline Markdown subset used by the report preview safely. */
export function renderInlineSafe(text: string): string {
  const links: string[] = [];
  const tokenized = text.replace(/&nbsp;/gi, " ").replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, label: string, href: string) => {
    const safeHref = sanitizeHref(href);
    if (!safeHref) return label;
    let html: string;
    if (safeHref.startsWith("#")) {
      html = `<a href="${safeHref}" class="text-indigo-600 dark:text-indigo-400 hover:underline">${escapeHtml(label)}</a>`;
    } else {
      html = `<a href="${safeHref}" target="_blank" rel="noopener noreferrer" class="text-indigo-600 dark:text-indigo-400 hover:underline">${escapeHtml(label)}</a>`;
    }
    const index = links.push(html) - 1;
    return `\u0000SAFE_LINK_${index}\u0000`;
  });

  return escapeHtml(tokenized)
    .replace(/\u0000SAFE_LINK_(\d+)\u0000/g, (_match, index: string) => links[Number(index)] ?? "")
    .replace(/\*\*(.+?)\*\*/g, '<strong class="text-slate-800 dark:text-slate-200">$1</strong>')
    .replace(/`(.+?)`/g, '<code class="bg-slate-100 dark:bg-slate-800 px-1 py-0.5 rounded text-[11px] font-mono">$1</code>')
    .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>')
    .replace(/\[E(\d+)\]/g, '<span class="inline-flex items-center px-1 py-0.5 mx-0.5 text-[10px] font-mono text-indigo-600 dark:text-indigo-400 bg-indigo-50 dark:bg-indigo-950/40 rounded border border-indigo-100 dark:border-indigo-900/50 cursor-pointer hover:bg-indigo-100 dark:hover:bg-indigo-900/50 transition-colors">E$1</span>')
    .replace(/\[C(\d+)\]/g, '<span class="inline-flex items-center px-1 py-0.5 mx-0.5 text-[10px] font-mono text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/40 rounded border border-amber-100 dark:border-amber-900/50 cursor-pointer">C$1</span>');
}

export function sanitizeHref(rawHref: string): string | null {
  const href = rawHref.trim();
  if (href.startsWith("#") && /^#[\p{L}\p{N}_-]+$/u.test(href)) return href;

  try {
    const url = new URL(href);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return escapeHtml(url.href);
  } catch {
    return null;
  }
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[char]!);
}
