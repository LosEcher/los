import assert from "node:assert/strict";
import test from "node:test";

import Fastify from "fastify";
import { getConfig, loadConfig, setConfig } from "@los/infra/config";

import { registerRequestContext } from "./request-context.js";
import { registerScheduledWorkRoutes, type ScheduledWorkRouteDeps } from "./routes/orchestration/scheduled-work-routes.js";

async function withAuthConfig<T>(
  run: (config: ReturnType<typeof getConfig>) => Promise<T>,
  tokens: { token: string; operatorToken: string } = { token: "access-token", operatorToken: "operator-token" },
): Promise<T> {
  await loadConfig();
  const original = getConfig();
  const config = {
    ...original,
    auth: { enabled: true, token: tokens.token, operatorToken: tokens.operatorToken },
  };
  setConfig(config);
  try {
    return await run(config);
  } finally {
    setConfig(original);
  }
}

test("scheduled work routes preview, enforce operator writes, and expose history", async () => {
  await withAuthConfig(async config => {
    const app = Fastify({ logger: false });
    registerRequestContext(app, config);
    const schedule = fixtureSchedule();
    let triggerCount = 0;
    let createdInput: Parameters<ScheduledWorkRouteDeps["create"]>[0] | undefined;
    const deps: ScheduledWorkRouteDeps = {
      preview: () => ["2026-07-20T00:00:00.000Z", "2026-07-21T00:00:00.000Z"],
      create: async input => { createdInput = input; return schedule; },
      list: async () => [schedule],
      load: async id => id === schedule.id ? schedule : null,
      update: async (id, input) => id === schedule.id ? { ...schedule, status: input.status ?? schedule.status } : null,
      listRuns: async () => [{
        id: "schedule-run-1", scheduleId: schedule.id, scheduledFor: "2026-07-20T00:00:00.000Z",
        triggerKind: "manual", status: "succeeded", attemptCount: 1, maxAttempts: 2,
        createdAt: "2026-07-19T00:00:00.000Z", updatedAt: "2026-07-19T00:00:00.000Z",
      }],
      trigger: async () => {
        triggerCount += 1;
        return {
          id: "schedule-run-2", scheduleId: schedule.id, scheduledFor: "2026-07-20T01:00:00.000Z",
          triggerKind: "manual", status: "succeeded", attemptCount: 1, maxAttempts: 2,
          createdAt: "2026-07-19T00:00:00.000Z", updatedAt: "2026-07-19T00:00:00.000Z",
        };
      },
      retry: async () => { throw new Error("not used"); },
      approve: async () => ({
        id: "schedule-run-2", scheduleId: schedule.id, scheduledFor: "2026-07-20T01:00:00.000Z",
        triggerKind: "manual", status: "succeeded", attemptCount: 1, maxAttempts: 2,
        createdAt: "2026-07-19T00:00:00.000Z", updatedAt: "2026-07-19T00:00:00.000Z",
      }),
      deny: async () => ({
        id: "schedule-run-2", scheduleId: schedule.id, scheduledFor: "2026-07-20T01:00:00.000Z",
        triggerKind: "manual", status: "cancelled", attemptCount: 1, maxAttempts: 2,
        createdAt: "2026-07-19T00:00:00.000Z", updatedAt: "2026-07-19T00:00:00.000Z",
      }),
      execute: async () => "succeeded",
    };
    registerScheduledWorkRoutes(app, deps);
    try {
      const preview = await app.inject({
        method: "GET",
        url: "/scheduled-work-items/preview?kind=cron&expression=0%208%20*%20*%20*&timezone=Asia%2FShanghai",
        headers: { "x-los-auth-token": "access-token" },
      });
      assert.equal(preview.statusCode, 200);
      assert.equal(preview.json().occurrences.length, 2);

      const denied = await app.inject({
        method: "POST", url: "/scheduled-work-items",
        headers: { "x-los-auth-token": "access-token" }, payload: {},
      });
      assert.equal(denied.statusCode, 403);

      const created = await app.inject({
        method: "POST", url: "/scheduled-work-items",
        headers: { "x-los-operator-token": "operator-token" },
        payload: { title: "Morning digest", trigger: schedule.trigger, templateId: "morning_inbox_digest" },
      });
      assert.equal(created.statusCode, 201);
      assert.equal(created.json().schedule.id, schedule.id);
      assert.equal(createdInput?.runTemplate.templateId, "morning_inbox_digest");

      const feedCreated = await app.inject({
        method: "POST", url: "/scheduled-work-items",
        headers: { "x-los-operator-token": "operator-token" },
        payload: {
          title: "Scheduled feed analysis", trigger: schedule.trigger,
          templateId: "scheduled_feed_analysis", approvalPolicy: "preapproved_scope",
          feedAnalysisRequest: {
            sourceSystem: "lot2extension", deliveryMode: "result_returning",
            materialBundle: {
              schemaVersion: "material-bundle-v1", bundleId: "scheduled-bundle",
              sourceSystem: "lot2extension", items: [{ itemId: "source-1", platform: "x" }],
            },
          },
        },
      });
      assert.equal(feedCreated.statusCode, 201);
      assert.equal(createdInput?.runTemplate.templateId, "scheduled_feed_analysis");
      assert.equal(createdInput?.runTemplate.feedAnalysisRequest?.sourceSystem, "lot2extension");

      const detail = await app.inject({
        method: "GET", url: `/scheduled-work-items/${schedule.id}`,
        headers: { "x-los-auth-token": "access-token" },
      });
      assert.equal(detail.statusCode, 200);
      assert.equal(detail.json().runs.length, 1);

      const triggered = await app.inject({
        method: "POST", url: `/scheduled-work-items/${schedule.id}/trigger`,
        headers: { "x-los-operator-token": "operator-token" }, payload: {},
      });
      assert.equal(triggered.statusCode, 200);
      assert.equal(triggerCount, 1);
    } finally {
      await app.close();
    }
  });
});

