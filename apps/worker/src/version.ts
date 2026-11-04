// The Envelopen version that this build runs. A release changes it (CHANGELOG.md and
// docs/guides/release-checklist.md). It is not read from package.json, because the Deploy
// button sets the version there to 0.0.0 in each copy. The release workflow, the update
// workflow, and the admin app read this line, so keep its format.
export const ENVELOPEN_VERSION = "0.6.0";
