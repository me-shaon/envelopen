// How audit actions read, for the overview's activity panel and the audit log. An action
// is an operation id, such as "campaigns.create", or a system action, such as
// "campaigns.sent". `label` gets the size of a run of the same action and, for one
// item, the target's name. `notable` actions show in the activity panel. Other actions
// (prepare, test a connection) show only in the audit log.

type Label = (count: number, name: string | undefined) => string;

interface ActionText {
  label: Label;
  notable?: boolean;
}

function quote(name: string | undefined) {
  return name ? `"${name}" ` : "";
}

/** One sentence for one item, and "N things done." for a run. */
function counted(one: string, many: string): Label {
  return (n) => (n > 1 ? `${n} ${many}.` : `${one}.`);
}

function campaign(verb: string): Label {
  return (n, name) => (n > 1 ? `${n} campaigns ${verb}.` : `Campaign ${quote(name)}${verb}.`);
}

const ACTIONS: Record<string, ActionText> = {
  // Setup and workspaces.
  "setup.owner_created": { label: () => "Workspace created.", notable: true },
  "setup.password_reset": { label: () => "Password reset with the setup token." },
  "setup.passkey_recovery_started": { label: () => "Passkey recovery started." },
  "workspaces.create": { label: () => "Workspace created.", notable: true },
  "workspaces.rename": { label: () => "Workspace renamed." },
  "workspaces.archive": { label: () => "Workspace archived.", notable: true },
  "workspaces.update_settings": { label: () => "Workspace settings changed." },
  "api_keys.create": { label: () => "API key created.", notable: true },
  "api_keys.revoke": { label: () => "API key revoked.", notable: true },

  // Providers and domains.
  "connections.create": { label: () => "Email provider connected.", notable: true },
  "connections.delete": { label: () => "Email provider removed.", notable: true },
  "connections.select": { label: () => "Email provider selected." },
  "connections.test": { label: () => "Email provider tested." },
  "connections.accept_policy": { label: () => "Provider sending policy accepted." },
  "connections.setup_events": { label: () => "Provider events set up." },
  "connections.set_webhook_secret": { label: () => "Provider webhook secret saved." },
  "domains.create": { label: () => "Sending domain added.", notable: true },
  "domains.update": { label: () => "Sending domain changed." },
  "domains.check": { label: () => "Sending domain checked." },
  "domains.delete": { label: () => "Sending domain removed.", notable: true },
  "test_addresses.add": { label: () => "Test address added." },
  "test_addresses.remove": { label: () => "Test address removed." },

  // Campaigns. System actions come from the send pipeline.
  "campaigns.send_test": { label: () => "Test email sent.", notable: true },
  "campaigns.create": { label: campaign("created"), notable: true },
  "campaigns.update": { label: campaign("changed") },
  "campaigns.delete": { label: campaign("deleted"), notable: true },
  "campaigns.prepare": { label: campaign("checked before the send") },
  "campaigns.confirm": { label: campaign("confirmed"), notable: true },
  "campaigns.unschedule": { label: campaign("unscheduled"), notable: true },
  "campaigns.pause": { label: campaign("paused"), notable: true },
  "campaigns.resume": { label: campaign("resumed"), notable: true },
  "campaigns.cancel": { label: campaign("canceled"), notable: true },
  "campaigns.retry_batch": { label: () => "Uncertain batch sent again." },
  "campaigns.skip_batch": { label: () => "Uncertain batch skipped." },
  "campaigns.follow_up": { label: () => "Follow-up draft created.", notable: true },
  "campaigns.sent": { label: campaign("sent"), notable: true },
  "campaigns.paused": { label: campaign("paused by Envelopen"), notable: true },
  "campaigns.resumed": { label: campaign("resumed by Envelopen"), notable: true },
  "campaigns.needs_decision": {
    label: (_n, name) => `Campaign ${quote(name)}needs a decision.`,
    notable: true,
  },

  // Contacts and audience.
  "contacts.upsert": {
    label: (n) => (n > 1 ? `${n} contacts added or updated.` : "Contact added or updated."),
    notable: true,
  },
  "contacts.update": { label: counted("Contact changed", "contacts changed"), notable: true },
  "contacts.erase": { label: counted("Contact erased", "contacts erased"), notable: true },
  "contacts.delete": { label: counted("Contact deleted", "contacts deleted"), notable: true },
  "contacts.export": { label: counted("Contact data exported", "contact exports") },
  "contacts.add_tags": { label: counted("Tags added to a contact", "tag changes") },
  "contacts.remove_tag": { label: counted("Tag removed from a contact", "tag changes") },
  "consent.record": { label: counted("Consent recorded", "consent changes") },
  "imports.create": { label: () => "Contact file uploaded." },
  "imports.start": { label: () => "Contact import started.", notable: true },
  "exports.create": { label: () => "Contact export created." },
  "lists.create": { label: counted("List created", "lists created"), notable: true },
  "lists.update": { label: counted("List changed", "lists changed") },
  "lists.delete": { label: counted("List deleted", "lists deleted"), notable: true },
  "lists.add_contacts": { label: counted("Contacts added to a list", "list changes") },
  "lists.remove_contact": { label: counted("Contact removed from a list", "list changes") },
  "tags.create": { label: counted("Tag created", "tags created"), notable: true },
  "tags.rename": { label: counted("Tag renamed", "tags renamed") },
  "tags.delete": { label: counted("Tag deleted", "tags deleted"), notable: true },
  "fields.create": { label: counted("Custom field created", "custom fields created") },
  "fields.update": { label: counted("Custom field renamed", "custom fields renamed") },
  "fields.add_option": { label: counted("Field option added", "field options added") },
  "fields.update_option": { label: counted("Field option renamed", "field options renamed") },
  "fields.reorder_options": { label: counted("Field options reordered", "field changes") },
  "fields.delete_option": {
    label: counted("Field option deleted", "field options deleted"),
    notable: true,
  },
  "suppressions.add": {
    label: counted("Address suppressed", "addresses suppressed"),
    notable: true,
  },
  "suppressions.remove": {
    label: counted("Address removed from the suppression list", "suppressions removed"),
  },

  // Templates.
  "templates.create": {
    label: counted("Template created", "templates created"),
    notable: true,
  },
  "templates.update": { label: counted("Template changed", "templates changed") },
  "templates.duplicate": { label: counted("Template duplicated", "templates duplicated") },
  "templates.delete": { label: counted("Template deleted", "templates deleted"), notable: true },
  "saved_blocks.create": { label: counted("Saved block created", "saved blocks created") },
  "saved_blocks.update": { label: counted("Saved block changed", "saved blocks changed") },
  "saved_blocks.delete": { label: counted("Saved block deleted", "saved blocks deleted") },
};