test("GET /scheduled-work-items forwards excludeRetired when no status is set", async () => {
  await withAuthConfig(async config => {
    const app = Fastify({ logger: false });
    registerRequestContext(app, config);
    const enabled = fixtureSchedule();
    const retired = { ...fixtureSchedule(), id: "schedule-retired", status: "retired" as const, title: "Old probe" };
    const listCalls: Array<Record<string, unknown>> = [];
    const deps: ScheduledWorkRouteDeps = {
      preview: () => [],
      create: async () => enabled,
      list: async (input = {}) => {
        listCalls.push(input as Record<string, unknown>);
        const items = [enabled, retired];
        if (input?.status) return items.filter(item => item.status === input.status);
        if (input?.excludeRetired) return items.filter(item => item.status !== "retired");
        return items;
      },
      load: async () => null,
      update: async () => null,
      listRuns: async () => [],
      trigger: async () => { throw new Error("unexpected"); },
      retry: async () => { throw new Error("unexpected"); },
      approve: async () => { throw new Error("unexpected"); },
      deny: async () => { throw new Error("unexpected"); },
      execute: async () => "succeeded",
    };
    registerScheduledWorkRoutes(app, deps);
    try {
      const active = await app.inject({
        method: "GET",
        url: "/scheduled-work-items?excludeRetired=true&limit=100",
        headers: { "x-los-auth-token": "access-token" },
      });
      assert.equal(active.statusCode, 200);
      assert.deepEqual(active.json().results.map((item: { id: string }) => item.id), [enabled.id]);
      assert.equal(listCalls[0]?.excludeRetired, true);
      assert.equal(listCalls[0]?.status, undefined);

      const retiredOnly = await app.inject({
        method: "GET",
        url: "/scheduled-work-items?status=retired&excludeRetired=true&limit=100",
        headers: { "x-los-auth-token": "access-token" },
      });
      assert.equal(retiredOnly.statusCode, 200);
      assert.deepEqual(retiredOnly.json().results.map((item: { id: string }) => item.id), [retired.id]);
      assert.equal(listCalls[1]?.status, "retired");
      assert.equal(listCalls[1]?.excludeRetired, undefined);
    } finally {
      await app.close();
    }
  });
});

