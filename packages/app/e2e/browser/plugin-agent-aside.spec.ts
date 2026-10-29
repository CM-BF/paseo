import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { expect, test, type Page } from "../support/fixtures";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";
import { installAgentAsideFixture } from "../support/helpers/plugin-agent-aside";

const envelope = z.object({
  type: z.literal("session"),
  message: z.object({ type: z.string(), agentId: z.string().optional() }).passthrough(),
});
const inputName = "Message agent...";
function elementHeight(element: Element) {
  return element.getBoundingClientRect().height;
}
function elementScrollTop(element: Element) {
  return element.scrollTop;
}
function sentAgentIds(sent: z.infer<typeof envelope>["message"][]) {
  return sent
    .filter((item) => item.type === "send_agent_message_request")
    .map((item) => item.agentId);
}

function observe(page: Page) {
  const sent: z.infer<typeof envelope>["message"][] = [];
  const errors: string[] = [];
  const consoleMessages: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => consoleMessages.push(`${message.type()}: ${message.text()}`));
  page.on("websocket", (socket) =>
    socket.on("framesent", ({ payload }) => {
      if (typeof payload !== "string") return;
      try {
        const parsed = envelope.safeParse(JSON.parse(payload));
        if (parsed.success) sent.push(parsed.data.message);
      } catch {
        /* Binary transport frames are not JSON messages. */
      }
    }),
  );
  return { sent, errors, consoleMessages };
}

