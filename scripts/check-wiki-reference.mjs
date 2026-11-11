// UI smoke: every Wiki mutation is intercepted; stored pages are never changed.
import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
const base = process.env.APP_URL || 'http://127.0.0.1:3020';
const browser = await chromium.launch({ args: ['--no-sandbox'] });
const errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 1643, height: 900 } });
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(`${base}/login`);
  await page.locator('#email').fill(process.env.TEST_EMAIL || 'admin@onyx.dev');
  await page.locator('#password').fill(process.env.TEST_PASSWORD || 'password123');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL(`${base}/`);
  const response = await page.request.get(`${base}/api/wiki/pages`);
  assert.equal(response.status(), 200);
  const { pages } = await response.json();
  assert.ok(pages.length, 'An existing page is required; this test creates no stored data.');
  const id = pages.find(p => p.title === 'Untitled')?.id || pages[0].id;
  const route = `${base}/wiki/${id}`;
  const open = async () => {
    await page.goto(route);
    await page.getByRole('button', { name: 'Choose page icon', exact: true }).waitFor();
    await page.locator('.ProseMirror[contenteditable=true]').waitFor();
  };
  const detailResponse = await page.request.get(`${base}/api/wiki/pages/${id}`);
  const { page: original } = await detailResponse.json();
  let writes = [];
  let failNext = false;
  // Fail closed for every Wiki mutation, including unexpected endpoint changes.
  await page.route('**/api/wiki/**', async intercepted => {
    const request = intercepted.request();
    if (['GET', 'HEAD'].includes(request.method())) return intercepted.continue();
    if (request.method() === 'PATCH' && new URL(request.url()).pathname === `/api/wiki/pages/${id}`) {
      if (failNext) {
        failNext = false;
        return intercepted.fulfill({ status: 503, json: { error: 'Test connection failure' } });
      }
      const draft = request.postDataJSON();
      writes.push(draft);
      return intercepted.fulfill({ json: { page: { ...original, ...draft } } });
    }
    return intercepted.abort();
  });
  await open();
  assert.equal(writes.length, 0, 'Untouched page should not autosave');
  const header = page.getByRole('group', { name: 'Formatting', exact: true });
  await expect(header).toBeVisible();
  for (const name of ['Bold', 'Italic', 'Ordered list', 'Bullet list', 'To-do list', 'Insert table']) await expect(header.getByRole('button', { name, exact: true })).toBeVisible();
  for (const name of ['Save', 'Cancel', 'Preview', 'Copy link', 'Delete']) {
    await expect(page.getByRole('button', { name, exact: true })).toHaveCount(0);
  }
  await expect(page.getByRole('link', { name: 'All pages', exact: true })).toHaveCount(0);
  await page.getByLabel('Page title', { exact: true }).fill('Autosave smoke title');
  await page.locator('.ProseMirror').fill('Autosave smoke body');
  await expect.poll(() => writes.some(d => d.title === 'Autosave smoke title' && JSON.stringify(d.content).includes('Autosave smoke body'))).toBe(true);
  failNext = true;
  await page.getByLabel('Page title', { exact: true }).fill('Retry smoke title');
  await expect(page.locator('.wiki-document-workspace').getByRole('alert')).toContainText('Test connection failure');
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.locator('.wiki-document-workspace').getByRole('alert')).toHaveCount(0);
  assert.equal(writes.at(-1).title, 'Retry smoke title');
  await open();
  mkdirSync('/tmp/wiki-reference-check', { recursive: true });
  await page.getByRole('button', { name: 'Choose page icon', exact: true }).click();
  await page.getByRole('button', { name: 'Use 🚀 icon', exact: true }).click();
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.wiki-page-icon-display').textContent(), '🚀');
  await page.locator('.ProseMirror').fill('Alignment check');
  await expect(page.getByRole('group', { name: 'Selection formatting', exact: true })).not.toBeVisible();
  await page.keyboard.press('ControlOrMeta+a');
  await expect(page.getByRole('group', { name: 'Selection formatting', exact: true })).toBeVisible();
  await page.keyboard.press('Alt+F10');
  await expect(page.locator('.wiki-selection-toolbar').getByLabel('Text style', { exact: true })).toBeFocused();
  await page.locator('.wiki-selection-toolbar').getByRole('button', { name: 'Align center', exact: true }).click();
  assert.equal(await page.locator('.ProseMirror p').first().evaluate(e => e.style.textAlign), 'center');
  await page.locator('.wiki-selection-toolbar').getByRole('button', { name: 'Underline', exact: true }).click();
  assert.ok(await page.locator('.ProseMirror u').count());
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('group', { name: 'Selection formatting', exact: true })).not.toBeVisible();
  await page.keyboard.press('ControlOrMeta+a');
  await header.getByLabel('Text style', { exact: true }).selectOption('text');
  await page.locator('.ProseMirror').fill('First block');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Second block');
  const handle = page.getByRole('button', { name: 'Move block', exact: true });
  await handle.focus();
  await page.keyboard.press('Alt+ArrowUp');
  assert.deepEqual(await page.locator('.ProseMirror > p').allTextContents(), ['Second block', 'First block']);
  await page.keyboard.press('Alt+ArrowDown');
  assert.deepEqual(await page.locator('.ProseMirror > p').allTextContents(), ['First block', 'Second block']);
  await page.locator('.ProseMirror > p').first().hover();
  const first = await page.locator('.ProseMirror > p').first().boundingBox();
  const second = await page.locator('.ProseMirror > p').nth(1).boundingBox();
  const transfer = await page.evaluateHandle(() => new DataTransfer());
  await handle.dispatchEvent('dragstart', { dataTransfer: transfer });
  await page.locator('.ProseMirror > p').nth(1).dispatchEvent('drop', { dataTransfer: transfer, clientX: second.x + 20, clientY: second.y + second.height - 1 });
  assert.deepEqual(await page.locator('.ProseMirror > p').allTextContents(), ['Second block', 'First block']);
  assert.ok(first);
  // Reload restores the stored original; all smoke writes above were mocked.
  await open();

  // Regression assertions:
  // 1. History buttons disabled state
  await expect(header.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  await expect(header.getByRole('button', { name: 'Redo', exact: true })).toBeDisabled();

  // 2. Inline mark scoping: marks do not spill to neighbors
  await page.locator('.ProseMirror').fill('Scoped mark test');
  await page.locator('.ProseMirror').click();
  await page.evaluate(() => {
    const editorEl = document.querySelector('.ProseMirror');
    const p = editorEl.querySelector('p');
    const textNode = p.firstChild;
    const range = document.createRange();
    range.setStart(textNode, 7); // start of "mark"
    range.setEnd(textNode, 11);  // end of "mark"
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  });
  await header.getByRole('button', { name: 'Bold', exact: true }).click();
  assert.equal(await page.locator('.ProseMirror strong').textContent(), 'mark');
  assert.equal(await page.locator('.ProseMirror p').first().textContent(), 'Scoped mark test');

  // 3. Truthful block style select + text reversion preserving sibling list items
  await page.locator('.ProseMirror').click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('Backspace');
  await header.getByRole('button', { name: 'Bullet list', exact: true }).click();
  await page.keyboard.type('Item 1');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Item 2');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Item 3');
  const select = header.getByLabel('Text style', { exact: true });
  await expect(select).toHaveValue('bulletList');

  // Place cursor in Item 2
  await page.locator('.ProseMirror li').nth(1).click();
  await expect(select).toHaveValue('bulletList');
  // Change style to Text
  await select.selectOption('text');
  // Item 1 and Item 3 remain list items; Item 2 becomes top-level paragraph
  assert.equal(await page.locator('.ProseMirror ul > li').count(), 2);
  assert.ok((await page.locator('.ProseMirror > p').allTextContents()).includes('Item 2'));
  await expect(select).toHaveValue('text');

  // 4. Color popover Escape dismiss restores editor focus without losing selection
  await page.locator('.ProseMirror > p').first().click();
  await page.keyboard.press('ControlOrMeta+a');
  await header.getByRole('button', { name: 'Text color', exact: true }).click();
  await expect(page.locator('.wiki-color-menu')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.wiki-color-menu')).not.toBeVisible();
  await page.keyboard.type(' Typing works');
  assert.ok((await page.locator('.ProseMirror').textContent()).includes('Typing works'));

  // 5. Link editing: caret insertion, extendMarkRange on existing links, rejecting unsafe URLs
  await page.locator('.ProseMirror').fill('');
  await page.locator('.ProseMirror').click();
  const linkDialog = page.getByRole('dialog');
  const linkUrl = linkDialog.getByRole('textbox', { name: 'Link URL', exact: true });
  await header.getByRole('button', { name: 'Add link', exact: true }).click();
  await linkUrl.fill('https://onyx.dev');
  await linkUrl.press('Enter');
  await expect(linkDialog).not.toBeVisible();
  assert.equal(await page.locator('.ProseMirror a[href="https://onyx.dev"]').count(), 1);
  assert.equal(await page.locator('.ProseMirror a').textContent(), 'https://onyx.dev');

  // Place caret inside link and update href
  await page.locator('.ProseMirror a').click();
  await header.getByRole('button', { name: 'Add link', exact: true }).click();
  await expect(linkUrl).toHaveValue('https://onyx.dev');
  await linkUrl.fill('https://onyx.dev/updated');
  await linkUrl.press('Enter');
  await expect(linkDialog).not.toBeVisible();
  assert.equal(await page.locator('.ProseMirror a[href="https://onyx.dev/updated"]').count(), 1);
  assert.equal(await page.locator('.ProseMirror a').textContent(), 'https://onyx.dev');

  // Reject unsafe url
  await header.getByRole('button', { name: 'Add link', exact: true }).click();
  await linkUrl.fill('javascript:alert(1)');
  await linkUrl.press('Enter');
  await expect(linkDialog.getByRole('alert')).toBeVisible();
  assert.equal(await page.locator('.ProseMirror a[href*="javascript"]').count(), 0);
  assert.equal(await page.locator('.ProseMirror a[href="https://onyx.dev/updated"]').count(), 1);
  await linkDialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(linkDialog).not.toBeVisible();

  await open();
  await page.locator('.ProseMirror').fill('');
  await page.locator('.ProseMirror').click();
  await page.keyboard.type('/todo');
  console.log('slash options', await page.locator('.wiki-slash-menu').getByRole('option').allTextContents());
  await page.locator('.wiki-slash-menu').getByRole('option').filter({ hasText: 'To-do list' }).click();
  assert.equal(await page.locator('.ProseMirror input[type=checkbox]').count(), 1);
  await open();
  await page.getByLabel('Page title', { exact: true }).fill('Test');
  await page.locator('.ProseMirror').click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('dawawdawdaw'.repeat(50));
  await page.keyboard.press('Enter');
  await page.keyboard.type('dawawdawsadaw13123312'.repeat(18));
  await page.keyboard.press('Enter');
  await expect(page.locator('.ProseMirror > p').last()).toHaveAttribute('data-placeholder', "Press '/' for commands…");
  for (const width of [320, 390, 768, 1643]) {
    await page.setViewportSize({ width, height: 900 });
    await page.getByLabel('Page title', { exact: true }).focus();
    await expect(page.getByRole('group', { name: 'Selection formatting', exact: true })).not.toBeVisible();
    await page.getByRole('button', { name: 'Show details panel', exact: true }).focus();
    await page.mouse.move(300, 80);
    await page.screenshot({ path: `/tmp/wiki-reference-check/${width}.png` });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `overflow at ${width}`);
    await page.locator('.ProseMirror > p').first().click();
    await page.keyboard.press('ControlOrMeta+a');
    await expect(page.getByRole('group', { name: 'Selection formatting', exact: true })).toBeVisible();
    await expect.poll(() => page.locator('.wiki-selection-toolbar').evaluate(e => {
      const r = e.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth;
    })).toBe(true);
    await page.screenshot({ path: `/tmp/wiki-reference-check/${width}-selection.png` });
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('group', { name: 'Selection formatting', exact: true })).not.toBeVisible();
  }
  for (const scenario of [
    { width: 320, height: 568 },
    { width: 390, height: 400 },
    { width: 820, height: 450, largeText: true },
    { width: 1643, height: 900, rtl: true, dark: true },
  ]) {
    await page.setViewportSize({ width: scenario.width, height: scenario.height });
    await open();
    await page.evaluate(s => {
      document.documentElement.dir = s.rtl ? 'rtl' : 'ltr';
      document.documentElement.classList.toggle('dark', Boolean(s.dark));
      document.documentElement.style.fontSize = s.largeText ? '32px' : '';
    }, scenario);
    await page.locator('.ProseMirror').fill('');
    await page.locator('.ProseMirror').click();
    await page.keyboard.type('/');
    const menu = page.getByRole('listbox', { name: 'Insert blocks' });
    await expect(menu).toBeVisible();
    const metrics = await menu.evaluate(e => {
      const r = e.getBoundingClientRect();
      const glyph = e.querySelector('.wiki-slash-glyph');
      return {
        inside: r.left >= 7 && r.right <= innerWidth - 7 && r.top >= 7 && r.bottom <= innerHeight - 7,
        scrollbar: e.classList.contains('custom-scrollbar'),
        thumb: getComputedStyle(e, '::-webkit-scrollbar-thumb').borderRadius,
        glyphWrap: getComputedStyle(glyph).whiteSpace,
        noHorizontalScroll: e.scrollWidth <= e.clientWidth,
      };
    });
    assert.equal(metrics.inside, true, JSON.stringify(scenario));
    assert.equal(metrics.scrollbar, true);
    assert.equal(metrics.thumb, '9999px');
    assert.equal(metrics.glyphWrap, 'nowrap');
    assert.equal(metrics.noHorizontalScroll, true);
    // Long translated labels wrap within their column, not beneath the glyph.
    await menu.getByRole('option').first().locator('.wiki-slash-title').evaluate(e => { e.textContent = 'Sehr langer übersetzter Absatzbefehl ohne abgeschnittene Inhalte'; });
    assert.equal(await menu.evaluate(e => e.scrollWidth <= e.clientWidth), true);
    const optionCount = await menu.getByRole('option').count();
    for (let n = 1; n < optionCount; n++) await page.keyboard.press('ArrowDown');
    const selected = menu.locator('[aria-selected="true"]');
    await expect(selected).toContainText('Table');
    assert.equal(await selected.evaluate(e => {
      const r = e.getBoundingClientRect(), m = e.parentElement.getBoundingClientRect();
      return r.top >= m.top && r.bottom <= m.bottom;
    }), true);
    await page.screenshot({ path: `/tmp/wiki-reference-check/slash-${scenario.width}.png` });
    await page.keyboard.press('Escape');
  }
  assert.deepEqual(errors, []);
  console.log('PASS: header + selection toolbars, autosave/retry, block reorder, slash scrollbar/geometry/keyboard, RTL, long labels, 200% text, responsive widths; no stored edits');
} finally { await browser.close(); }