test("scheduled work routes reject invalid templateId and nested runTemplate (fail fast)", async () => {
  await withAuthConfig(async config => {
    const schedule = fixtureSchedule();
    const deps: ScheduledWorkRouteDeps = {
      preview: () => [],
      create: async input => ({ ...schedule, title: input.title, runTemplate: input.runTemplate }),
      list: async () => [schedule],
      load: async () => null,
      update: async () => null,
      listRuns: async () => [],
      trigger: async () => { throw new Error("unexpected"); },
      retry: async () => { throw new Error("unexpected"); },
      approve: async () => { throw new Error("unexpected"); },
      deny: async () => { throw new Error("unexpected"); },
      execute: async () => { throw new Error("unexpected"); },
    };
    const app = Fastify();
    registerRequestContext(app, config);
    registerScheduledWorkRoutes(app, deps);
    await app.ready();
    try {
      const badTemplate = await app.inject({
        method: "POST", url: "/scheduled-work-items",
        headers: { "x-los-operator-token": "operator-token", "content-type": "application/json" },
        payload: { projectId: "los", title: "bad-template", templateId: "not_a_template", trigger: { kind: "interval", expression: "6h", timezone: "Asia/Shanghai" } },
      });
      assert.equal(badTemplate.statusCode, 400);
      assert.match(badTemplate.json().error, /invalid templateId/);

      const nested = await app.inject({
        method: "POST", url: "/scheduled-work-items",
        headers: { "x-los-operator-token": "operator-token", "content-type": "application/json" },
        payload: {
          projectId: "los", title: "nested-template",
          runTemplate: { templateId: "scheduled_execution", goalTemplate: "x", editableSurfaces: ["/tmp"], requiredChecks: ["x"] },
          trigger: { kind: "interval", expression: "6h", timezone: "Asia/Shanghai" },
        },
      });
      assert.equal(nested.statusCode, 400);
      assert.match(nested.json().error, /nested runTemplate is not accepted/);

      const ok = await app.inject({
        method: "POST", url: "/scheduled-work-items",
        headers: { "x-los-operator-token": "operator-token", "content-type": "application/json" },
        payload: {
          projectId: "los", title: "flat-executor",
          templateId: "scheduled_execution",
          goalTemplate: "probe",
          editableSurfaces: ["/tmp"], requiredChecks: ["x"],
          maxLoops: 40,
          workspaceRoot: "/opt/los/los-workspace",
          toolMode: "all",
          sandboxMode: "sandbox",
          executor: { enabled: true, nodeId: "node34-executor-1", nodeUrls: ["http://100.68.106.96:8090"] },
          trigger: { kind: "interval", expression: "6h", timezone: "Asia/Shanghai" },
        },
      });
      assert.equal(ok.statusCode, 201, JSON.stringify(ok.json()));
      const created = ok.json().schedule;
      assert.equal(created.runTemplate.maxLoops, 40);
      assert.equal(created.runTemplate.workspaceRoot, "/opt/los/los-workspace");
      assert.equal(created.runTemplate.toolMode, "all");
      assert.equal(created.runTemplate.sandboxMode, "sandbox");
      assert.equal(created.runTemplate.executor.nodeId, "node34-executor-1");
      assert.deepEqual(created.runTemplate.executor.nodeUrls, ["http://100.68.106.96:8090"]);

      const badSandbox = await app.inject({
        method: "POST", url: "/scheduled-work-items",
        headers: { "x-los-operator-token": "operator-token", "content-type": "application/json" },
        payload: {
          projectId: "los", title: "bad-sandbox",
          templateId: "scheduled_execution",
          goalTemplate: "probe",
          editableSurfaces: ["/tmp"], requiredChecks: ["x"],
          sandboxMode: "chroot",
          trigger: { kind: "interval", expression: "6h", timezone: "Asia/Shanghai" },
        },
      });
      assert.equal(badSandbox.statusCode, 400);
      assert.match(badSandbox.json().error, /sandboxMode must be one of/);
    } finally {
      await app.close();
    }
  }, { token: "auth-token", operatorToken: "operator-token" });
});

function fixtureSchedule() {
  return {
    id: "schedule-1", tenantId: "local", projectId: "los", title: "Morning digest", status: "enabled" as const,
    trigger: { kind: "cron" as const, expression: "0 8 * * *", timezone: "Asia/Shanghai" },
    runTemplate: {
      templateId: "morning_inbox_digest" as const, mode: "audit" as const,
      goalTemplate: "Summarize Inbox", editableSurfaces: [], requiredChecks: [], toolMode: "read-only" as const,
    },
    approvalPolicy: "read_only_auto" as const, approvalTimeoutMs: 1_800_000, approvalTimeoutAction: "deny" as const,
    concurrencyPolicy: "skip" as const, catchUpPolicy: "skip" as const,
    maxConcurrentRuns: 1, maxLatenessMs: 3_600_000, maxAttempts: 2, retryBackoffMs: 60_000,
    failureThreshold: 3, nextRunAt: "2026-07-20T00:00:00.000Z", circuitState: "closed" as const,
    consecutiveFailures: 0, consecutiveNoOps: 0, revision: 1, metadata: {},
    createdAt: "2026-07-19T00:00:00.000Z", updatedAt: "2026-07-19T00:00:00.000Z",
  };
}
