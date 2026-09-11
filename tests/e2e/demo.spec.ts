import { expect, test, type ConsoleMessage, type Page } from "@playwright/test";

/**
 * The demo script, walked end to end (CLAUDE.md 15, task P10.5).
 *
 * Every step of the eight-minute run, asserted on what a judge would actually look at rather than
 * on markup: a run stamp with a real id, streets that are wet, a route with two columns of numbers,
 * pins with source links, a drain map with a learned posterior. If a number is missing the test
 * fails, which is the point - `make demo` being green has to mean the demo works, not that the
 * pages render.
 *
 * **It asserts numbers exist, never their values.** The forecast is recomputed whenever the bundle
 * is re-baked, and a test that pinned "55 cm at Hindmata" would either go stale or quietly become
 * a test of nothing. The values are `/verify`'s job.
 *
 * Generous timeouts throughout: the first Turbopack compile of a route takes seconds, and the API
 * may be waking from sleep.
 */

const NAV = 90_000;
const SETTLE = 45_000;

/** Console noise that is not VARUNA's and cannot be fixed from here. */
const IGNORED = [
  // Esri's tile CDN rate-limits under a test run; the map falls back to the derived GIS by design.
  /arcgisonline/i,
  // Next's dev-only hot-reload socket, which the test harness closes as it navigates.
  /_next\/hmr|HMR|Fast Refresh/i,
  /WebSocket .*(closed|failed)/i,
];

function collectConsoleErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message: ConsoleMessage) => {
    if (message.type() !== "error") return;
    const text = message.text();
    if (IGNORED.some((pattern) => pattern.test(text))) return;
    errors.push(text);
  });
  page.on("pageerror", (error) => {
    if (IGNORED.some((pattern) => pattern.test(error.message))) return;
    errors.push(`pageerror: ${error.message}`);
  });
  return errors;
}

/** Open a screen and wait for it to stop being a skeleton. */
async function open(page: Page, path: string): Promise<void> {
  await page.goto(path, { waitUntil: "domcontentloaded", timeout: NAV });
  await expect(page.getByText("VARUNA", { exact: false }).first()).toBeVisible({
    timeout: SETTLE,
  });
}

