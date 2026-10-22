import { ArrowUpRightIcon, TriangleAlertIcon } from "lucide-react";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Note, type Provider } from "./shared";

// The connect form of a provider with presets (SMTP, U18): Gmail, Google Workspace,
// Brevo, and custom SMTP. A preset fixes the host, the port, and the TLS mode, and
// brings its daily cap, its policy warning (R29), and its notes.

export type Preset = Provider["presets"][number];

const SECURITY_LABEL: Record<string, string> = {
  starttls: "STARTTLS",
  tls: "implicit TLS",
};

/** The credentials and the cap that the form holds, for `POST /connections`. */
export function presetPayload(
  provider: Provider,
  preset: Preset,
  data: FormData,
): { credentials: Record<string, string>; dailyCap: number | null } {
  const credentials: Record<string, string> = { preset: preset.id };
  for (const field of provider.fields) {
    if (field.name === "preset" || preset.fixed[field.name] !== undefined) continue;
    const value = String(data.get(field.name) ?? "").trim();
    if (value) credentials[field.name] = value;
  }
  const cap = String(data.get("dailyCap") ?? "").trim();
  return { credentials, dailyCap: cap ? Number(cap) : null };
}

export function PresetPicker({
  presets,
  value,
  onChange,
}: {
  presets: Preset[];
  value: string;
  onChange: (id: string) => void;
}) {
  return (
    <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
      <legend className="mb-1.5 p-0 text-[13px] font-medium">Service</legend>
      <RadioGroup value={value} onValueChange={onChange} className="grid grid-cols-2 gap-2">
        {presets.map((preset) => (
          <div
            key={preset.id}
            className="flex items-start gap-2.5 rounded-lg border border-border px-3 py-2.5"
          >
            <RadioGroupItem id={`preset-${preset.id}`} value={preset.id} />
            <Label htmlFor={`preset-${preset.id}`} className="flex cursor-pointer flex-col">
              <span>{preset.label}</span>
            </Label>
          </div>
        ))}
      </RadioGroup>
    </fieldset>
  );
}

/** The fields of one preset. Remount it with `key={preset.id}` to reset the values. */
export function PresetFields({ provider, preset }: { provider: Provider; preset: Preset }) {
  const fixedHost = preset.fixed.host;
  return (
    <div className="flex flex-col gap-5" data-testid="preset-fields" data-preset={preset.id}>
      <p className="m-0 text-[13px] text-muted-foreground">
        {preset.description}
        {fixedHost ? (
          <>
            {" "}
            Envelopen connects to <code className="font-mono text-[12px]">{fixedHost}</code> on port{" "}
            {preset.fixed.port} with{" "}
            {SECURITY_LABEL[preset.fixed.security ?? ""] ?? preset.fixed.security}.
          </>
        ) : null}
      </p>
      {preset.policyWarning ? (
        <Note tone="salmon" title={`${preset.label} sending policy`} testId="preset-warning">
          <span className="flex gap-2">
            <TriangleAlertIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <span>
              {preset.policyWarning} Campaigns need you to accept this warning after you connect.
            </span>
          </span>
        </Note>
      ) : null}
      {provider.fields.map((field) => {
        if (field.name === "preset" || preset.fixed[field.name] !== undefined) return null;
        const id = `field-${field.name}`;
        const hint = preset.fieldHints[field.name];
        const label = hint?.label ?? field.label;
        const help = hint?.hint ?? field.hint ?? undefined;
        if (field.name === "security") {
          return (
            <Field key={field.name} id={id} label={label} hint={help}>
              <NativeSelect id={id} name={field.name} defaultValue="starttls">
                <option value="starttls">STARTTLS (port 587)</option>
                <option value="tls">Implicit TLS (port 465)</option>
              </NativeSelect>
            </Field>
          );
        }
        const required = field.required || field.name === "host" || field.name === "port";
        return (
          <Field
            key={field.name}
            id={id}
            label={required ? label : `${label} (optional)`}
            hint={help}
          >
            <Input
              id={id}
              name={field.name}
              type={field.secret ? "password" : "text"}
              required={required}
              inputMode={field.name === "port" ? "numeric" : undefined}
              defaultValue={field.name === "port" ? "587" : undefined}
              placeholder={hint?.placeholder ?? field.placeholder ?? undefined}
              pattern={field.pattern ?? undefined}
              aria-describedby={help ? `${id}-hint` : undefined}
              className={field.secret ? "font-mono text-[12.5px]" : undefined}
              spellCheck={false}
            />
          </Field>
        );
      })}
      <Field
        id="field-dailyCap"
        label={preset.defaultDailyCap ? "Daily sending limit" : "Daily sending limit (optional)"}
        hint={
          <>
            The most messages that Envelopen sends through this connection in 24 hours.
            {preset.capSource ? (
              <>
                {" "}
                <a
                  href={preset.capSource.url}
                  target="_blank"
                  rel="noreferrer"
                  className="underline underline-offset-2"
                >
                  {preset.capSource.label}
                </a>
              </>
            ) : (
              " Leave it empty for no limit."
            )}
          </>
        }
      >
        <Input
          id="field-dailyCap"
          name="dailyCap"
          type="number"
          min={1}
          step={1}
          inputMode="numeric"
          defaultValue={preset.defaultDailyCap ?? undefined}
          required={preset.defaultDailyCap !== null}
          aria-describedby="field-dailyCap-hint"
        />
      </Field>
      {preset.notes.length > 0 ? (
        <Note tone="lavender" testId="preset-notes">
          <ul className="m-0 flex list-disc flex-col gap-1 pl-4">
            {preset.notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        </Note>
      ) : null}
      {preset.links.length > 0 ? (
        <ul className="m-0 flex list-none flex-wrap gap-x-4 gap-y-1 p-0 text-[13px]">
          {preset.links.map((link) => (
            <li key={link.url}>
              <a
                href={link.url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 underline underline-offset-2"
              >
                {link.label}
                <ArrowUpRightIcon className="size-3" aria-hidden="true" />
              </a>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