const RESOURCES: Record<string, string> = {
  api_keys: "API key",
  addresses: "Address",
  test_addresses: "Test address",
};

const VERBS: Record<string, string> = {
  send: "sent",
  set: "set",
  run: "run",
  get: "read",
  list: "listed",
  rename: "renamed",
};

function singular(word: string): string {
  if (/(ss|x|ch|sh)es$/.test(word)) return word.slice(0, -2);
  if (word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
  return word;
}

function pastTense(verb: string): string {
  const known = VERBS[verb];
  if (known) return known;
  if (verb.endsWith("e")) return `${verb}d`;
  if (verb.endsWith("ed")) return verb;
  return `${verb}ed`;
}

/** "campaigns.prepare" reads "Campaign prepared". Used for an action without a label. */
export function humanizeAction(action: string): string {
  const [resource = "", ...rest] = action.split(".");
  const noun = RESOURCES[resource] ?? singular(resource).replaceAll("_", " ");
  const words = rest.join(" ").split("_").filter(Boolean);
  const [verb, ...tail] = words;
  const phrase = [verb ? pastTense(verb) : "", ...tail].filter(Boolean).join(" ");
  const text = `${noun} ${phrase}`.trim();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The activity sentence of a notable action, or undefined for an action to hide. */
export function notableLabel(action: string): Label | undefined {
  const text = ACTIONS[action];
  return text?.notable ? text.label : undefined;
}

/** The sentence of one audit row, without the final period. */
export function actionSentence(action: string, name?: string): string {
  const text = ACTIONS[action];
  if (!text) return humanizeAction(action);
  return text.label(1, name).replace(/\.$/, "");
}

/** The sentence of a run of one action, such as "240 contacts added or updated". */
export function actionRunSentence(action: string, count: number): string {
  const text = ACTIONS[action];
  const many = text?.label(count, undefined).replace(/\.$/, "");
  const one = text?.label(1, undefined).replace(/\.$/, "");
  if (many && many !== one) return many;
  return `${one ?? humanizeAction(action)} (${count.toLocaleString()} times)`;
}
