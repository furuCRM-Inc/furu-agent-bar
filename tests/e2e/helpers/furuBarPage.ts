import { Page } from '@playwright/test';
import { clickInBar, readBarText, waitForInBar } from './shadowDom';

const APP_URL = process.env.SF_APP_URL ?? '/lightning/app/standard__LightningInstrumentation';

/**
 * Page-object for the furuAgentBar utility-bar component.
 * All interactions go through shadow-DOM-safe helpers.
 */
export class FuruBarPage {
  constructor(private readonly page: Page) {}

  // ── Navigation ─────────────────────────────────────────────────────────────

  async goto() {
    // Navigate to about:blank first to force a full Salesforce Lightning cold start.
    // Without this, goto() to the same URL triggers a soft SPA navigation and
    // preserves all LWC component state (SOQL results, CSV import card, etc.)
    // across tests, causing stale-state false positives.
    await this.page.goto('about:blank');
    await this.page.goto(APP_URL, { waitUntil: 'load' });
    await this.page.waitForTimeout(2_000);
  }

  /** Navigate to an sObject list view so _sObjectType is set for context-aware features (e.g. CSV import). */
  async gotoObject(sObjectType: string) {
    await this.page.goto('about:blank');
    await this.page.goto(`/lightning/o/${sObjectType}/list?filterName=Recent`, { waitUntil: 'load' });
    await this.page.waitForTimeout(2_000);
  }

  /** Opens the utility bar panel (clicks the bar's expand button). */
  async openPanel() {
    // Wait until the Lightning framework has painted the page body (not networkidle —
    // Salesforce Lightning never reaches networkidle due to continuous background polling).
    await this.page.waitForSelector('body.desktop', { timeout: 30_000 }).catch(() => {});
    await this.page.waitForSelector('.slds-utility-bar, one-utility-bar, runtime_utility_bar-utility-bar', {
      timeout: 30_000,
    });

    // Dismiss any open Lightning modal/backdrop before clicking the utility bar.
    // After many serial tests the org can leave slds-backdrop_open which intercepts clicks.
    const backdrop = this.page.locator('.slds-backdrop_open');
    if (await backdrop.count() > 0) {
      await this.page.keyboard.press('Escape');
      await backdrop.waitFor({ state: 'hidden', timeout: 5_000 }).catch(() => {});
    }

    // Try specific label-based selectors first to avoid clicking the wrong utility item
    // (e.g. To Do List, Macros).  Only fall back to the generic selector as a last resort,
    // and even then pick the LAST button because furuAgentBar is typically added last.
    const specificSelectors = [
      'button[aria-label*="furuAgent"]',
      'button[aria-label*="FlashBar"]',
      'button[aria-label*="Furu"]',
      'button[title*="furuAgent"]',
    ];

    let clicked = false;
    for (const sel of specificSelectors) {
      const btn = this.page.locator(sel).first();
      if (await btn.count() > 0) {
        await btn.waitFor({ state: 'visible', timeout: 10_000 }).catch(() => {});
        await btn.click();
        clicked = true;
        break;
      }
    }

    if (!clicked) {
      // Generic fallback: pick the LAST utility bar button (furuAgentBar is usually last)
      const utilityBtns = this.page.locator(
        '.slds-utility-bar__item button, one-utility-bar-item button'
      );
      await utilityBtns.last().waitFor({ state: 'visible', timeout: 30_000 });
      await utilityBtns.last().click();
    }

    // Wait until the bar's textarea is present in the shadow root.
    await this.page.waitForFunction(() => {
      const bar = document.querySelector('c-furu-agent-bar');
      if (!bar) return false;
      const root = (bar as HTMLElement).shadowRoot ?? bar;
      return !!root.querySelector('.furu-bar__textarea');
    }, { timeout: 30_000 });
    // Allow LWC @wire adapters to finish their first data fetch
    await this.page.waitForTimeout(2_000);
  }

  async closePanel() {
    await clickInBar(this.page, '.furu-bar__close, [title="Close"]').catch(() => {});
  }