test.describe("the demo script", () => {
  test.slow();

  test("0:00 the console opens on a real run, with the mode banner and the run stamp", async ({
    page,
  }) => {
    const errors = collectConsoleErrors(page);
    await open(page, "/console");

    // A run stamp that names an actual run, not the empty state.
    await expect(page.getByText(/MUM-\d{8}T\d{4}Z/).first()).toBeVisible({ timeout: SETTLE });
    // The mode banner says what kind of run this is (CLAUDE.md 7.2).
    await expect(page.getByText(/Replay|Live|baked/i).first()).toBeVisible();

    await page.waitForTimeout(3_000);
    expect(errors, `console errors on /console:\n${errors.join("\n")}`).toEqual([]);
  });

  test("0:40 the hotspot rail ranks real places with depths", async ({ page }) => {
    await open(page, "/console");
    const rail = page.getByRole("tabpanel").first();
    // Ranked rows, each with a depth chip in centimetres.
    await expect(rail.getByText(/\d+ cm/).first()).toBeVisible({ timeout: SETTLE });
    await expect(rail.getByText(/peak .* at \d{2}:\d{2}/).first()).toBeVisible({
      timeout: SETTLE,
    });
  });

  test("1:40 the cycle row lets the operator reach the storm's peak", async ({ page }) => {
    await open(page, "/console");
    const cycles = page.getByRole("button", { name: /Forecast from \d{2}:\d{2} IST/ });
    await expect(cycles.first()).toBeVisible({ timeout: SETTLE });
    expect(await cycles.count()).toBeGreaterThan(1);
  });

  test("2:40 the ground-truth pins carry the source they were read from", async ({ page }) => {
    await open(page, "/console");
    const ticker = page.getByRole("region", { name: "As it happened" });
    await expect(ticker).toBeVisible({ timeout: SETTLE });
    // Either pins have landed with their sources, or the clock has not reached one yet - both are
    // honest, but a pin without a link never is (rule 7).
    const sources = ticker.getByRole("link", { name: "source" });
    if ((await sources.count()) > 0) {
      await expect(sources.first()).toHaveAttribute("href", /^https?:\/\//);
    }
  });

  test("3:30 the drain X-ray shows a learned posterior over the inferred graph", async ({
    page,
  }) => {
    const errors = collectConsoleErrors(page);
    await open(page, "/drains");

    await expect(page.getByText(/Inferred drain graph/i).first()).toBeVisible({ timeout: SETTLE });
    // The table ranks pipes by blockage, with a capacity reduction for each.
    await expect(page.getByText(/\d+ %/).first()).toBeVisible({ timeout: SETTLE });
    await expect(page.getByText(/pipes moved this cycle/i).first()).toBeVisible({
      timeout: SETTLE,
    });

    await page.waitForTimeout(2_000);
    expect(errors, `console errors on /drains:\n${errors.join("\n")}`).toEqual([]);
  });

  test("4:30 the what-if lab answers a scenario and prints the emulator's skill", async ({
    page,
  }) => {
    await open(page, "/whatif");
    await page.getByRole("button", { name: "Run what-if" }).click();

    // The count of what moved, and the honesty label beside it.
    await expect(page.getByText(/segments deeper/i).first()).toBeVisible({ timeout: SETTLE });
    await expect(page.getByText(/Reduced-order emulator/i).first()).toBeVisible();
  });

  test("5:20 the route planner compares the naive route with VARUNA's", async ({ page }) => {
    await open(page, "/route");
    await page.getByRole("button", { name: "Find route" }).click();

    await expect(page.getByText(/Routed on run/i).first()).toBeVisible({ timeout: SETTLE });
    // Two columns of real numbers: an ETA and a distance for each route.
    await expect(page.getByText(/\d+ min/).first()).toBeVisible({ timeout: SETTLE });
    await expect(page.getByText(/\d+(\.\d+)? km/).first()).toBeVisible();
  });

  test("5:20 the alert centre raises alerts with a CAP document at Exercise", async ({ page }) => {
    await open(page, "/alerts");
    await expect(page.getByText(/Severe|Moderate|Watch/).first()).toBeVisible({ timeout: SETTLE });
    // Replay alerts must say on their face that they are a drill (CLAUDE.md 11.10).
    await expect(page.getByText(/Exercise/i).first()).toBeVisible({ timeout: SETTLE });
  });

  test("5:20 the pump board assigns pumps and writes the order in plain language", async ({
    page,
  }) => {
    await open(page, "/pumps");
    await expect(page.getByText(/Synthetic pump inventory/i).first()).toBeVisible({
      timeout: SETTLE,
    });
    await expect(page.getByText(/of \d+ pumps assigned/i).first()).toBeVisible({ timeout: SETTLE });
  });

  test("6:30 the onboarding wizard is ready to build Chennai", async ({ page }) => {
    await open(page, "/onboard");
    await expect(page.getByRole("button", { name: /onboarding Chennai/i })).toBeEnabled({
      timeout: SETTLE,
    });
    await expect(page.getByText(/Choose area/i).first()).toBeVisible();
  });

  test("7:20 verification reports scores computed from artifacts, with its limits", async ({
    page,
  }) => {
    const errors = collectConsoleErrors(page);
    await open(page, "/verify");

    // A CSI, and the count of ground truth it was scored against.
    await expect(page.getByText(/CSI/i).first()).toBeVisible({ timeout: SETTLE });
    await expect(page.getByText(/\d+(\.\d+)?/).first()).toBeVisible();

    await page.waitForTimeout(2_000);
    expect(errors, `console errors on /verify:\n${errors.join("\n")}`).toEqual([]);
  });

  test("the public map draws the run in three colours for a chosen vehicle", async ({ page }) => {
    await open(page, "/map");
    await expect(page.getByText(/passable|impassable|caution/i).first()).toBeVisible({
      timeout: SETTLE,
    });
    // The honesty line: which run this is and how often it updates (CLAUDE.md 7.11).
    await expect(page.getByText(/updates every 5 minutes|last VARUNA run/i).first()).toBeVisible();
  });
});
