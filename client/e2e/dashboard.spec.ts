import { test, expect } from "@playwright/test";

// E2E smoke for the dashboard SPA against the merged build + mock backend.
// Mock facts: host "mock-large-host", 120 projects, sessions spread over 90d.

test("loads with version badge, server panel and stats", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#app-ver")).toHaveText(/^v\d+\.\d+\.\d+$/);
  const panel = page.locator("section.server");
  await expect(panel).toBeVisible();
  await expect(panel.locator(".srv-host")).toHaveText("mock-large-host");
  await expect(panel.locator(".srv-ver")).toContainText("dashboard v");
  await expect(panel.locator(".stats")).toBeVisible();
  await expect(panel.locator(".tbl .prow").first()).toBeVisible();
});

test("shows a panel-level spinner while the first load is in flight", async ({ page }) => {
  await page.route("**/api/s/0/overview", async (route) => {
    await new Promise((r) => setTimeout(r, 1200));
    await route.continue();
  });
  await page.goto("/");
  const panel = page.locator("section.server");
  await expect(panel.locator(".panel-loading")).toBeVisible();
  await expect(panel.locator(".panel-loading")).toBeHidden();
  await expect(panel.locator(".stats")).toBeVisible();
});

test("shows a panel-level spinner while switching time range", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("section.server .stats")).toBeVisible();
  await page.route("**/api/s/0/projects", async (route) => {
    await new Promise((r) => setTimeout(r, 900));
    await route.continue();
  });
  await page.locator("#range-select").selectOption("7d");
  await expect(page.locator("section.server .panel-loading")).toBeVisible();
  await expect(page.locator("section.server .panel-loading")).toBeHidden();
  await expect(page.locator("section.server .stats")).toBeVisible();
});

test("custom date inputs only appear when Custom is selected", async ({ page }) => {
  await page.goto("/");
  const custom = page.locator("#range-custom");
  const sel = page.locator("#range-select");
  await expect(custom).toBeHidden();
  await sel.selectOption("today");
  await expect(custom).toBeHidden();
  await sel.selectOption("7d");
  await expect(custom).toBeHidden();
  await sel.selectOption("custom");
  await expect(custom).toBeVisible();
  await sel.selectOption("all");
  await expect(custom).toBeHidden();
});

test("expanding a project shows a spinner then its sessions", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".tbl .prow").first()).toBeVisible();
  await page.route("**/api/s/0/projects/*", async (route) => {
    await new Promise((r) => setTimeout(r, 700));
    await route.continue();
  });
  await page.locator(".prow").first().click();
  await expect(page.locator(".pdetail .spinner")).toBeVisible();
  await expect(page.locator(".pdetail .stree")).toBeVisible();
});
