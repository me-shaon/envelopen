import { describe, expect, it } from "vitest";
import { campaignInstanceId, campaignStarter, MAX_SNAPSHOT_RETRIES } from "./services";

// A fake Workflow binding: a map of instance id to status. `create` refuses an id that
// exists, as the real binding does.
function fakeWorkflow(initial: Record<string, string> = {}) {
  const instances = new Map(Object.entries(initial));
  const created: string[] = [];
  const binding = {
    async create({ id }: { id: string }) {
      if (instances.has(id)) throw new Error(`instance ${id} exists`);
      instances.set(id, "queued");
      created.push(id);
      return { id };
    },
    async get(id: string) {
      const status = instances.get(id);
      if (!status) throw new Error(`instance ${id} not found`);
      return { status: async () => ({ status }) };
    },
  };
  return { binding, instances, created };
}

const JOB = { workspaceId: 1, campaignId: 2, startedAt: 1000 };
const BASE = campaignInstanceId(JOB);

function starter(binding: ReturnType<typeof fakeWorkflow>["binding"]) {
  return campaignStarter({ CAMPAIGN_WORKFLOW: binding } as unknown as Pick<
    Env,
    "CAMPAIGN_WORKFLOW"
  >);
}

describe("campaignStarter", () => {
  it("starts the first instance", async () => {
    const wf = fakeWorkflow();
    await starter(wf.binding)(JOB);
    expect(wf.created).toEqual([BASE]);
  });

  it("starts nothing while an instance runs", async () => {
    const wf = fakeWorkflow({ [BASE]: "running" });
    await starter(wf.binding)(JOB);
    expect(wf.created).toEqual([]);
  });

  it("starts one successor for a failed instance, and no more on later calls", async () => {
    const wf = fakeWorkflow({ [BASE]: "errored" });
    const start = starter(wf.binding);
    await start(JOB);
    await start(JOB);
    await start(JOB);
    expect(wf.created).toEqual([`${BASE}-r1`]);
  });

  it("walks past failed successors to the next free id", async () => {
    const wf = fakeWorkflow({ [BASE]: "errored", [`${BASE}-r1`]: "terminated" });
    await starter(wf.binding)(JOB);
    expect(wf.created).toEqual([`${BASE}-r2`]);
  });

  it("stops after the last allowed retry", async () => {
    const failed: Record<string, string> = { [BASE]: "errored" };
    for (let n = 1; n <= MAX_SNAPSHOT_RETRIES; n++) failed[`${BASE}-r${n}`] = "errored";
    const wf = fakeWorkflow(failed);
    await starter(wf.binding)(JOB);
    expect(wf.created).toEqual([]);
  });
});
