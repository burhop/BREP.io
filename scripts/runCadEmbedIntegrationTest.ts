import { chromium } from "playwright";

const baseUrl = String(
  process.env.BREP_TEST_BASE_URL || "http://127.0.0.1:5173",
).replace(/\/+$/, "");
const testUrl = `${baseUrl}/apiExamples/Embeded_CAD_Integration_Test.html`;

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  const browserErrors: string[] = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("dialog", async (dialog) => {
    browserErrors.push(`Unexpected ${dialog.type()} dialog: ${dialog.message()}`);
    await dialog.dismiss();
  });

  await page.goto(testUrl, { waitUntil: "domcontentloaded" });
  await page.locator("#btn-run").click();
  await page.waitForFunction(
    () => {
      const status = document.querySelector("#run-status")?.textContent || "";
      return status.startsWith("Done.") || status.startsWith("Run aborted:");
    },
    null,
    { timeout: 180_000 },
  );

  const status = String(
    await page.locator("#run-status").textContent(),
  ).trim();
  const results = await page.locator(".results-row:not(.header)").allTextContents();
  console.log(status);
  for (const result of results) console.log(result.replace(/\s+/g, " ").trim());

  if (!status.includes("FAIL=0") || browserErrors.length > 0) {
    throw new Error([
      `CadEmbed integration suite failed: ${status}`,
      ...browserErrors,
    ].join("\n"));
  }
} finally {
  await browser.close();
}
