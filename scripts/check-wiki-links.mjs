// UI regression: all Wiki mutations are mocked; stored documents are never changed.
import assert from 'node:assert/strict';
import { chromium, webkit, expect } from '@playwright/test';
const base = process.env.APP_URL || 'http://127.0.0.1:3020';
const engine = process.env.BROWSER === 'webkit' ? webkit : chromium;
const browser = await engine.launch({ args: engine === chromium ? ['--no-sandbox'] : [] });
try {
  const page = await browser.newPage();
  const errors = [];
  const dialogs = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', async dialog => { dialogs.push(dialog.type()); await dialog.dismiss(); });
  const auth = await page.request.post(`${base}/api/auth/login`, { data: {
    email: process.env.TEST_EMAIL || 'admin@onyx.dev', password: process.env.TEST_PASSWORD || 'password123',
  } });
  assert.equal(auth.status(), 200);
  const list = await page.request.get(`${base}/api/wiki/pages`);
  const { pages } = await list.json();
  assert.ok(pages.length, 'Requires an existing wiki page; no stored data is created.');
  const id = pages[0].id;
  const detail = await page.request.get(`${base}/api/wiki/pages/${id}`);
  const { page: original } = await detail.json();
  await page.route('**/api/wiki/**', route => {
    const request = route.request();
    if (['GET', 'HEAD'].includes(request.method())) return route.continue();
    if (request.method() === 'PATCH' && new URL(request.url()).pathname === `/api/wiki/pages/${id}`) {
      return route.fulfill({ json: { page: { ...original, ...request.postDataJSON() } } });
    }
    return route.abort();
  });
  await page.goto(`${base}/wiki/${id}`);
  const editor = page.locator('.ProseMirror[contenteditable=true]');
  const toolbar = page.getByRole('group', { name: 'Formatting', exact: true });
  const dialog = page.getByRole('dialog');
  const input = dialog.getByRole('textbox', { name: 'Link URL', exact: true });
  await editor.fill('');
  await toolbar.getByRole('button', { name: 'Add link', exact: true }).click();
  await expect(dialog).toBeVisible();
  await expect(page.locator('[data-slot="dialog-overlay"]')).toHaveCount(0);
  await expect(dialog).not.toHaveAttribute('aria-modal', 'true');
  const triggerRect = await toolbar.getByRole('button', { name: 'Add link', exact: true }).boundingBox();
  await expect.poll(async () => {
    const rect = await dialog.boundingBox();
    return Math.abs(rect.y - (triggerRect.y + triggerRect.height)) < 16;
  }).toBe(true);
  await expect(input).toBeFocused();
  await input.fill('https://onyx.dev');
  await input.press('Enter');
  await expect(dialog).not.toBeVisible();
  await expect(editor.locator('a')).toHaveText('https://onyx.dev');
  await expect(editor.locator('a')).toHaveAttribute('href', 'https://onyx.dev');
  // Edit an existing link, retaining its text and range.
  await editor.locator('a').click();
  await toolbar.getByRole('button', { name: 'Add link', exact: true }).click();
  await expect(input).toHaveValue('https://onyx.dev');
  await input.fill('javascript:alert(1)');
  await dialog.getByRole('button', { name: 'Save link', exact: true }).click();
  await expect(dialog.getByRole('alert')).toBeVisible();
  await expect(input).toHaveAttribute('aria-invalid', 'true');
  await expect(editor.locator('a')).toHaveAttribute('href', 'https://onyx.dev');
  await input.fill('https://onyx.dev/updated');
  await dialog.getByRole('button', { name: 'Save link', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(editor.locator('a')).toHaveAttribute('href', 'https://onyx.dev/updated');
  await expect(editor.locator('a')).toHaveText('https://onyx.dev');
  // Cancel and Escape do not modify the document, and return focus to the editor.
  for (const action of ['cancel', 'escape']) {
    await toolbar.getByRole('button', { name: 'Add link', exact: true }).click();
    await input.fill('https://discarded.example');
    if (action === 'cancel') await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    else await input.press('Escape');
    await expect(dialog).not.toBeVisible();
    await expect(editor).toBeFocused();
    await expect(editor.locator('a')).toHaveAttribute('href', 'https://onyx.dev/updated');
  }
  // Contextual toolbar: opening the popup must not lose the selected text.
  await editor.fill('Before selected after');
  const remove = toolbar.getByRole('button', { name: 'Remove link', exact: true });
  if (await remove.count()) await remove.click();
  await expect(editor.locator('a')).toHaveCount(0);
  await editor.evaluate(el => {
    const text = el.querySelector('p').firstChild;
    const range = document.createRange();
    range.setStart(text, 7); range.setEnd(text, 15);
    const selection = window.getSelection();
    selection.removeAllRanges(); selection.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
  });
  const contextual = page.getByRole('group', { name: 'Selection formatting', exact: true });
  await expect(contextual).toBeVisible();
  const selectionTrigger = contextual.getByRole('button', { name: 'Add link', exact: true });
  const selectionRect = await selectionTrigger.boundingBox();
  await selectionTrigger.click();
  await expect(dialog).toBeVisible();
  await expect.poll(async () => {
    const rect = await dialog.boundingBox();
    return Math.abs(rect.y - (selectionRect.y + selectionRect.height)) < 16;
  }).toBe(true);
  await expect(page.locator('[data-slot="dialog-overlay"]')).toHaveCount(0);
  await input.fill('https://example.com/selected');
  await input.press('Enter');
  await expect(dialog).not.toBeVisible();
  await expect(editor.locator('a')).toHaveText('selected');
  await expect(editor.locator('p').first()).toHaveText('Before selected after');
  // Remove through the same popup.
  await editor.locator('a').click();
  await toolbar.getByRole('button', { name: 'Add link', exact: true }).click();
  await dialog.getByRole('button', { name: 'Remove link', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(editor.locator('a')).toHaveCount(0);
  await expect(editor.locator('p').first()).toHaveText('Before selected after');
  // Clicking outside dismisses without blocking the document or applying a draft.
  await toolbar.getByRole('button', { name: 'Add link', exact: true }).click();
  await input.fill('https://discarded.example');
  const editorRect = await editor.boundingBox();
  await editor.click({ position: { x: editorRect.width - 20, y: editorRect.height - 20 } });
  await expect(dialog).not.toBeVisible();
  await expect(editor).toBeFocused();
  await expect(editor.locator('a')).toHaveCount(0);
  // Compact screen: popup remains inside the viewport.
  await page.setViewportSize({ width: 320, height: 568 });
  await toolbar.getByRole('button', { name: 'Add link', exact: true }).click();
  await expect(dialog).toBeVisible();
  assert.equal(await dialog.evaluate(el => {
    const r = el.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth;
  }), true);
  await input.press('Escape');
  assert.deepEqual(dialogs, [], 'No native JavaScript dialogs should be opened');
  assert.deepEqual(errors, []);
  console.log(`PASS (${engine.name()}): link popup insertion, edit, validation, cancel/Escape, selection, removal, compact viewport; no stored edits`);
} finally { await browser.close(); }
