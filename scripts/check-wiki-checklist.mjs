// Browser regression: wiki mutations are intercepted; no stored document is edited.
// APP_URL=http://127.0.0.1:3020 BROWSER=webkit node scripts/check-wiki-checklist.mjs
import assert from 'node:assert/strict';
import { chromium, webkit, expect } from '@playwright/test';

const base = process.env.APP_URL || 'http://127.0.0.1:3020';
const engine = process.env.BROWSER === 'webkit' ? webkit : chromium;
const browser = await engine.launch({ args: engine === chromium ? ['--no-sandbox'] : [] });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const auth = await page.request.post(`${base}/api/auth/login`, { data: {
    email: process.env.TEST_EMAIL || 'admin@onyx.dev',
    password: process.env.TEST_PASSWORD || 'password123',
  } });
  assert.equal(auth.status(), 200, 'Test account must be able to sign in');
  const response = await page.request.get(`${base}/api/wiki/pages`);
  assert.equal(response.status(), 200);
  const { pages } = await response.json();
  assert.ok(pages.length, 'Requires an existing wiki page; no stored data is created.');
  const id = pages[0].id;
  const detail = await page.request.get(`${base}/api/wiki/pages/${id}`);
  assert.equal(detail.status(), 200);
  const { page: original } = await detail.json();
  const writes = [];
  // Fail closed for all wiki mutations, including unexpected endpoints.
  await page.route('**/api/wiki/**', async route => {
    const request = route.request();
    if (['GET', 'HEAD'].includes(request.method())) return route.continue();
    if (request.method() === 'PATCH' && new URL(request.url()).pathname === `/api/wiki/pages/${id}`) {
      const draft = request.postDataJSON();
      writes.push(draft);
      return route.fulfill({ json: { page: { ...original, ...draft } } });
    }
    return route.abort();
  });
  await page.goto(`${base}/wiki/${id}`);
  const editor = page.locator('.ProseMirror[contenteditable=true]');
  await editor.waitFor();
  const boxes = editor.locator('input[type=checkbox]');
  if (await boxes.count()) {
    const checked = await boxes.first().isChecked();
    await boxes.first().click();
    await expect(boxes.first()).toBeChecked({ checked: !checked });
  }
  await editor.fill('');
  await page.getByRole('group', { name: 'Formatting', exact: true })
    .getByRole('button', { name: 'To-do list', exact: true }).click();
  await page.keyboard.type('Item 1');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Item 2');
  console.log('created list DOM', await editor.innerHTML());
  await expect(boxes).toHaveCount(2);
  const savedChecked = index => writes.at(-1)?.content?.content?.[0]?.content?.[index]?.attrs?.checked;
  await boxes.first().click();
  await expect(boxes.first()).toBeChecked();
  await expect(editor.locator('li[data-checked]').first()).toHaveAttribute('data-checked', 'true');
  await expect.poll(() => savedChecked(0)).toBe(true);
  await boxes.first().click();
  await expect(boxes.first()).not.toBeChecked();
  await expect.poll(() => savedChecked(0)).toBe(false);
  await boxes.nth(1).click();
  await expect(boxes.nth(1)).toBeChecked();
  await expect(boxes.first()).not.toBeChecked();
  await expect.poll(() => savedChecked(1)).toBe(true);
  // Reproduce the permission-dependent path without changing any stored role.
  const meResponse = await page.request.get(`${base}/api/auth/me`);
  const me = await meResponse.json();
  let allowEdit = false;
  await page.route('**/api/auth/me', route => route.fulfill({ json: {
    ...me, user: { ...me.user, permissions: allowEdit ? me.user.permissions : me.user.permissions.filter(key => key !== 'wiki.update') },
  } }));
  await page.reload();
  await expect(page.locator('.wiki-document-workspace')).toHaveAttribute('data-mode', 'view');
  const readonlyBoxes = page.locator('.ProseMirror input[type=checkbox]');
  if (await readonlyBoxes.count()) {
    const checked = await readonlyBoxes.first().isChecked();
    const previousWrites = writes.length;
    await readonlyBoxes.first().click();
    await expect(readonlyBoxes.first()).toBeChecked({ checked });
    assert.equal(writes.length, previousWrites, 'Read-only click must not save');
    console.log('Confirmed: without wiki.update, a checkbox click is reverted');
  }
  // A focus refresh may change permissions without remounting the page.
  allowEdit = true;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.locator('.wiki-document-workspace')).toHaveAttribute('data-mode', 'edit');
  if (await boxes.count()) {
    const checked = await boxes.first().isChecked();
    console.log('after mode flip', await boxes.first().evaluate(el => el.closest('li').outerHTML));
    await boxes.first().click();
    await expect(boxes.first()).toBeChecked({ checked: !checked });
    await expect.poll(() => savedChecked(0)).toBe(!checked);
  }
  assert.deepEqual(errors, []);
  console.log(`PASS (${engine.name()}): stored/new tasks check/uncheck independently and autosave; no stored edits`);
} finally {
  await browser.close();
}
