// Copied into the pinned source only on a credentialless disposable CI runner.
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "PR 171129 confirmation evidence" });
const head = "50a441dea2b457f17651f7b81f5f066b2ca60d56";
const expectedMessage = "Runs the Gateway updater and restarts it. The current version may be reinstalled.";
const expectedImpact = "Running sessions are interrupted and this Control UI disconnects until the Gateway is back.";

suite.define(() => {
  it.each(["up-to-date", "unknown"] as const)("captures and cancels %s confirmation", async (state) => {
    const artifactDir = createControlUiE2eArtifactDir(`pr171129-${state}`);
    await suite.withPage(
      { colorScheme: "dark", locale: "en-US", serviceWorkers: "block", viewport: { width: 1280, height: 900 } },
      async ({ page }) => {
        const errors: string[] = [];
        const warnings: string[] = [];
        page.on("pageerror", error => errors.push(error.message));
        page.on("console", message => {
          if (message.type() === "error") errors.push(message.text());
          if (message.type() === "warning") warnings.push(message.text());
        });
        const config = { update: { auto: { enabled: false }, channel: "stable" } };
        const schedule = state === "up-to-date"
          ? { channel: "stable", autoEnabled: false, install: { kind: "package" } }
          : null;
        const gateway = await installMockGateway(page, {
          operatorScopes: ["operator.read", "operator.admin"],
          serverVersion: "2026.10.1",
          updateAvailable: null,
          updateSchedule: schedule,
          communityInviteDismissed: true,
          featureMethods: ["config.get", "config.set", "update.run", "update.status"],
          methodResponses: {
            "config.get": { config, hash: `proof-${state}`, issues: [], raw: JSON.stringify(config), runtimeConfig: config, valid: true },
            "update.status": { updateAvailable: null, schedule, sentinel: null },
          },
        });
        expect((await page.goto(`${suite.server.baseUrl}settings/updates`))?.status()).toBe(200);
        await gateway.waitForRequest("config.get");
        await gateway.waitForRequest("update.status");
        expect(new URL(page.url()).pathname).toBe("/settings/updates");
        const title = await page.title();
        expect(title.length).toBeGreaterThan(0);
        const update = page.getByRole("button", { name: "Update Gateway…", exact: true });
        await expect.poll(() => update.isEnabled()).toBe(true);
        const pageText = await page.locator("#config-section-update").innerText();
        expect(pageText).toContain(state === "up-to-date" ? "Up to date" : "Update status unavailable");
        await update.click();
        const dialog = page.getByRole("dialog", { name: "Update Gateway", exact: true });
        await dialog.waitFor();
        const copy = page.locator("openclaw-modal-dialog");
        const message = copy.getByText(`${expectedMessage} ${expectedImpact}`, { exact: true });
        const cancel = page.getByRole("button", { name: "Cancel", exact: true });
        await message.waitFor();
        await cancel.waitFor();
        expect(await copy.textContent()).not.toContain("Installs the available update");
        expect(await gateway.getRequests("update.run")).toHaveLength(0);
        const frame = await takeControlUiScreenshotFrame(page, dialog, [message, cancel], {
          animations: "disabled",
        });
        await writeFile(path.join(artifactDir, "confirmation.png"), frame.png);
        const renderedText = await copy.innerText();
        await cancel.click();
        await dialog.waitFor({ state: "detached" });
        expect(await gateway.getRequests("update.run")).toHaveLength(0);
        expect(await page.locator("vite-error-overlay").count()).toBe(0);
        await writeFile(path.join(artifactDir, "result.json"), JSON.stringify({
          head, state, title, route: "/settings/updates", viewport: page.viewportSize(),
          fixture: "synthetic Gateway, no native app or real updater", renderedText,
          cancelDismissedDialog: true, updateRunRequests: 0, errors, warnings,
        }, null, 2));
        expect(errors).toEqual([]);
      },
    );
  });
});