  // ── Input ──────────────────────────────────────────────────────────────────

  async typeCommand(text: string) {
    // LWC native shadow DOM prevents Playwright locator actions from piercing reliably.
    // Set value directly and dispatch DOM events that LWC listens to.
    // composed:true lets events cross shadow boundaries if needed.
    await this.page.evaluate((txt: string) => {
      const bar  = document.querySelector('c-furu-agent-bar');
      const root = (bar as HTMLElement)?.shadowRoot ?? bar!;
      const ta   = root.querySelector('.furu-bar__textarea') as HTMLTextAreaElement | null;
      if (!ta) throw new Error('typeCommand: .furu-bar__textarea not found');
      ta.value = txt;
      ta.dispatchEvent(new InputEvent('input',  { bubbles: true, composed: true }));
      ta.dispatchEvent(new Event('change',      { bubbles: true, composed: true }));
    }, text);
  }

  async submit() {
    // Dispatch a KeyboardEvent directly on the textarea — LWC's onkeydown handler
    // listens for key==='Enter' to call handleSubmit().
    await this.page.evaluate(() => {
      const bar  = document.querySelector('c-furu-agent-bar');
      const root = (bar as HTMLElement)?.shadowRoot ?? bar!;
      const ta   = root.querySelector('.furu-bar__textarea') as HTMLTextAreaElement | null;
      if (!ta) throw new Error('submit: .furu-bar__textarea not found');
      ta.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter', code: 'Enter', keyCode: 13,
        bubbles: true, composed: true, cancelable: true,
      }));
    });
  }

  async clearInput() {
    await this.page.evaluate(() => {
      const bar  = document.querySelector('c-furu-agent-bar');
      const root = (bar as HTMLElement)?.shadowRoot ?? bar!;
      const ta   = root.querySelector('.furu-bar__textarea') as HTMLTextAreaElement | null;
      if (ta) {
        ta.value = '';
        ta.dispatchEvent(new InputEvent('input',  { bubbles: true, composed: true }));
        ta.dispatchEvent(new Event('change',      { bubbles: true, composed: true }));
      }
    });
  }

  // ── Status ─────────────────────────────────────────────────────────────────

  async waitForStatus(keyword: string, timeout = 20_000) {
    await this.page.waitForFunction(
      ({ sel, kw }: { sel: string; kw: string }) => {
        const bar = document.querySelector('c-furu-agent-bar');
        const root = (bar as HTMLElement)?.shadowRoot ?? bar!;
        const el = root.querySelector(sel) as HTMLElement;
        return el?.innerText?.includes(kw) ?? false;
      },
      { sel: '.furu-bar__status', kw: keyword },
      { timeout }
    );
  }

  async statusText(): Promise<string> {
    return readBarText(this.page, '.furu-bar__status');
  }

  // ── SOQL Results ───────────────────────────────────────────────────────────

  /**
   * Load Account records by clicking the pre-seeded shortcut chip injected in
   * globalSetup.  Bypasses processIntent (AI backend) entirely — executeSoqlQuery
   * is called directly by _runSoqlFromSaved(), so this works even when the AI
   * worker is down.
   */
  async loadAccountsViaShortcut() {
    // Try the pre-seeded shortcut chip first (fast path, bypasses AI Worker).
    // Falls back to a direct NL query if the chip isn't present within 8 s
    // (e.g. storageState was not applied to this origin in the current run).
    const chipFound = await this.page.waitForFunction(() => {
      const bar  = document.querySelector('c-furu-agent-bar');
      const root = (bar as HTMLElement)?.shadowRoot ?? bar!;
      const chips = Array.from(root.querySelectorAll('.furu-bar__shortcut-run'));
      return chips.some(c => c.textContent?.includes('__e2e_test_accounts__'));
    }, { timeout: 8_000 }).then(() => true).catch(() => false);

    if (chipFound) {
      await this.page.evaluate(() => {
        const bar  = document.querySelector('c-furu-agent-bar');
        const root = (bar as HTMLElement)?.shadowRoot ?? bar!;
        const chips = Array.from(root.querySelectorAll('.furu-bar__shortcut-run'));
        const chip  = chips.find(c => c.textContent?.includes('__e2e_test_accounts__'));
        (chip as HTMLButtonElement | undefined)?.click();
      });
    } else {
      // Fallback: submit a direct query for up to 5 Accounts
      await this.typeCommand('取引先を5件見せて');
      await this.submit();
    }

    await this.waitForSoqlResults(90_000);
  }

  async waitForSoqlResults(timeout = 30_000) {
    // Retry loop: if the backend returns HTTP 500, dismiss the error and re-submit.
    // The textarea keeps its text on error (handleSubmit only calls _resetInput() on success),
    // so submit() can be called again without re-typing.
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const hasSoql = await this.page.evaluate(() => {
        const bar = document.querySelector('c-furu-agent-bar');
        const root = (bar as HTMLElement)?.shadowRoot ?? bar!;
        return !!(root.querySelector('.furu-bar__soql-table, .furu-bar__soql-list'));
      });
      if (hasSoql) return;

      const hasError = await this.page.evaluate(() => {
        const bar = document.querySelector('c-furu-agent-bar');
        const root = (bar as HTMLElement)?.shadowRoot ?? bar!;
        return !!(root.querySelector('.furu-bar__status--error'));
      });

      if (hasError) {
        await this.page.evaluate(() => {
          const bar = document.querySelector('c-furu-agent-bar');
          const root = (bar as HTMLElement)?.shadowRoot ?? bar!;
          const btn = root.querySelector(
            '.furu-bar__status--error .furu-bar__pill-btn--muted'
          ) as HTMLButtonElement | null;
          btn?.click();
        });
        await this.page.waitForTimeout(1_500);
        await this.submit();
        await this.page.waitForTimeout(3_000);
      } else {
        await this.page.waitForTimeout(2_000);
      }
    }
    throw new Error(`waitForSoqlResults: timed out after ${timeout}ms`);
  }

  async isTableVisible(): Promise<boolean> {
    return this.page.evaluate(() => {
      const bar = document.querySelector('c-furu-agent-bar');
      const root = (bar as HTMLElement)?.shadowRoot ?? bar!;
      return !!root.querySelector('.furu-bar__soql-table');
    });
  }

  async soqlRowCount(): Promise<number> {
    return this.page.evaluate(() => {
      const bar = document.querySelector('c-furu-agent-bar');
      const root = (bar as HTMLElement)?.shadowRoot ?? bar!;
      return root.querySelectorAll('.furu-bar__soql-tr').length;
    });
  }

  async switchToTableView() {
    // The LWC has a ResizeObserver that resets _viewMode to 'card' when the utility
    // bar panel width ≤ 480 px.  We use .furu-bar__soql-table as the indicator
    // because it is confirmed queryable from page context; .furu-bar__soql-table-actions
    // sits in the same lwc:if block, so table presence implies actions are also in DOM.
    for (let attempt = 0; attempt < 8; attempt++) {
      // Short-circuit if already in table mode
      const alreadyTable = await this.page.evaluate(() => {
        const bar  = document.querySelector('c-furu-agent-bar');
        const root = (bar as HTMLElement)?.shadowRoot ?? bar!;
        return !!root.querySelector('.furu-bar__soql-table');
      });
      if (alreadyTable) {
        await this.page.waitForTimeout(1_500);
        const stillTable = await this.page.evaluate(() => {
          const bar  = document.querySelector('c-furu-agent-bar');
          const root = (bar as HTMLElement)?.shadowRoot ?? bar!;
          return !!root.querySelector('.furu-bar__soql-table');
        });
        if (stillTable) return;
      }

      const hasBtn = await this.page.evaluate(() => {
        const bar  = document.querySelector('c-furu-agent-bar');
        const root = (bar as HTMLElement)?.shadowRoot ?? bar!;
        const btns = Array.from(root.querySelectorAll('.furu-bar__soql-view-btn'));
        const tableBtn = btns.find(b => b.textContent?.includes('📊'));
        if (tableBtn) (tableBtn as HTMLButtonElement).click();
        return !!tableBtn;
      });

      if (!hasBtn) {
        await this.page.waitForTimeout(1_000);
        continue;
      }

      // Wait for table element to appear in the DOM
      const tableFound = await this.page.waitForFunction(() => {
        const bar  = document.querySelector('c-furu-agent-bar');
        const root = (bar as HTMLElement)?.shadowRoot ?? bar!;
        return !!root.querySelector('.furu-bar__soql-table');
      }, { timeout: 10_000 }).then(() => true).catch(() => false);

      if (!tableFound) {
        await this.page.waitForTimeout(500);
        continue;
      }

      // Verify table survives the ResizeObserver settle window
      await this.page.waitForTimeout(2_000);
      const stillVisible = await this.page.evaluate(() => {
        const bar  = document.querySelector('c-furu-agent-bar');
        const root = (bar as HTMLElement)?.shadowRoot ?? bar!;
        return !!root.querySelector('.furu-bar__soql-table');
      });
      if (stillVisible) return;
    }
    throw new Error('switchToTableView: .furu-bar__soql-table did not stay visible after 8 attempts');
  }

  // ── Inline Edit ────────────────────────────────────────────────────────────

  async toggleInlineEdit() {
    const isEntering = await this.page.evaluate(() => {
      const bar  = document.querySelector('c-furu-agent-bar');
      const root = (bar as HTMLElement)?.shadowRoot ?? bar!;
      const btns = Array.from(root.querySelectorAll('button'));
      const btn  = btns.find(b => b.textContent?.includes('インライン編集') || b.textContent?.includes('編集終了'));
      const entering = !!btn?.textContent?.includes('インライン編集');
      (btn as HTMLButtonElement | undefined)?.click();
      return entering;
    });

    if (isEntering) {
      // Entering edit mode triggers getEditSchema Apex — wait until cell inputs appear.
      // 45s: getEditSchema is cacheable but first-call on a slow org can exceed 30s.
      await this.page.waitForFunction(() => {
        const bar  = document.querySelector('c-furu-agent-bar');
        const root = (bar as HTMLElement)?.shadowRoot ?? bar!;
        return root.querySelectorAll('.furu-bar__cell-input, .furu-bar__cell-check').length > 0;
      }, { timeout: 45_000 });
    } else {
      // Exiting edit mode — wait for inputs to disappear
      await this.page.waitForFunction(() => {
        const bar  = document.querySelector('c-furu-agent-bar');
        const root = (bar as HTMLElement)?.shadowRoot ?? bar!;
        return root.querySelectorAll('.furu-bar__cell-input').length === 0;
      }, { timeout: 10_000 });
    }
  }

  async editCellInRow(rowIndex: number, apiName: string, value: string) {
    await this.page.evaluate(
      ({ ri, api, val }: { ri: number; api: string; val: string }) => {
        const bar = document.querySelector('c-furu-agent-bar');
        const root = (bar as HTMLElement)?.shadowRoot ?? bar!;
        const input = root.querySelector(
          `[data-record-id][data-api-name="${api}"]`
        ) as HTMLInputElement | null;
        if (!input) throw new Error(`Cell input for ${api} not found`);
        input.focus();
        input.value = val;
        input.dispatchEvent(new Event('change', { bubbles: true }));
      },
      { ri: rowIndex, api: apiName, val: value }
    );
  }

  async clickSave() {
    await this.page.evaluate(() => {
      const bar = document.querySelector('c-furu-agent-bar');
      const root = (bar as HTMLElement)?.shadowRoot ?? bar!;
      const btns = Array.from(root.querySelectorAll('button'));
      const btn = btns.find(b => b.textContent?.includes('保存') && !b.disabled);
      (btn as HTMLButtonElement | undefined)?.click();
    });
  }

  async clickDiscard() {
    await this.page.evaluate(() => {
      const bar = document.querySelector('c-furu-agent-bar');
      const root = (bar as HTMLElement)?.shadowRoot ?? bar!;
      const btns = Array.from(root.querySelectorAll('button'));
      const btn = btns.find(b => b.textContent?.includes('破棄'));
      (btn as HTMLButtonElement | undefined)?.click();
    });
  }

  async isDirtyCellVisible(): Promise<boolean> {
    return this.page.evaluate(() => {
      const bar = document.querySelector('c-furu-agent-bar');
      const root = (bar as HTMLElement)?.shadowRoot ?? bar!;
      return !!root.querySelector('.furu-bar__soql-td--dirty');
    });
  }

  async isDirtyBadgeVisible(): Promise<boolean> {
    return this.page.evaluate(() => {
      const bar = document.querySelector('c-furu-agent-bar');
      const root = (bar as HTMLElement)?.shadowRoot ?? bar!;
      return !!root.querySelector('.furu-bar__soql-dirty-badge');
    });
  }

  // ── Navigation Hub ─────────────────────────────────────────────────────────

  async openPinDialog() {
    await this.page.evaluate(() => {
      const bar = document.querySelector('c-furu-agent-bar');
      const root = (bar as HTMLElement)?.shadowRoot ?? bar!;
      const btns = Array.from(root.querySelectorAll('button'));
      const btn = btns.find(b => b.textContent?.includes('ピン留め') && !b.textContent?.includes('ピン留め名'));
      (btn as HTMLButtonElement | undefined)?.click();
    });
    await waitForInBar(this.page, '.furu-bar__pin-input');
  }

  async fillPinLabel(label: string) {
    await this.page.evaluate((val: string) => {
      const bar = document.querySelector('c-furu-agent-bar');
      const root = (bar as HTMLElement)?.shadowRoot ?? bar!;
      const inp = root.querySelector('.furu-bar__pin-input') as HTMLInputElement;
      inp.value = val;
      inp.dispatchEvent(new Event('input', { bubbles: true }));
    }, label);
  }

  async confirmPin() {
    await this.page.evaluate(() => {
      const bar = document.querySelector('c-furu-agent-bar');
      const root = (bar as HTMLElement)?.shadowRoot ?? bar!;
      const btns = Array.from(root.querySelectorAll('.furu-bar__pin-dialog-actions button'));
      (btns[0] as HTMLButtonElement | undefined)?.click();
    });
  }

  async navHubItemCount(): Promise<number> {
    return this.page.evaluate(() => {
      const bar = document.querySelector('c-furu-agent-bar');
      const root = (bar as HTMLElement)?.shadowRoot ?? bar!;
      return root.querySelectorAll('.furu-bar__nav-item').length;
    });
  }

  async clickNavItem(label: string) {
    await this.page.evaluate((lbl: string) => {
      const bar = document.querySelector('c-furu-agent-bar');
      const root = (bar as HTMLElement)?.shadowRoot ?? bar!;
      const items = Array.from(root.querySelectorAll('.furu-bar__nav-item-btn'));
      const item = items.find(el => el.textContent?.includes(lbl));
      (item as HTMLButtonElement | undefined)?.click();
    }, label);
  }

  async deleteNavItem(label: string) {
    await this.page.evaluate((lbl: string) => {
      const bar = document.querySelector('c-furu-agent-bar');
      const root = (bar as HTMLElement)?.shadowRoot ?? bar!;
      const items = Array.from(root.querySelectorAll('.furu-bar__nav-item'));
      const item = items.find(el => el.querySelector('.furu-bar__nav-item-label')?.textContent?.includes(lbl));
      (item?.querySelector('.furu-bar__nav-item-del') as HTMLButtonElement | undefined)?.click();
    }, label);
  }

  async isNavHubVisible(): Promise<boolean> {
    return this.page.evaluate(() => {
      const bar = document.querySelector('c-furu-agent-bar');
      const root = (bar as HTMLElement)?.shadowRoot ?? bar!;
      return !!root.querySelector('.furu-bar__nav-hub');
    });
  }
}
