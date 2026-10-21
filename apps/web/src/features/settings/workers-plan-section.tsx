import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useEffect, useState } from "react";
import { api, type Schemas, unwrap } from "@/api/client";
import { deploymentSettingsQuery, usageQuery } from "@/api/queries";
import { SectionHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/field";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { LoadingRegion, Skeleton } from "@/components/ui/skeleton";

// The Workers plan of the Cloudflare account (KTD9, U11). The Worker cannot read the
// plan, so the owner sets it here. On Free, welcome emails wait when the day's D1 writes
// pass 70% of the daily limit, so campaigns and unsubscribes keep the rest. On Paid,
// D1 has no daily write limit, and welcome emails do not wait.

type WorkersPlan = Schemas["DeploymentSettings"]["workersPlan"];

const PLANS: { id: WorkersPlan; label: string; hint: string }[] = [
  {
    id: "free",
    label: "Workers Free",
    hint: "100,000 D1 writes per day. Welcome emails wait after 70% of them until 00:00 UTC.",
  },
  {
    id: "paid",
    label: "Workers Paid",
    hint: "No daily D1 write limit. Welcome emails do not wait.",
  },
];

export function WorkersPlanSection() {
  const queryClient = useQueryClient();
  const query = useQuery(deploymentSettingsQuery);
  const [draft, setDraft] = useState<WorkersPlan | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (query.data && draft === null) setDraft(query.data.workersPlan);
  }, [query.data, draft]);

  const save = useMutation({
    mutationFn: (workersPlan: WorkersPlan) =>
      unwrap(api.PATCH("/settings", { body: { workersPlan } })),
    onSuccess: (data) => {
      setSaved(true);
      setDraft(data.workersPlan);
      queryClient.setQueryData(deploymentSettingsQuery.queryKey, data);
      void queryClient.invalidateQueries({ queryKey: usageQuery.queryKey });
    },
  });

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (draft) save.mutate(draft);
  }

  return (
    <section id="workers-plan" aria-labelledby="workers-plan-title" className="flex flex-col gap-4">
      <SectionHeader
        id="workers-plan-title"
        title="Workers plan"
        aside="Applies to every workspace."
      />
      {draft === null ? (
        <LoadingRegion
          label="Loading the Workers plan"
          className="flex flex-col gap-5 rounded-xl border border-border p-5"
        >
          <Skeleton className="h-[100px] max-w-[520px] rounded-lg" />
          <Skeleton className="h-9 w-[120px] rounded-[9px]" />
        </LoadingRegion>
      ) : (
        <form
          className="flex flex-col gap-5 rounded-xl border border-border p-5"
          onSubmit={onSubmit}
        >
          <FormError
            message={
              save.error
                ? save.error instanceof Error
                  ? save.error.message
                  : "Something went wrong. Try again."
                : null
            }
          />
          <fieldset className="m-0 flex max-w-[520px] flex-col gap-2 border-0 p-0">
            <legend className="mb-1 p-0 text-[13px] font-medium">
              Plan of the Cloudflare account
            </legend>
            <p id="workers-plan-hint" className="m-0 mb-2 text-xs text-muted-foreground">
              Envelopen cannot read the plan of the account. Choose the plan that you have in the
              Cloudflare dashboard.
            </p>
            <RadioGroup
              value={draft}
              aria-describedby="workers-plan-hint"
              onValueChange={(value) => {
                setSaved(false);
                save.reset();
                setDraft(value as WorkersPlan);
              }}
            >
              {PLANS.map((plan) => (
                <div
                  key={plan.id}
                  className="flex items-start gap-2.5 rounded-lg border border-border px-3 py-2.5"
                >
                  <RadioGroupItem id={`workers-plan-${plan.id}`} value={plan.id} />
                  <Label
                    htmlFor={`workers-plan-${plan.id}`}
                    className="flex cursor-pointer flex-col"
                  >
                    <span>{plan.label}</span>
                    <span className="text-xs font-normal text-muted-foreground">{plan.hint}</span>
                  </Label>
                </div>
              ))}
            </RadioGroup>
          </fieldset>
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" pending={save.isPending}>
              Save plan
            </Button>
            {saved ? (
              <span role="status" className="motion-enter text-[13px] text-muted-foreground">
                Saved.
              </span>
            ) : null}
          </div>
        </form>
      )}
    </section>
  );
}
