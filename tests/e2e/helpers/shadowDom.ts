import { Page, Locator } from '@playwright/test';

/**
 * Walks a chain of CSS selectors through nested shadow roots.
 * Works for both native shadow DOM (LWC API 39+ native mode)
 * and Salesforce's synthetic shadow (where this is a no-op fallback).
 *
 * Usage:
 *   const el = await deepQuery(page, 'c-furu-agent-bar', '.furu-bar__textarea');
 */
export async function deepQuery(page: Page, ...selectors: string[]): Promise<ReturnType<Page['locator']>> {
  const handle = await page.evaluateHandle((sels: string[]) => {
    let root: Document | Element | ShadowRoot | null = document;
    for (const sel of sels) {
      if (!root) return null;
      const searchRoot: Element | Document | ShadowRoot =
        (root as Element).shadowRoot ?? root as (Document | ShadowRoot);
      root = searchRoot.querySelector(sel);
    }
    return root as Element | null;
  }, selectors);

  const el = handle.asElement();
  if (!el) throw new Error(`deepQuery: element not found — ${selectors.join(' → ')}`);
  return page.locator(':root').locator('xpath=' + (await el.evaluate(e => getXPath(e))));
}

/** Shallow: try Playwright's natural locator first, fall back to shadow piercing. */
export function barLocator(page: Page, cssSelector: string): Locator {
  // In Salesforce synthetic shadow, Playwright can find elements with a simple CSS path.
  // In native shadow we rely on Playwright's internal shadow piercing (>>) or JS evaluation.
  return page.locator(`c-furu-agent-bar ${cssSelector}`);
}

/** Fills a text input inside the bar (works regardless of shadow mode). */
export async function fillBarInput(page: Page, selector: string, value: string): Promise<void> {
  await page.evaluate(
    ({ sel, val }: { sel: string; val: string }) => {
      const bar = document.querySelector('c-furu-agent-bar');
      const root: ShadowRoot | Element = (bar as HTMLElement)?.shadowRoot ?? bar!;
      const inp = root.querySelector(sel) as HTMLInputElement | HTMLTextAreaElement | null;
      if (!inp) throw new Error(`fillBarInput: ${sel} not found`);
      inp.focus();
      inp.value = val;
      inp.dispatchEvent(new Event('input',  { bubbles: true }));
      inp.dispatchEvent(new Event('change', { bubbles: true }));
    },
    { sel: selector, val: value }
  );
}

/** Clicks an element inside the bar's shadow root. */
export async function clickInBar(page: Page, selector: string): Promise<void> {
  await page.evaluate((sel: string) => {
    const bar = document.querySelector('c-furu-agent-bar');
    const root: ShadowRoot | Element = (bar as HTMLElement)?.shadowRoot ?? bar!;
    const el = root.querySelector(sel) as HTMLElement | null;
    if (!el) throw new Error(`clickInBar: ${sel} not found`);
    el.click();
  }, selector);
}

/** Reads text content of an element inside the bar's shadow root. */
export async function readBarText(page: Page, selector: string): Promise<string> {
  return page.evaluate((sel: string) => {
    const bar = document.querySelector('c-furu-agent-bar');
    const root: ShadowRoot | Element = (bar as HTMLElement)?.shadowRoot ?? bar!;
    return (root.querySelector(sel) as HTMLElement)?.innerText?.trim() ?? '';
  }, selector);
}

/** Waits until an element exists in the bar's shadow root. */
export async function waitForInBar(
  page: Page,
  selector: string,
  { timeout = 30_000 }: { timeout?: number } = {}
): Promise<void> {
  await page.waitForFunction(
    (sel: string) => {
      const bar = document.querySelector('c-furu-agent-bar');
      const root: ShadowRoot | Element = (bar as HTMLElement)?.shadowRoot ?? bar!;
      return !!root.querySelector(sel);
    },
    selector,
    { timeout }
  );
}

// Helper used in deepQuery XPath fallback
function getXPath(el: Element): string {
  if (el.id) return `//*[@id="${el.id}"]`;
  const parts: string[] = [];
  let curr: Element | null = el;
  while (curr && curr.nodeType === Node.ELEMENT_NODE) {
    let idx = 1;
    let sib: Element | null = curr.previousElementSibling;
    while (sib) { if (sib.tagName === curr.tagName) idx++; sib = sib.previousElementSibling; }
    parts.unshift(`${curr.tagName.toLowerCase()}[${idx}]`);
    curr = curr.parentElement;
  }
  return '/' + parts.join('/');
}
