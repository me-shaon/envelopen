import { useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { CheckIcon, XIcon } from "lucide-react";
import { type FormEvent, useState } from "react";
import { sessionQuery } from "@/api/queries";
import { setWorkspaceId } from "@/api/workspace";
import {
  AuthRequestError,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  registerPasskey,
  type SetupCheckResult,
  setupCheck,
  setupOwner,
  signInWithPassword,
} from "@/auth/auth-client";
import { AuthLayout } from "@/components/auth-layout";
import { Button } from "@/components/ui/button";
import { Field, FormError } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Pill } from "@/components/ui/pill";
import { guideUrl } from "@/lib/guides";

// First-run setup (KTD6): the setup token, then the binding and migration checks with
// a fix hint for each failure, then the plan limits, then the owner form.

type Step = "token" | "review" | "owner" | "closed";

function messageOf(error: unknown): string {
  if (error instanceof AuthRequestError) {
    if (error.code === "invalid_input" && Array.isArray(error.details)) {
      const first = error.details[0] as { path?: string[]; message?: string } | undefined;
      if (first?.path?.length)
        return `Check the ${first.path.join(".")} field. ${first.message ?? ""}`;
    }
    return error.message;
  }
  return "Something went wrong. Try again.";
}

function ChecksList({ result }: { result: SetupCheckResult }) {
  return (
    <section aria-labelledby="checks-title" className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between gap-3">
        <h2 id="checks-title" className="m-0 text-[15px] font-semibold tracking-[-0.01em]">
          Deployment checks
        </h2>
        <span className="text-[13px] text-muted-foreground">
          <span className="figure">{result.checks.filter((check) => check.ok).length}</span> of{" "}
          <span className="figure">{result.checks.length}</span> pass
        </span>
      </div>
      <ul className="m-0 flex list-none flex-col rounded-xl border border-border px-4 py-1">
        {result.checks.map((check) => (
          <li
            key={check.id}
            className="flex flex-col gap-1 border-b border-hairline py-2.5 last:border-b-0"
          >
            <div className="flex items-center justify-between gap-3">
              <span className="text-[13px]">{check.label}</span>
              {check.ok ? (
                <Pill tone="teal">
                  <CheckIcon className="size-3" aria-hidden="true" />
                  Pass
                </Pill>
              ) : (
                <Pill tone="danger">
                  <XIcon className="size-3" aria-hidden="true" />
                  Fix needed
                </Pill>
              )}
            </div>
            {check.hint ? <p className="m-0 text-xs text-muted-foreground">{check.hint}</p> : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

function LimitsTable({ result }: { result: SetupCheckResult }) {
  return (
    <section aria-labelledby="limits-title" className="flex flex-col gap-3">
      <div className="flex flex-col gap-0.5">
        <h2 id="limits-title" className="m-0 text-[15px] font-semibold tracking-[-0.01em]">
          Cloudflare plan limits
        </h2>
        <p className="m-0 text-[13px] text-muted-foreground">
          The Worker cannot read your plan, so both columns show. Read the{" "}
          <a
            href={guideUrl(result.guides.platform)}
            target="_blank"
            rel="noreferrer"
            className="font-medium text-foreground"
          >
            platform guide
          </a>{" "}
          and the{" "}
          <a
            href={guideUrl(result.guides.database)}
            target="_blank"
            rel="noreferrer"
            className="font-medium text-foreground"
          >
            database guide
          </a>
          .
        </p>
      </div>
      <div className="overflow-x-auto rounded-xl border border-border">
        <table className="w-full border-collapse text-[13px]">
          <thead>
            <tr className="text-left text-xs text-muted-foreground">
              <th scope="col" className="px-4 py-2.5 font-medium">
                Limit
              </th>
              <th scope="col" className="px-4 py-2.5 font-medium">
                Free
              </th>
              <th scope="col" className="px-4 py-2.5 font-medium">
                Paid
              </th>
            </tr>
          </thead>
          <tbody>
            {result.limits.map((limit) => (
              <tr key={limit.id} className="border-t border-hairline">
                <th scope="row" className="px-4 py-2.5 text-left font-normal">
                  {limit.label}
                </th>
                <td className="px-4 py-2.5 font-mono text-[12.5px]">{limit.free}</td>
                <td className="px-4 py-2.5 font-mono text-[12.5px]">{limit.paid}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function SetupPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [step, setStep] = useState<Step>("token");
  const [token, setToken] = useState("");
  const [result, setResult] = useState<SetupCheckResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function runCheck(value: string) {
    setError(null);
    setPending(true);
    try {
      const checked = await setupCheck(value);
      setResult(checked);
      setStep("review");
    } catch (cause) {
      if (cause instanceof AuthRequestError && cause.status === 404) setStep("closed");
      else setError(messageOf(cause));
    } finally {
      setPending(false);
    }
  }

  function onToken(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void runCheck(token.trim());
  }

  async function onOwner(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!result) return;
    const form = new FormData(event.currentTarget);
    const email = String(form.get("email")).trim();
    const password =
      result.auth.loginMode === "password" ? String(form.get("password")) : undefined;
    setError(null);
    setPending(true);
    try {
      const created = await setupOwner({
        token: token.trim(),
        email,
        name: String(form.get("name")),
        workspaceName: String(form.get("workspaceName")),
        ...(password === undefined ? {} : { password }),
      });
      setWorkspaceId(created.workspaceId);
      if (created.passkeyEnrollment) {
        await registerPasskey(created.passkeyEnrollment.token);
      } else if (password !== undefined) {
        await signInWithPassword(email, password);
      }
      await queryClient.invalidateQueries({ queryKey: sessionQuery.queryKey });
      await navigate({ to: "/" });
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setPending(false);
    }
  }

  if (step === "closed") {
    return (
      <AuthLayout
        title="Setup is closed"
        description="The owner already exists, or the SETUP_TOKEN secret is not set. It needs at least 32 characters."
      >
        <Button asChild>
          <Link to="/login">Go to sign in</Link>
        </Button>
      </AuthLayout>
    );
  }

  if (step === "token" || !result) {
    return (
      <AuthLayout
        title="Set up Envelopen"
        description="Enter the SETUP_TOKEN secret that you set at deploy time."
        footer={
          <span>
            Already set up?{" "}
            <Link to="/login" className="font-medium text-foreground">
              Sign in
            </Link>
          </span>
        }
      >
        <form className="flex flex-col gap-4" onSubmit={onToken}>
          <FormError message={error} />
          <Field
            id="token"
            label="Setup token"
            hint="The SETUP_TOKEN secret that you set when you deployed Envelopen."
          >
            <Input
              id="token"
              name="token"
              aria-describedby="token-hint"
              type="password"
              autoComplete="off"
              required
              value={token}
              onChange={(event) => setToken(event.target.value)}
              className="font-mono"
            />
          </Field>
          <Button type="submit" disabled={pending || token.trim().length === 0}>
            {pending ? "Checking" : "Check the deployment"}
          </Button>
        </form>
      </AuthLayout>
    );
  }

  if (step === "review") {
    return (
      <AuthLayout
        wide
        title="Check the deployment"
        description={
          result.ready
            ? "Every check passes. Read the limits, then create the owner."
            : "Fix the failed checks, deploy again, and check again."
        }
      >
        <ChecksList result={result} />
        <LimitsTable result={result} />
        <FormError message={error} />
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="outline" disabled={pending} onClick={() => void runCheck(token.trim())}>
            Check again
          </Button>
          <Button disabled={!result.ready} onClick={() => setStep("owner")}>
            Continue
          </Button>
        </div>
      </AuthLayout>
    );
  }

  const passkey = result.auth.loginMode === "passkey";
  return (
    <AuthLayout
      title="Create the owner"
      description={
        passkey
          ? "This deployment signs in with a passkey. Your browser asks for one next."
          : "You sign in with this email and password."
      }
    >
      <form className="flex flex-col gap-4" onSubmit={(event) => void onOwner(event)}>
        <FormError message={error} />
        <Field id="name" label="Your name">
          <Input id="name" name="name" autoComplete="name" required maxLength={100} />
        </Field>
        <Field id="owner-email" label="Email">
          <Input id="owner-email" name="email" type="email" autoComplete="username" required />
        </Field>
        {passkey ? null : (
          <Field
            id="owner-password"
            label="Password"
            hint={`Use ${PASSWORD_MIN_LENGTH} or more characters.`}
          >
            <Input
              id="owner-password"
              name="password"
              type="password"
              autoComplete="new-password"
              required
              minLength={PASSWORD_MIN_LENGTH}
              maxLength={PASSWORD_MAX_LENGTH}
              aria-describedby="owner-password-hint"
            />
          </Field>
        )}
        <Field id="workspace-name" label="First workspace" hint="For example, your company name.">
          <Input
            id="workspace-name"
            name="workspaceName"
            required
            maxLength={100}
            aria-describedby="workspace-name-hint"
          />
        </Field>
        <div className="mt-1 flex flex-wrap justify-end gap-2">
          <Button type="button" variant="outline" onClick={() => setStep("review")}>
            Back
          </Button>
          <Button type="submit" disabled={pending}>
            {pending ? "Creating" : passkey ? "Create and add a passkey" : "Create the owner"}
          </Button>
        </div>
      </form>
    </AuthLayout>
  );
}
