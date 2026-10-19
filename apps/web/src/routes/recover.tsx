import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { loginModeQuery, sessionQuery } from "@/api/queries";
import {
  AuthRequestError,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  registerPasskey,
  setupRecover,
} from "@/auth/auth-client";
import { AuthLayout } from "@/components/auth-layout";
import { Button } from "@/components/ui/button";
import { Field, FormError } from "@/components/ui/field";
import { Input } from "@/components/ui/input";

// Setup-token recovery (KTD6). Password mode sets a new password. Passkey mode
// registers a new passkey, which replaces the old ones.

export function RecoverPage() {
  const mode = useQuery(loginModeQuery);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [pending, setPending] = useState(false);
  const passkey = mode.data === "passkey";

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const token = String(form.get("token")).trim();
    setError(null);
    setPending(true);
    try {
      const result = await setupRecover(token, passkey ? undefined : String(form.get("password")));
      if (result.passkeyEnrollment) {
        await registerPasskey(result.passkeyEnrollment.token);
        await queryClient.invalidateQueries({ queryKey: sessionQuery.queryKey });
        await navigate({ to: "/" });
      } else {
        setDone(true);
      }
    } catch (cause) {
      if (cause instanceof AuthRequestError && cause.status === 404) {
        setError("Recovery is closed. No owner exists yet, or the SETUP_TOKEN secret is not set.");
      } else {
        setError(cause instanceof Error ? cause.message : "Recovery failed. Try again.");
      }
    } finally {
      setPending(false);
    }
  }

  if (done) {
    return (
      <AuthLayout
        title="Password changed"
        description="Every session ended. Sign in with the new password."
      >
        <Button asChild>
          <Link to="/login">Go to sign in</Link>
        </Button>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title="Recover access"
      description={
        passkey
          ? "Enter the SETUP_TOKEN secret. A new passkey replaces your old passkeys."
          : "Enter the SETUP_TOKEN secret and choose a new password."
      }
      footer={
        <Link to="/login" className="font-medium text-foreground">
          Back to sign in
        </Link>
      }
    >
      <form className="flex flex-col gap-4" onSubmit={(event) => void onSubmit(event)}>
        <FormError message={error} />
        <Field id="recover-token" label="Setup token">
          <Input
            id="recover-token"
            name="token"
            type="password"
            autoComplete="off"
            required
            className="font-mono"
          />
        </Field>
        {passkey ? null : (
          <Field
            id="recover-password"
            label="New password"
            hint={`Use ${PASSWORD_MIN_LENGTH} or more characters.`}
          >
            <Input
              id="recover-password"
              name="password"
              type="password"
              autoComplete="new-password"
              required
              minLength={PASSWORD_MIN_LENGTH}
              maxLength={PASSWORD_MAX_LENGTH}
              aria-describedby="recover-password-hint"
            />
          </Field>
        )}
        <Button type="submit" disabled={pending || mode.isPending}>
          {pending ? "Working" : passkey ? "Add a new passkey" : "Set the new password"}
        </Button>
      </form>
    </AuthLayout>
  );
}
