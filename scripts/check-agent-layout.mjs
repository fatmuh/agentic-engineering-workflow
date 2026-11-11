// Regression check for Board overflow and clipped Worktree descendants.
// Run against a local service: APP_URL=http://127.0.0.1:3020 node scripts/check-agent-layout.mjs
import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const base = process.env.APP_URL || "http://127.0.0.1:3020";
const output = process.env.SCREENSHOT_DIR || path.join(os.tmpdir(), "agent-layout-check");

async function settle(page) {
  await page.locator('section[aria-label="Agent Board"]').evaluate(async section => {
    await Promise.all(section.getAnimations({ subtree: true })
      .filter(animation => animation.effect?.getTiming().iterations !== Infinity)
      .map(animation => animation.finished.catch(() => {})));
  });
}

async function checkGeometry(page, selector) {
  const violations = await page.locator(selector).evaluateAll(cards => {
    const failures = [];
    const visible = cards.filter(card => !card.closest("[inert]") && card.getClientRects().length);
    for (const card of visible) {
      const box = card.getBoundingClientRect();
      const id = card.dataset.agentTask || card.dataset.worktreeCard;
      for (let ancestor = card.parentElement; ancestor; ancestor = ancestor.parentElement) {
        const style = getComputedStyle(ancestor);
        const rect = ancestor.getBoundingClientRect();
        if (/hidden|clip|auto|scroll/.test(style.overflowX) && (box.left < rect.left - 1 || box.right > rect.right + 1)) {
          failures.push(`${id}: clipped horizontally by ${ancestor.className}`);
        }
      }
      const walker = document.createTreeWalker(card, NodeFilter.SHOW_TEXT);
      for (let text = walker.nextNode(); text; text = walker.nextNode()) {
        if (!text.textContent.trim() || text.parentElement.closest('[inert], [aria-hidden="true"]')) continue;
        const range = document.createRange();
        range.selectNodeContents(text);
        for (const rect of range.getClientRects()) {
          if (rect.width && (rect.left < box.left - 1 || rect.right > box.right + 1)) failures.push(`${id}: text escapes card: ${text.textContent}`);
        }
      }
    }
    for (let i = 0; i < visible.length; i++) {
      for (let j = i + 1; j < visible.length; j++) {
        const a = visible[i].getBoundingClientRect();
        const b = visible[j].getBoundingClientRect();
        if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1) failures.push(`Cards ${i} and ${j} overlap`);
      }
    }
    if (document.documentElement.scrollWidth > innerWidth) failures.push("Page overflows horizontally");
    return failures;
  });
  assert.deepEqual(violations, []);
}

