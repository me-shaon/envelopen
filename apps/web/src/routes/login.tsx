import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { KeyRoundIcon } from "lucide-react";
import { type FormEvent, useState } from "react";
import { loginModeQuery, sessionQuery } from "@/api/queries";
import { signInWithPasskey, signInWithPassword } from "@/auth/auth-client";
import { AuthLayout } from "@/components/auth-layout";
import { Button } from "@/components/ui/button";
import { Field, FormError } from "@/components/ui/field";
import { Input } from "@/components/ui/input";

const linkClass = "font-medium text-foreground hover:opacity-80";

export function LoginPage({ redirect }: { redirect?: string }) {
  const mode = useQuery(loginModeQuery);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function finish() {
    await queryClient.invalidateQueries({ queryKey: sessionQuery.queryKey });
    const target = redirect?.startsWith("/") && !redirect.startsWith("//") ? redirect : "/";
    await navigate({ to: target });
  }

  async function run(action: () => Promise<void>) {
    setError(null);
    setPending(true);
    try {
      await action();
      await finish();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Sign-in failed. Try again.");
    } finally {
      setPending(false);
    }
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    void run(() => signInWithPassword(String(form.get("email")), String(form.get("password"))));
  }

  return (
    <AuthLayout
      title="Sign in"
      description="Welcome back. Sign in to manage your campaigns."
      footer={
        <>
          <span>
            First time here?{" "}
            <Link to="/setup" className={linkClass}>
              Set up Envelopen
            </Link>
          </span>
          <span>
            Lost access?{" "}
            <Link to="/recover" className={linkClass}>
              Recover with the setup token
            </Link>
          </span>
        </>
      }
    >
      {mode.isPending ? (
        <p className="m-0 text-[13px] text-muted-foreground">Loading</p>
      ) : mode.data === "passkey" ? (
        <div className="flex flex-col gap-4">
          <p className="m-0 text-[13px] text-muted-foreground">
            This deployment signs in with a passkey.
          </p>
          <FormError message={error} />
          <Button disabled={pending} onClick={() => void run(signInWithPasskey)}>
            <KeyRoundIcon className="size-4" aria-hidden="true" />
            Sign in with a passkey
          </Button>
        </div>
      ) : (
        <form className="flex flex-col gap-4" onSubmit={onSubmit} noValidate={false}>
          <FormError message={error} />
          <Field id="email" label="Email">
            <Input id="email" name="email" type="email" autoComplete="username" required />
          </Field>
          <Field id="password" label="Password">
            <Input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
            />
          </Field>
          <Button type="submit" disabled={pending} className="mt-1">
            {pending ? "Signing in" : "Sign in"}
          </Button>
        </form>
      )}
    </AuthLayout>
  );
}