test("native plugin aside isolates real conversations across desktop and compact layouts", async ({
  page,
}, info) => {
  test.setTimeout(240_000);
  const evidence = process.env.CINDY_ASIDE_EVIDENCE_DIR ?? info.outputPath("aside-evidence");
  await mkdir(evidence, { recursive: true });
  const observations = observe(page);
  const parent = await seedMockAgentWorkspace({
    repoPrefix: "paseo-aside-browser-",
    title: "Aside parent",
    initialPrompt: "Parent conversation marker.",
  });
  await parent.client.waitForFinish(parent.agentId, 20_000);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await openAgentRoute(page, parent);
  await expect(page.getByRole("textbox", { name: inputName })).toBeEditable();
  const child = await parent.client.createAgent({
    provider: "mock",
    cwd: parent.cwd,
    workspaceId: parent.workspaceId,
    title: "Aside child",
    modeId: "load-test",
    model: "e2e-fast-stream",
    initialPrompt: "Child conversation marker.",
  });
  const plugin = await installAgentAsideFixture(parent.agentId, child.id);
  const cases: unknown[] = [];
  try {
    await parent.client.waitForFinish(child.id, 20_000);
    const parentInput = page.getByRole("textbox", { name: inputName });
    await expect(parentInput).toBeEditable();
    await parentInput.fill("Parent retained draft");
    expect(
      observations.sent.filter(
        (message) =>
          message.type === "fetch_agent_timeline_request" && message.agentId === child.id,
      ),
    ).toEqual([]);
    await page.getByRole("button", { name: "Open test topic", exact: true }).click();
    const aside = page.getByTestId("plugin-agent-aside");
    const childInput = aside.getByRole("textbox", { name: inputName });
    await expect(childInput).toBeEditable();
    await expect(aside.getByTestId("aside-identities")).toHaveText(
      `${parent.agentId} → ${child.id}`,
    );
    await childInput.fill("Child retained draft");
    await expect(aside.getByTestId("aside-focus")).toHaveText("Child focused");

    await test.step("real inputs target separate drafts and native agent identities", async () => {
      const retainedParent = page.locator('textarea[aria-label="Message agent..."]').first();
      await retainedParent.click();
      await page.keyboard.type(" after parent focus");
      await expect(aside.getByTestId("aside-focus")).toHaveText("Parent focused");
      await expect(retainedParent).toHaveValue("Parent retained draft after parent focus");
      await expect(childInput).toHaveValue("Child retained draft");
      await childInput.fill("Message sent through child native composer");
      await aside.getByRole("button", { name: "Send message", exact: true }).click();
      await expect.poll(() => sentAgentIds(observations.sent)).toEqual([child.id]);
      await parent.client.waitForFinish(child.id, 20_000);
      await expect(retainedParent).toHaveValue("Parent retained draft after parent focus");
      await childInput.fill("Child retained draft");
    });

    await test.step("client lifecycle commands reject without losing the child draft", async () => {
      for (const command of ["/clear", "/exit"]) {
        await childInput.fill(command);
        await aside.getByRole("button", { name: "Send message", exact: true }).click();
        await expect(
          page.getByText(
            `${command} is unavailable in this conversation aside. Your draft is preserved. Close the aside to return to the parent conversation.`,
            { exact: true },
          ),
        ).toBeVisible();
        await expect(childInput).toHaveValue(command);
        expect(
          (await parent.client.fetchAgent({ agentId: child.id }))?.agent.archivedAt ?? null,
        ).toBeNull();
        expect(
          (await parent.client.fetchAgent({ agentId: parent.agentId }))?.agent.archivedAt ?? null,
        ).toBeNull();
      }
      await childInput.fill("Child retained draft");
      expect(
        observations.sent.filter((item) =>
          /archive|cancel_agent|turn\.cancel|create_agent/.test(item.type),
        ),
      ).toEqual([]);
    });

    for (const viewport of [
      { width: 1440, height: 1000 },
      { width: 390, height: 844 },
      { width: 390, height: 667 },
    ]) {
      await test.step(`real layout and same-scroller root at ${viewport.width}×${viewport.height}`, async () => {
        // Changing the host's desktop/compact layout remounts its parent surface.
        // Open a fresh aside in each layout; native drafts must survive the close.
        await aside.getByRole("button", { name: "Close test topic", exact: true }).click();
        await expect(aside).toHaveCount(0);
        await page.setViewportSize(viewport);
        await page.getByRole("button", { name: "Open test topic", exact: true }).click();
        await expect(childInput).toHaveValue("Child retained draft");
        const scroller = aside.getByTestId("agent-chat-scroll");
        const header = scroller.getByTestId("agent-stream-header");
        await expect(header.getByTestId("aside-root-preview")).toHaveCount(1);
        const before = await header.evaluate(elementHeight);
        await aside.getByRole("button", { name: "Expand root background", exact: true }).click();
        await expect.poll(() => header.evaluate(elementHeight)).toBeGreaterThan(before + 1000);
        await expect(childInput).toHaveValue("Child retained draft");
        await scroller.hover();
        await page.mouse.wheel(0, -100_000);
        await expect.poll(() => scroller.evaluate(elementScrollTop)).toBe(0);
        const geometry = await aside.evaluate((element) => {
          const rect = element.getBoundingClientRect();
          const host = element.parentElement?.getBoundingClientRect();
          return {
            x: rect.x,
            right: rect.right,
            width: rect.width,
            height: rect.height,
            hostX: host?.x,
            hostWidth: host?.width,
            hostRight: host?.right,
            documentWidth: document.documentElement.scrollWidth,
            viewportWidth: innerWidth,
          };
        });
        expect(geometry.documentWidth).toBeLessThanOrEqual(viewport.width);
        expect(geometry.right).toBeCloseTo(geometry.hostRight ?? 0, 0);
        expect(geometry.width).toBeCloseTo(
          viewport.width > 800
            ? Math.min((geometry.hostWidth ?? 0) / 2, 448)
            : (geometry.hostWidth ?? 0),
          0,
        );
        await page.screenshot({
          path: path.join(evidence, `aside-${viewport.width}x${viewport.height}-root.png`),
        });
        await page.mouse.wheel(0, 100_000);
        await expect.poll(() => scroller.evaluate(elementScrollTop)).toBeGreaterThan(1000);
        await expect(header).not.toBeInViewport();
        await expect(childInput).toBeVisible();
        await page.screenshot({
          path: path.join(evidence, `aside-${viewport.width}x${viewport.height}-conversation.png`),
        });
        await aside
          .getByRole("button", {
            name: "Collapse root background",
            exact: true,
          })
          .click();
        await expect.poll(() => header.evaluate(elementHeight)).toBeLessThan(500);
        cases.push({
          viewport,
          geometry,
          sameScroller: true,
          dynamicHeader: true,
          draftPreserved: true,
        });
      });
    }

    await test.step("closing and reopening preserves drafts and does not stop or archive a running child", async () => {
      await parent.client.sendAgentMessage(
        child.id,
        "Withhold synthetic user message until interrupted.",
      );
      await parent.client.waitForAgentUpsert(
        child.id,
        (snapshot) => snapshot.status === "running",
        15_000,
      );
      await aside.getByRole("button", { name: "Close test topic", exact: true }).click();
      await expect(aside).toHaveCount(0);
      await expect(page.getByRole("textbox", { name: inputName })).toHaveValue(
        "Parent retained draft after parent focus",
      );
      const agents = await parent.client.fetchAgents();
      expect(agents.entries.find((entry) => entry.agent.id === child.id)?.agent.status).toBe(
        "running",
      );
      expect(
        (await parent.client.fetchAgent({ agentId: child.id }))?.agent.archivedAt ?? null,
      ).toBeNull();
      await page.getByRole("button", { name: "Open test topic", exact: true }).click();
      await expect(childInput).toHaveValue("Child retained draft");
      expect(
        observations.sent.filter((item) =>
          /archive|cancel_agent|turn\.cancel|create_agent/.test(item.type),
        ),
      ).toEqual([]);
      await parent.client.cancelAgent(child.id);
      await parent.client.waitForFinish(child.id, 15_000);
    });
    expect(observations.errors).toEqual([]);
    await writeFile(
      path.join(evidence, "result.json"),
      JSON.stringify(
        {
          passed: true,
          kind: "real-app-isolated-daemon-mock-provider",
          noProductionConnection: true,
          productCssOrJsInjection: false,
          cases,
          observations,
        },
        null,
        2,
      ),
    );
  } catch (error) {
    await page.screenshot({
      path: path.join(evidence, "failure-before-cleanup.png"),
    });
    await writeFile(path.join(evidence, "failure-before-cleanup.html"), await page.content());
    throw error;
  } finally {
    await writeFile(path.join(evidence, "browser-log.json"), JSON.stringify(observations, null, 2));
    await plugin.cleanup();
    await parent.cleanup();
  }
});