(async () => {
  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  const passed = [];
  const pageErrors = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    page.on("pageerror", error => pageErrors.push(error.message));
    await page.goto(`${base}/agent-board`);
    if (new URL(page.url()).pathname === "/login") {
      await page.locator("#email").fill(process.env.TEST_EMAIL || "admin@onyx.dev");
      await page.locator("#password").fill(process.env.TEST_PASSWORD || "password123");
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      await page.waitForURL(url => url.pathname === "/" || url.pathname === "/agent-board");
      if (new URL(page.url()).pathname !== "/agent-board") {
        await page.goto(`${base}/agent-board`);
      }
    }
    const boardTab = page.getByRole("tab", { name: "Board", exact: true });
    const treeTab = page.getByRole("tab", { name: "Worktree", exact: true });
    await boardTab.waitFor();
    mkdirSync(output, { recursive: true });
    for (const theme of ["light", "dark"]) {
      await page.evaluate(theme => { localStorage.setItem("theme", theme); }, theme);
      await page.reload();
      for (const width of [1600, 1280, 1024, 800, 700, 390, 320]) {
        await page.setViewportSize({ width, height: 1000 });
        await boardTab.click();
        // Match the long Indonesian titles/descriptions in the reported screenshots,
        // including an unbroken identifier that must not force a grid's min-content width.
        await page.locator('[data-agent-task] > button').evaluateAll(buttons => {
          for (const button of buttons) {
            button.children[0].lastElementChild.textContent = "Implementasi Autentikasi OAuth 2.0 PKCE & Whitelist " + "LongIdentifier".repeat(6);
            button.children[1].textContent = "Membuat handler otorisasi loopback dan endpoint validasi user untuk CLI BMad Monitor. ".repeat(2);
          }
        });
        await settle(page);
        await checkGeometry(page, "[data-agent-task]");
        if (width === 1600 || width === 320) await page.screenshot({ path: path.join(output, `board-${theme}-${width}.png`) });
        await treeTab.click();
        for (const scenario of ["bmad", "pricing"]) {
          await page.getByRole("button", { name: "Demo scenario", exact: true }).click();
          const scenarioOption = page.getByRole("radio", { name: scenario === "bmad" ? "BMad sprint · 2 branches" : "Pricing page · 3 branches", exact: true });
          await scenarioOption.click();
          assert.equal(await scenarioOption.getAttribute("aria-checked"), "true");
          assert.equal(await page.getByRole("radio", { checked: true }).count(), 1);
          await page.keyboard.press("Escape");
          await settle(page);
          await checkGeometry(page, "[data-worktree-card]");
          if (await page.locator('.worktree-canvas').evaluate(canvas => canvas.clientWidth - 40 >= 700)) {
            const widths = await page.locator('[data-worktree-card]').evaluateAll(cards => cards.map(card => card.getBoundingClientRect().width));
            assert.ok(widths.every(value => value <= 249), `${scenario}: cards must stay compact, got ${widths}`);
            const junction = await page.locator('.worktree-root > .worktree-children').evaluate(panel => {
              const stem = getComputedStyle(panel, '::before');
              const child = panel.querySelector('.worktree-columns > .worktree-node');
              const branch = getComputedStyle(child, '::before');
              return {
                stemBottom: panel.getBoundingClientRect().top + parseFloat(stem.top) + parseFloat(stem.height),
                branchTop: child.getBoundingClientRect().top + parseFloat(branch.top),
              };
            });
            assert.ok(Math.abs(junction.stemBottom - junction.branchTop) < 1, `${scenario}: root connector must stop at branch junction: ${JSON.stringify(junction)}`);
          }
          if (width === 1600 || width === 320) await page.screenshot({ path: path.join(output, `${scenario}-${theme}-${width}.png`) });
        }
        await page.locator('[data-worktree-card="run-orchestrator"]').waitFor();
        await page.locator('.worktree-name').evaluateAll(names => names.forEach(name => { name.textContent = "BMad Master Orchestrator " + "LongAgentIdentifier".repeat(3); }));
        await settle(page);
        await checkGeometry(page, "[data-worktree-card]");
        const contrastFailures = await page.locator('.worktree-status, .worktree-model, .worktree-task, .worktree-fold').evaluateAll(elements => {
          const luminance = color => {
            const [r, g, b] = color.match(/[\d.]+/g).slice(0, 3).map(Number).map(v => {
              v /= 255;
              return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
            });
            return 0.2126 * r + 0.7152 * g + 0.0722 * b;
          };
          return elements.flatMap(el => {
            const fg = luminance(getComputedStyle(el).color);
            let surface = el;
            while (getComputedStyle(surface).backgroundColor === 'rgba(0, 0, 0, 0)') surface = surface.parentElement;
            const bg = luminance(getComputedStyle(surface).backgroundColor);
            const ratio = (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
            return ratio < 4.5 ? [{ text: el.textContent, ratio }] : [];
          });
        });
        assert.deepEqual(contrastFailures, []);
        if (width === 1600 || width === 320) await page.screenshot({ path: path.join(output, `worktree-${theme}-${width}.png`) });
        passed.push(`${theme}: Board + Worktree at ${width}px, long text, no overlap/clipping`);
      }
    }
    for (const direction of ["ltr", "rtl"]) {
      await page.evaluate(dir => { document.documentElement.dir = dir; document.documentElement.style.fontSize = "200%"; }, direction);
      await page.setViewportSize({ width: 800, height: 1000 });
      await boardTab.click(); await settle(page); await checkGeometry(page, "[data-agent-task]");
      await treeTab.click(); await settle(page); await checkGeometry(page, "[data-worktree-card]");
      passed.push(`${direction}: 200% text resize at 800px`);
    }
    await page.evaluate(() => { document.documentElement.dir = "ltr"; document.documentElement.style.fontSize = ""; });
    // Container queries must follow the host, including a flex column that does
    // not stretch its children. Inline-size containment otherwise collapses it.
    await page.setViewportSize({ width: 1600, height: 1000 });
    for (const width of [900, 600, 320, 240]) {
      await page.locator('.worktree-canvas').evaluate((canvas, width) => {
        canvas.parentElement.style.cssText = `display: flex; flex-direction: column; align-items: flex-start; width: ${width}px; max-width: 100%`;
      }, width);
      await settle(page);
      const sizes = await page.locator('.worktree-canvas').evaluate(canvas => ({
        canvas: canvas.getBoundingClientRect().width,
        host: canvas.parentElement.getBoundingClientRect().width,
        overflows: canvas.scrollWidth > canvas.clientWidth,
      }));
      assert.ok(Math.abs(sizes.canvas - sizes.host) < 1, `Worktree must fill its ${width}px host: ${JSON.stringify(sizes)}`);
      assert.equal(sizes.overflows, false);
      await checkGeometry(page, '[data-worktree-card]');
      if (width === 600) await page.screenshot({ path: path.join(output, 'worktree-container-600.png') });
      passed.push(`Worktree fills ${width}px non-stretching flex container without clipping`);
    }
    await page.locator('.worktree-canvas').evaluate(canvas => canvas.parentElement.removeAttribute('style'));
    const root = page.getByRole("treeitem", { level: 1 });
    await page.keyboard.press("Tab");
    await root.focus();
    assert.notEqual(await page.locator('.worktree-root > .worktree-card').evaluate(card => getComputedStyle(card).outlineStyle), "none");
    await page.keyboard.press("Enter"); await settle(page);
    assert.equal(await root.getAttribute("aria-expanded"), "false");
    assert.equal(await page.locator('#worktree-fold-run-orchestrator > div').getAttribute("inert"), "");
    await page.keyboard.press("ArrowRight"); await settle(page);
    await page.keyboard.press("ArrowDown");
    assert.equal(await page.evaluate(() => document.activeElement.dataset.treeNode), "run-researcher");
    await page.emulateMedia({ reducedMotion: "reduce" });
    assert.equal(await page.locator('.worktree-children').first().evaluate(el => getComputedStyle(el).transitionDuration), "0s");
    passed.push("Keyboard expand/collapse, arrow navigation, focus outline, inert descendants and reduced motion");
    passed.push("Worktree rendered status, model, task and disclosure text contrast >= 4.5:1 in both themes");
    await boardTab.click();
    const approveBtn = page.getByRole("button", { name: "Approve", exact: true }).first();
    if (await approveBtn.isVisible()) {
      await approveBtn.click();
    }
    const failed = page.locator('[data-agent-task="agent-crm"]');
    if (await failed.count() > 0) {
      await failed.locator('> button').click();
      const retryBtn = failed.getByRole("button", { name: "Retry", exact: true });
      if (await retryBtn.isVisible()) {
        await retryBtn.click();
      }
    }
    await settle(page);
    assert.equal(await page.locator('[data-agent-column="needs-you"] [data-agent-task]').count(), 0);
    await page.getByText("No tasks here", { exact: true }).waitFor();
    await checkGeometry(page, "[data-agent-task]");
    passed.push("Approve/Retry move cards, empty lane remains usable");
    assert.deepEqual(pageErrors, []);
    console.log(JSON.stringify({ passed, pageErrors, screenshots: output }, null, 2));
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
