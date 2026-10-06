import type { Page as StagehandPage } from '@browserbasehq/stagehand';

/** An element the agent can act on directly (no second AI call). */
export interface PageElement {
  id: string;
  /** Stagehand Action shape: `act(action)` executes it without an LLM. */
  action: {
    selector: string;
    description: string;
    method: string;
    arguments?: string[];
  };
  line: string;
}

export interface PageSnapshot {
  url: string;
  title: string;
  elements: PageElement[];
  text: string;
}

const MAX_ELEMENTS = 70;

/** Runs in the browser: collects visible interactive elements with XPath selectors. */
const COLLECT_EXPRESSION = `(() => {
  const SEL = 'a[href],button,input,select,textarea,summary,[role=button],[role=link],[role=checkbox],[role=radio],[role=tab],[role=menuitem],[role=switch],[role=combobox],[role=option],[contenteditable=""],[contenteditable=true]';
  const xpath = (el) => {
    const parts = [];
    for (let n = el; n && n.nodeType === 1; n = n.parentNode) {
      let i = 1;
      for (let s = n.previousElementSibling; s; s = s.previousElementSibling) {
        if (s.localName === n.localName) i++;
      }
      parts.unshift(n.localName + '[' + i + ']');
      if (n === document.documentElement) break;
    }
    return '/' + parts.join('/');
  };
  const clean = (s) => (s || '').replace(/\\s+/g, ' ').trim().slice(0, 80);
  const out = [];
  for (const el of document.querySelectorAll(SEL)) {
    if (out.length >= ${MAX_ELEMENTS * 2}) break;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none') continue;
    if (el.disabled) continue;
    const tag = el.localName;
    const type = (el.getAttribute('type') || '').toLowerCase();
    if (tag === 'input' && type === 'hidden') continue;
    const labelEl = el.labels && el.labels[0];
    const name = clean(
      el.getAttribute('aria-label') ||
      (labelEl && labelEl.innerText) ||
      el.innerText ||
      el.getAttribute('placeholder') ||
      el.getAttribute('title') ||
      el.getAttribute('alt') ||
      el.getAttribute('name') ||
      (tag === 'input' && (type === 'submit' || type === 'button') ? el.value : '')
    );
    out.push({
      selector: 'xpath=' + xpath(el),
      tag,
      type,
      role: el.getAttribute('role') || '',
      name,
      placeholder: clean(el.getAttribute('placeholder')),
      href: tag === 'a' ? clean(el.getAttribute('href')) : '',
      value: type === 'password' ? '' : clean(el.value),
      checked: !!el.checked,
      inViewport: r.bottom > 0 && r.top < innerHeight,
    });
  }
  const text = clean((document.body && document.body.innerText || '').slice(0, 600));
  return { url: location.href, title: document.title, elements: out, text };
})()`;

interface RawElement {
  selector: string;
  tag: string;
  type: string;
  role: string;
  name: string;
  placeholder: string;
  href: string;
  value: string;
  checked: boolean;
  inViewport: boolean;
}

function describe(el: RawElement): { kind: string; method: string } {
  if (el.tag === 'select') return { kind: 'select', method: 'selectOptionFromDropdown' };
  if (el.tag === 'textarea') return { kind: 'textbox', method: 'fill' };
  if (el.tag === 'input') {
    if (['checkbox', 'radio'].includes(el.type)) {
      return { kind: el.type, method: 'click' };
    }
    if (['submit', 'button', 'reset', 'image'].includes(el.type)) {
      return { kind: 'button', method: 'click' };
    }
    return {
      kind: el.type === 'password' ? 'password field' : 'textbox',
      method: 'fill',
    };
  }
  if (el.role === 'combobox') return { kind: 'combobox', method: 'click' };
  if (el.tag === 'a' || el.role === 'link') return { kind: 'link', method: 'click' };
  return { kind: el.role || el.tag, method: 'click' };
}

/** Deterministic DOM snapshot — a single browser round trip, no LLM. */
export async function capturePageSnapshot(
  page: StagehandPage,
): Promise<PageSnapshot> {
  const raw = await page.evaluate<{
    url: string;
    title: string;
    elements: RawElement[];
    text: string;
  }>(COLLECT_EXPRESSION);

  // Prefer on-screen elements, keep DOM order within each group.
  const ordered = [
    ...raw.elements.filter((e) => e.inViewport),
    ...raw.elements.filter((e) => !e.inViewport),
  ].slice(0, MAX_ELEMENTS);

  const elements: PageElement[] = ordered.map((el, i) => {
    const id = `e${i + 1}`;
    const { kind, method } = describe(el);
    const label = el.name || el.placeholder || el.tag;
    const extras = [
      el.href && el.tag === 'a' ? `href=${el.href}` : '',
      el.value ? `value="${el.value}"` : '',
      el.checked ? 'checked' : '',
      el.inViewport ? '' : 'offscreen',
    ].filter(Boolean);
    const description = `${kind} "${label}"`;
    return {
      id,
      action: { selector: el.selector, description, method },
      line: `${id}: ${description}${extras.length ? ` (${extras.join(', ')})` : ''}`,
    };
  });

  return { url: raw.url, title: raw.title, elements, text: raw.text };
}

export function formatPageState(snapshot: PageSnapshot): string {
  const header = `PAGE STATE — ${snapshot.url} (title: ${snapshot.title})`;
  const list = snapshot.elements.length
    ? snapshot.elements.map((e) => e.line).join('\n')
    : '(no interactive elements found — page may still be loading; use screenshot)';
  const text = snapshot.text ? `\nVisible text: ${snapshot.text}` : '';
  return `${header}\n${list}${text}`;
}
